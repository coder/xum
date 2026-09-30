import type * as NodePty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";
import { sanitizeXumChildEnv, sanitizeXumChildPath } from "./childProcessEnv";

interface PtySpawnRequest {
  runtimeLabel: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
  logLocalEnv?: boolean;
}

// Lazy require so a missing prebuilt binary fails at terminal spawn, not at app startup.
function loadNodePty(runtimeType: string): typeof NodePty {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@lydell/node-pty") as typeof NodePty;
  } catch (err) {
    log.error("@lydell/node-pty failed to load:", err);
    throw new Error(`${runtimeType} terminals are not available: ${getErrorMessage(err)}`);
  }
}

export function resolvePathEnv(
  env: NodeJS.ProcessEnv,
  pathEnvOverride?: string
): string | undefined {
  const basePath =
    pathEnvOverride ??
    env.PATH ??
    env.Path ??
    (process.platform === "win32" ? undefined : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");

  return sanitizeXumChildPath(basePath, env);
}

export function spawnPtyProcess(request: PtySpawnRequest): IPty {
  const pty = loadNodePty(request.runtimeLabel);
  const mergedEnv = sanitizeXumChildEnv({ ...process.env, ...request.env });
  const pathEnv = resolvePathEnv(mergedEnv, request.pathEnv);

  const env: NodeJS.ProcessEnv = {
    ...mergedEnv,
    TERM: "xterm-256color",
    ...(pathEnv ? { PATH: pathEnv } : {}),
  };

  try {
    return pty.spawn(request.command, request.args, {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env,
    });
  } catch (err) {
    log.error(`[PTY] Failed to spawn ${request.runtimeLabel} terminal:`, err);

    const printableArgs = request.args.length > 0 ? ` ${request.args.join(" ")}` : "";
    const cmd = `${request.command}${printableArgs}`;
    const details = `cmd="${cmd}", cwd="${request.cwd}", platform="${process.platform}"`;
    const errMessage = getErrorMessage(err);

    if (request.logLocalEnv) {
      log.error(`Local PTY spawn config: ${cmd} (cwd: ${request.cwd})`);
      log.error(`process.env.SHELL: ${process.env.SHELL ?? "undefined"}`);
      log.error(`process.env.PATH: ${process.env.PATH ?? process.env.Path ?? "undefined"}`);
    }

    throw new Error(`Failed to spawn ${request.runtimeLabel} terminal (${details}): ${errMessage}`);
  }
}
