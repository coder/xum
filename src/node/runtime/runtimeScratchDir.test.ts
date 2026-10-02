import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { RuntimeConfig } from "@/common/types/runtime";
import { LocalRuntime } from "./LocalRuntime";
import {
  buildScratchShellPrelude,
  DOCKER_SCRATCH_DIR,
  RUNTIME_SCRATCH_DIR_NAME,
  canBindMountHostPathsIntoContainers,
  ensureScratchDirForSpec,
  removeRuntimeScratchDir,
  resolveScratchDirSpec,
} from "./runtimeScratchDir";
import { cdThenExecShell, runInPosixShell, shescape } from "./streamUtils";
import { expandTildeForSSH } from "./tildeExpansion";
import { getWorkspaceScratchDir } from "./workspaceScratchDir";

/** A local runtime whose Xum home is a temp dir, standing in for an SSH host. */
class FakeRemoteHomeRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly xumHome: string
  ) {
    super(projectPath);
  }

  override getXumHome(): string {
    return this.xumHome;
  }
}

describe("runtimeScratchDir", () => {
  let tempDir: string;
  const sessionsDir = "/xum/sessions";

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runtime-scratch-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveScratchDirSpec", () => {
    const remoteHome = { getXumHome: () => "~/.mux" };
    const spec = (
      runtimeConfig: RuntimeConfig,
      extra?: { multiProject?: boolean; canMount?: boolean }
    ) =>
      resolveScratchDirSpec({
        runtimeConfig,
        workspaceId: "ws1",
        sessionsDir,
        runtime: remoteHome,
        multiProject: extra?.multiProject,
        canBindMountHostPaths: () => Promise.resolve(extra?.canMount ?? true),
      });

    test("puts the scratch dir where each runtime's commands run", async () => {
      const hostDir = getWorkspaceScratchDir(sessionsDir, "ws1");
      expect(await spec({ type: "local" })).toEqual({ kind: "host", dir: hostDir });
      expect(await spec({ type: "worktree", srcBaseDir: "/src" })).toEqual({
        kind: "host",
        dir: hostDir,
      });
      expect(await spec({ type: "ssh", host: "box", srcBaseDir: "~/src" })).toEqual({
        kind: "runtime",
        path: `~/.mux/${RUNTIME_SCRATCH_DIR_NAME}/ws1`,
      });
      expect(
        await spec({
          type: "ssh",
          host: "box",
          srcBaseDir: "~/src",
          coder: { workspaceName: "cw", existingWorkspace: true },
        } as RuntimeConfig)
      ).toEqual({ kind: "runtime", path: `~/.mux/${RUNTIME_SCRATCH_DIR_NAME}/ws1` });
      expect(await spec({ type: "docker", image: "img" })).toEqual({
        kind: "runtime",
        path: DOCKER_SCRATCH_DIR,
      });
      expect(await spec({ type: "devcontainer", configPath: ".devcontainer.json" })).toEqual({
        kind: "devcontainer-mount",
        dir: hostDir,
      });
    });

    test("has none for devcontainers without a local daemon and for remote multi-project", async () => {
      expect(
        await spec({ type: "devcontainer", configPath: ".devcontainer.json" }, { canMount: false })
      ).toEqual({ kind: "none" });
      expect(
        await spec({ type: "ssh", host: "box", srcBaseDir: "~/src" }, { multiProject: true })
      ).toEqual({ kind: "none" });
      // Local multi-project workspaces keep their host scratch dir.
      expect((await spec({ type: "local" }, { multiProject: true })).kind).toBe("host");
    });
  });

  describe("canBindMountHostPathsIntoContainers", () => {
    async function writeContext(configDir: string, name: string, host: string) {
      const metaDir = path.join(
        configDir,
        "contexts",
        "meta",
        createHash("sha256").update(name).digest("hex")
      );
      await fs.mkdir(metaDir, { recursive: true });
      await fs.writeFile(
        path.join(metaDir, "meta.json"),
        JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } })
      );
    }

    test("follows DOCKER_HOST first", async () => {
      expect(
        await canBindMountHostPathsIntoContainers(
          { DOCKER_HOST: "tcp://10.0.0.1:2375" },
          "linux",
          tempDir
        )
      ).toBe(false);
      expect(
        await canBindMountHostPathsIntoContainers({ DOCKER_HOST: "ssh://me@box" }, "linux", tempDir)
      ).toBe(false);
      expect(
        await canBindMountHostPathsIntoContainers(
          { DOCKER_HOST: "unix:///var/run/docker.sock" },
          "linux",
          tempDir
        )
      ).toBe(true);
    });

    test("uses the default local socket without a config or context", async () => {
      expect(await canBindMountHostPathsIntoContainers({}, "linux", tempDir)).toBe(true);
      expect(await canBindMountHostPathsIntoContainers({}, "darwin", tempDir)).toBe(true);
    });

    test("never mounts on Windows hosts", async () => {
      expect(await canBindMountHostPathsIntoContainers({}, "win32", tempDir)).toBe(false);
    });

    test("resolves the current context's endpoint from the client config", async () => {
      const configDir = path.join(tempDir, ".docker");
      await writeContext(configDir, "desktop-linux", "unix:///Users/me/.docker/run/docker.sock");
      await writeContext(configDir, "remote", "tcp://build-box:2376");
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ currentContext: "desktop-linux" })
      );

      expect(await canBindMountHostPathsIntoContainers({}, "darwin", tempDir)).toBe(true);
      expect(
        await canBindMountHostPathsIntoContainers({ DOCKER_CONTEXT: "remote" }, "darwin", tempDir)
      ).toBe(false);
      expect(
        await canBindMountHostPathsIntoContainers(
          { DOCKER_CONFIG: configDir, DOCKER_CONTEXT: "default" },
          "linux",
          "/nonexistent"
        )
      ).toBe(true);
      // An unknown context (no meta) cannot be proven local.
      expect(
        await canBindMountHostPathsIntoContainers({ DOCKER_CONTEXT: "gone" }, "linux", tempDir)
      ).toBe(false);
    });
  });

  describe("ensureScratchDirForSpec", () => {
    test("creates a runtime-side dir and returns the path the runtime expanded", async () => {
      const runtime = new LocalRuntime(tempDir);
      const scratch = path.join(tempDir, "remote-home", RUNTIME_SCRATCH_DIR_NAME, "ws1");

      expect(await ensureScratchDirForSpec(runtime, { kind: "runtime", path: scratch })).toBe(
        scratch
      );
      expect((await fs.stat(scratch)).isDirectory()).toBe(true);
    });

    test("creates the dir owner-only, whatever the runtime's umask", async () => {
      // Runs every command under umask 022, like a typical SSH login.
      class Umask022Runtime extends LocalRuntime {
        override exec(command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
          return super.exec(`umask 022; ${command}`, options);
        }
      }
      const scratch = path.join(tempDir, "remote-home", RUNTIME_SCRATCH_DIR_NAME, "ws-mode");
      expect(
        await ensureScratchDirForSpec(new Umask022Runtime(tempDir), {
          kind: "runtime",
          path: scratch,
        })
      ).toBe(scratch);
      expect((await fs.stat(scratch)).mode & 0o777).toBe(0o700);
    });

    test("leaves XUM_SCRATCH_DIR unset when the runtime cannot create the dir", async () => {
      const runtime = new LocalRuntime(tempDir);
      await fs.writeFile(path.join(tempDir, "file"), "not a dir");

      expect(
        await ensureScratchDirForSpec(runtime, {
          kind: "runtime",
          path: path.join(tempDir, "file", "scratch"),
        })
      ).toBeUndefined();
      expect(await ensureScratchDirForSpec(runtime, { kind: "none" })).toBeUndefined();
    });

    test("exports a devcontainer mount only when the container sees the host dir", async () => {
      const hostDir = path.join(tempDir, "sessions", "ws1", "scratch");
      // A LocalRuntime "container" sees every host path, so the probe passes once the dir exists.
      const seesHost = new LocalRuntime(tempDir);
      expect(
        await ensureScratchDirForSpec(seesHost, { kind: "devcontainer-mount", dir: hostDir })
      ).toBe(hostDir);

      // A container without the mount: the probe fails, so nothing is exported.
      class NoMountRuntime extends LocalRuntime {
        override exec(command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
          return super.exec(command.replace(hostDir, "/nonexistent-mount"), options);
        }
      }
      expect(
        await ensureScratchDirForSpec(new NoMountRuntime(tempDir), {
          kind: "devcontainer-mount",
          dir: hostDir,
        })
      ).toBeUndefined();
    });
  });

  test("the terminal shell prelude creates and exports the same dir turns export", async () => {
    const home = path.join(tempDir, "home");
    await fs.mkdir(home);
    const runPrelude = (prelude: string | undefined) =>
      execFileSync("bash", ["-c", `${prelude ?? ""}printf '%s' "$XUM_SCRATCH_DIR"`], {
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
      });

    const sshDir = runPrelude(
      buildScratchShellPrelude({ kind: "runtime", path: `~/.mux/${RUNTIME_SCRATCH_DIR_NAME}/ws 1` })
    );
    expect(sshDir).toBe(path.join(home, ".mux", RUNTIME_SCRATCH_DIR_NAME, "ws 1"));
    expect((await fs.stat(sshDir)).isDirectory()).toBe(true);

    const mounted = path.join(tempDir, "mounted");
    const devcontainer = buildScratchShellPrelude({ kind: "devcontainer-mount", dir: mounted });
    expect(runPrelude(devcontainer)).toBe("");
    await fs.mkdir(mounted);
    expect(runPrelude(devcontainer)).toBe(mounted);

    expect(buildScratchShellPrelude({ kind: "host", dir: mounted })).toBeUndefined();
    expect(buildScratchShellPrelude({ kind: "none" })).toBeUndefined();
  });

  test("the terminal prelude creates the dir owner-only and keeps the shell's umask", async () => {
    const home = path.join(tempDir, "home");
    await fs.mkdir(home);
    const prelude = buildScratchShellPrelude({ kind: "runtime", path: "~/scratch" });
    const shellUmask = execFileSync("bash", ["-c", `umask 022; ${prelude ?? ""}umask`], {
      env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8",
    });
    expect(shellUmask.trim()).toBe("0022");
    expect((await fs.stat(path.join(home, "scratch"))).mode & 0o777).toBe(0o700);
  });

  test("the terminal prelude exports the legacy alias and nothing when mkdir fails", async () => {
    const home = path.join(tempDir, "home");
    await fs.mkdir(home);
    const runPrelude = (prelude: string | undefined) =>
      execFileSync(
        "bash",
        [
          "-c",
          `${prelude ?? ""}printf '%s|%s' "\${XUM_SCRATCH_DIR-unset}" "\${MUX_SCRATCH_DIR-unset}"`,
        ],
        { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" }
      );

    const sshDir = path.join(home, ".mux", RUNTIME_SCRATCH_DIR_NAME, "ws");
    expect(
      runPrelude(
        buildScratchShellPrelude({ kind: "runtime", path: `~/.mux/${RUNTIME_SCRATCH_DIR_NAME}/ws` })
      )
    ).toBe(`${sshDir}|${sshDir}`);

    const mounted = path.join(tempDir, "mounted");
    await fs.mkdir(mounted);
    expect(runPrelude(buildScratchShellPrelude({ kind: "devcontainer-mount", dir: mounted }))).toBe(
      `${mounted}|${mounted}`
    );

    // A path under a regular file cannot be created: the shell still runs, without the var.
    await fs.writeFile(path.join(home, "file"), "not a dir");
    expect(runPrelude(buildScratchShellPrelude({ kind: "runtime", path: "~/file/scratch" }))).toBe(
      "unset|unset"
    );
  });

  test("the terminal command opens no shell when cd fails, with or without the scratch var", async () => {
    const home = path.join(tempDir, "home");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "file"), "not a dir");
    const prelude = (scratchPath: string) =>
      buildScratchShellPrelude({ kind: "runtime", path: scratchPath });
    // `printf` stands in for the interactive shell the terminal execs.
    const run = (cdTarget: string, scratchPath: string) =>
      spawnSync(
        "sh",
        [
          "-c",
          cdThenExecShell(
            cdTarget,
            prelude(scratchPath),
            `printf 'shell|%s' "\${XUM_SCRATCH_DIR-unset}"`
          ),
        ],
        { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" }
      );

    const missingCd = run(shescape.quote(path.join(tempDir, "missing")), "~/scratch");
    expect(missingCd.status).not.toBe(0);
    expect(missingCd.stdout).toBe("");
    // The prelude never ran either: no scratch dir was created.
    expect(await fs.stat(path.join(home, "scratch")).catch(() => null)).toBeNull();

    const ok = run(shescape.quote(tempDir), "~/scratch");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`shell|${path.join(home, "scratch")}`);

    // An unwritable scratch path still opens the shell, without the var.
    const unwritable = run(shescape.quote(tempDir), "~/file/scratch");
    expect(unwritable.status).toBe(0);
    expect(unwritable.stdout).toBe("shell|unset");
  });

  test("the SSH terminal command works when the login shell is sh or fish", async () => {
    // OpenSSH hands the command to the account's login shell; fish cannot parse the prelude's
    // subshell or brace group itself. A quote, backslash and $ in the path exercise the quoting.
    const home = path.join(tempDir, "home");
    const workspaceName = `it's \\\\ $ws`;
    const workspace = path.join(home, workspaceName);
    await fs.mkdir(workspace, { recursive: true });
    const command = runInPosixShell(
      cdThenExecShell(
        expandTildeForSSH(`~/${workspaceName}`),
        buildScratchShellPrelude({ kind: "runtime", path: "~/scratch" }),
        `printf 'shell|%s|%s' "$PWD" "\${XUM_SCRATCH_DIR-unset}"`
      )
    );
    const loginShells = ["sh", "fish"].filter(
      (shell) => spawnSync(shell, ["-c", "exit 0"]).status === 0
    );
    expect(loginShells).toContain("sh");
    for (const shell of loginShells) {
      const result = spawnSync(shell, ["-c", command], {
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
      });
      expect({ shell, stdout: result.stdout, stderr: result.stderr }).toEqual({
        shell,
        stdout: `shell|${workspace}|${path.join(home, "scratch")}`,
        stderr: "",
      });
    }
  });

  test("removeRuntimeScratchDir deletes only the workspace's dir under the runtime home", async () => {
    const xumHome = path.join(tempDir, "remote-home");
    const runtime = new FakeRemoteHomeRuntime(tempDir, xumHome);
    const mine = path.join(xumHome, RUNTIME_SCRATCH_DIR_NAME, "ws1");
    const other = path.join(xumHome, RUNTIME_SCRATCH_DIR_NAME, "ws2");
    await fs.mkdir(path.join(mine, "artifacts"), { recursive: true });
    await fs.writeFile(path.join(mine, "artifacts", "a.md"), "a");
    await fs.mkdir(other, { recursive: true });

    expect(await removeRuntimeScratchDir(runtime, "ws1")).toBe(true);

    expect(await fs.stat(mine).catch(() => null)).toBeNull();
    expect((await fs.stat(other)).isDirectory()).toBe(true);
    // Already gone is still success.
    expect(await removeRuntimeScratchDir(runtime, "ws1")).toBe(true);
  });
});
