import { createHash } from "crypto";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { RuntimeConfig } from "@/common/types/runtime";
import { withLegacyMuxEnvironmentAliases } from "@/common/compat/legacyMux";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { getRuntimeType } from "./initHook";
import type { Runtime } from "./Runtime";
import { shescape } from "./streamUtils";
import { expandTildeForSSH } from "./tildeExpansion";
import { getWorkspaceScratchDir } from "./workspaceScratchDir";

/**
 * Where a workspace's $XUM_SCRATCH_DIR lives, per runtime.
 *
 * - local/worktree: the host session dir (`~/.xum/sessions/<id>/scratch`, workspaceScratchDir.ts).
 * - SSH and Coder: on the remote host, `<runtime.getXumHome()>/workspace-scratch/<id>`. Not
 *   `<home>/scratch/<id>`: on the host that dir is the scratch-chat workdir root, which startup
 *   sweeps as orphans, and SSH to the same machine (where ~/.mux can be the host's Xum home)
 *   would have its scratch deleted on the next restart.
 * - Docker: `/var/mux/scratch` in the container, which lives exactly as long as the workspace.
 * - devcontainer: the host session scratch dir, bind-mounted at the SAME path, but only when the
 *   container daemon can see host paths (see canBindMountHostPathsIntoContainers). The same path
 *   on both sides means the Artifacts tab reads it from the host filesystem.
 */
export type ScratchDirSpec =
  | { kind: "host"; dir: string }
  | { kind: "devcontainer-mount"; dir: string }
  /** `path` is in the runtime's namespace and may be home-relative (`~/...`) on SSH. */
  | { kind: "runtime"; path: string }
  | { kind: "none" };

export const RUNTIME_SCRATCH_DIR_NAME = "workspace-scratch";
export const DOCKER_SCRATCH_DIR = "/var/mux/scratch";

const SCRATCH_EXEC_TIMEOUT_SECONDS = 10;

export function getRuntimeScratchPath(xumHome: string, workspaceId: string): string {
  assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
  assert(!workspaceId.includes("/") && workspaceId !== ".." && workspaceId !== ".", "bad id");
  return path.posix.join(xumHome, RUNTIME_SCRATCH_DIR_NAME, workspaceId);
}

export async function resolveScratchDirSpec(params: {
  runtimeConfig: RuntimeConfig | undefined;
  workspaceId: string;
  sessionsDir: string;
  runtime: Pick<Runtime, "getXumHome">;
  /** Multi-project workspaces on remote runtimes span several hosts/containers: none. */
  multiProject?: boolean;
  /** Override for tests; production reads the Docker client config. */
  canBindMountHostPaths?: () => Promise<boolean>;
}): Promise<ScratchDirSpec> {
  const runtimeType = getRuntimeType(params.runtimeConfig);
  if (runtimeType === "local" || runtimeType === "worktree") {
    return { kind: "host", dir: getWorkspaceScratchDir(params.sessionsDir, params.workspaceId) };
  }
  if (params.multiProject === true) return { kind: "none" };
  switch (runtimeType) {
    case "ssh":
      return {
        kind: "runtime",
        path: getRuntimeScratchPath(params.runtime.getXumHome(), params.workspaceId),
      };
    case "docker":
      return { kind: "runtime", path: DOCKER_SCRATCH_DIR };
    case "devcontainer": {
      const canMount =
        params.canBindMountHostPaths ?? (() => canBindMountHostPathsIntoContainers());
      return (await canMount())
        ? {
            kind: "devcontainer-mount",
            dir: getWorkspaceScratchDir(params.sessionsDir, params.workspaceId),
          }
        : { kind: "none" };
    }
    default:
      return { kind: "none" };
  }
}

function isLocalDockerEndpoint(host: string): boolean {
  return /^(unix|npipe):\/\//i.test(host.trim());
}

/**
 * True when the Docker daemon the devcontainer CLI talks to runs on this machine, so a bind
 * mount of a host path shows that host path (Docker Desktop shares the user's home into its VM).
 *
 * Detection mirrors the docker CLI's own endpoint resolution, without spawning it:
 * DOCKER_HOST wins; otherwise DOCKER_CONTEXT, else `currentContext` in the client config
 * ($DOCKER_CONFIG or ~/.docker/config.json); a non-default context's endpoint is read from
 * `contexts/meta/<sha256(name)>/meta.json`. Local means a unix:// or npipe:// endpoint; tcp://
 * and ssh:// daemons see their own filesystem, where the bind source does not exist and
 * `devcontainer up` would fail. Anything unreadable counts as remote (scratch stays unavailable
 * rather than breaking the container). Windows hosts are excluded because the mount target
 * reuses the host path, and a `C:\...` path is not a valid Linux container path.
 */
export async function canBindMountHostPathsIntoContainers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): Promise<boolean> {
  if (platform === "win32") return false;
  const dockerHost = env.DOCKER_HOST?.trim();
  if (dockerHost) return isLocalDockerEndpoint(dockerHost);

  const configDir = env.DOCKER_CONFIG?.trim() ? env.DOCKER_CONFIG : path.join(homeDir, ".docker");
  try {
    let contextName = env.DOCKER_CONTEXT?.trim();
    if (!contextName) {
      let configText: string;
      try {
        configText = await fsPromises.readFile(path.join(configDir, "config.json"), "utf8");
      } catch (error) {
        // No client config: the CLI uses its default local socket.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      const parsed = JSON.parse(configText) as { currentContext?: unknown };
      contextName = typeof parsed.currentContext === "string" ? parsed.currentContext : "";
    }
    if (!contextName || contextName === "default") return true;
    const metaPath = path.join(
      configDir,
      "contexts",
      "meta",
      createHash("sha256").update(contextName).digest("hex"),
      "meta.json"
    );
    const meta = JSON.parse(await fsPromises.readFile(metaPath, "utf8")) as {
      Endpoints?: { docker?: { Host?: unknown } };
    };
    const host = meta.Endpoints?.docker?.Host;
    return typeof host === "string" && isLocalDockerEndpoint(host);
  } catch (error) {
    log.debug("Could not resolve the Docker endpoint; treating it as remote", {
      error: getErrorMessage(error),
    });
    return false;
  }
}

/**
 * Create the workspace's scratch dir where its commands run and return the absolute path to
 * export as XUM_SCRATCH_DIR, or undefined when this runtime has none (the variable stays unset).
 *
 * Host dirs are returned even when mkdir fails (see ensureWorkspaceScratchDir). Remote dirs are
 * returned only once the runtime confirmed them: an exported path the agent cannot write to is
 * worse than none.
 */
export async function ensureScratchDirForSpec(
  runtime: Runtime,
  spec: ScratchDirSpec,
  abortSignal?: AbortSignal
): Promise<string | undefined> {
  switch (spec.kind) {
    case "none":
      return undefined;
    case "host":
      await mkdirHostBestEffort(spec.dir);
      return spec.dir;
    case "devcontainer-mount": {
      await mkdirHostBestEffort(spec.dir);
      // The mount exists only in containers created after this feature (and only when Xum knew
      // the workspace id at `devcontainer up`); an existing container keeps its mounts. Export
      // only when the container really sees the host dir.
      try {
        const result = await execBuffered(runtime, `test -d ${shescape.quote(spec.dir)}`, {
          cwd: "/",
          timeout: SCRATCH_EXEC_TIMEOUT_SECONDS,
          abortSignal,
          maxOutputBytes: 4096,
        });
        return result.exitCode === 0 ? spec.dir : undefined;
      } catch (error) {
        log.debug("Could not probe the devcontainer scratch mount", {
          error: getErrorMessage(error),
        });
        return undefined;
      }
    }
    case "runtime": {
      try {
        // pathEnv expands a home-relative path on the runtime; printf reports the result.
        const result = await execBuffered(
          runtime,
          // umask 077: the dir holds logs and PR drafts, so on a shared host new dirs are
          // owner-only (existing dirs keep their mode).
          'umask 077 && mkdir -p -- "$XUM_SCRATCH" && printf "%s" "$XUM_SCRATCH"',
          {
            cwd: "/",
            pathEnv: { XUM_SCRATCH: spec.path },
            timeout: SCRATCH_EXEC_TIMEOUT_SECONDS,
            abortSignal,
            maxOutputBytes: 64 * 1024,
          }
        );
        // Login shells can print banners before the command's own output: take the last line.
        const resolved = result.stdout.split("\n").pop() ?? "";
        if (result.exitCode !== 0 || !resolved.startsWith("/")) {
          log.warn(
            `Could not create the runtime scratch dir ${spec.path} (exit ${result.exitCode}): ${result.stderr.trim()}`
          );
          return undefined;
        }
        return resolved;
      } catch (error) {
        log.warn(
          `Could not create the runtime scratch dir ${spec.path}: ${getErrorMessage(error)}`
        );
        return undefined;
      }
    }
  }
}

async function mkdirHostBestEffort(dir: string): Promise<void> {
  try {
    await fsPromises.mkdir(dir, { recursive: true });
  } catch (error) {
    log.warn(`Could not create workspace scratch dir ${dir}: ${getErrorMessage(error)}`);
  }
}

/**
 * Delete an SSH workspace's runtime scratch dir (workspace removal). Returns false when the
 * runtime could not delete it; callers log and move on, removal never waits on this.
 */
export async function removeRuntimeScratchDir(
  runtime: Runtime,
  workspaceId: string
): Promise<boolean> {
  const scratchPath = getRuntimeScratchPath(runtime.getXumHome(), workspaceId);
  assert(
    scratchPath.startsWith("/") || scratchPath.startsWith("~/"),
    `runtime scratch path must be absolute or home-relative: ${scratchPath}`
  );
  try {
    const result = await execBuffered(runtime, 'rm -rf -- "$XUM_SCRATCH"', {
      cwd: "/",
      pathEnv: { XUM_SCRATCH: scratchPath },
      timeout: SCRATCH_EXEC_TIMEOUT_SECONDS,
      maxOutputBytes: 4096,
    });
    return result.exitCode === 0;
  } catch (error) {
    log.debug("Could not delete the runtime scratch dir", {
      workspaceId,
      error: getErrorMessage(error),
    });
    return false;
  }
}

/**
 * Whether a runtime's $XUM_SCRATCH_DIR value is a path on THIS host (local, worktree, and the
 * devcontainer same-path mount), keyed by the exported XUM_RUNTIME value. SSH and Docker
 * scratch paths name the remote host's or container's filesystem.
 */
export function isScratchDirOnHost(runtimeMode: string | undefined): boolean {
  return runtimeMode === "local" || runtimeMode === "worktree" || runtimeMode === "devcontainer";
}

/**
 * POSIX shell prefix that creates and exports XUM_SCRATCH_DIR inside an interactive remote shell
 * (integrated terminal), so opening a terminal costs no extra exec round trip and an
 * unreachable runtime fails in the PTY as before. Ends with "; " so callers can append the
 * shell's own command. Undefined where the host passes the variable as process env (host) or
 * there is none.
 */
export function buildScratchShellPrelude(spec: ScratchDirSpec): string | undefined {
  switch (spec.kind) {
    case "host":
    case "none":
      return undefined;
    case "runtime": {
      // expandTildeForSSH double-quotes the path and turns ~/ into "$HOME/...", so the exported
      // value is absolute, matching what turns export. Exported only once mkdir succeeded, like
      // turns (ensureScratchDirForSpec): a path the shell cannot write to is worse than none.
      const quoted = expandTildeForSSH(spec.path);
      // The subshell keeps umask 077 to the mkdir: the interactive shell keeps its own umask.
      return `(umask 077; mkdir -p -- ${quoted}) 2>/dev/null && ${exportScratchDir(quoted)}; `;
    }
    case "devcontainer-mount": {
      // Same rule as ensureScratchDirForSpec: export only when the container sees the mount.
      const quoted = shescape.quote(spec.dir);
      return `if [ -d ${quoted} ]; then ${exportScratchDir(quoted)}; fi; `;
    }
  }
}

/**
 * The scratch var plus its legacy MUX_* alias, as agent tool env gets them (initHook.ts), so
 * downgrade-era scripts in a remote terminal see the same dir. Names come from the alias helper.
 */
const SCRATCH_DIR_ENV_NAMES = Object.keys(withLegacyMuxEnvironmentAliases({ XUM_SCRATCH_DIR: "" }));

function exportScratchDir(quotedValue: string): string {
  return `export ${SCRATCH_DIR_ENV_NAMES.map((name) => `${name}=${quotedValue}`).join(" ")}`;
}
