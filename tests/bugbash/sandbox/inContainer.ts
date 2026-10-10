/**
 * Where a bug-bash process runs, and its way to the provider proxy (#5714, plan PR B1).
 *
 * Model-driven jobs (the MCP Apps suite, later `e2e explore`) may run only inside the sandbox
 * container, and only with the proxy: hostPause.ts refuses them everywhere else. The launcher
 * (launch.ts) mounts the folder of the job's proxy socket read-only at PROXY_DIR and sets
 * BUGBASH_MODEL_DRIVEN=1. entry.ts then forwards 127.0.0.1:PROXY_PORT to that socket, because
 * the AI SDK speaks TCP. The container has no network, so the forwarder is its only way out.
 *
 * Every check takes its filesystem root as a parameter, so tests can build a fake sandbox.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export const PROXY_DIR = "/repo/.sandbox-proxy";
export const PROXY_SOCKET = `${PROXY_DIR}/sock`;
export const PROXY_PORT = 4141;
/** The base URL for `createAnthropic()` in the container: the forwarder, then the proxy route. */
export const PROXY_BASE_URL = `http://127.0.0.1:${PROXY_PORT}/anthropic/v1`;

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * True only in a bug-bash sandbox container: the launcher's marker, docker-init as PID 1
 * (`docker run --init`), and no network device but loopback (`--network none`). A host process
 * that sets BUGBASH_CONTAINER=1 still fails the other two.
 */
export function inSandbox(env: NodeJS.ProcessEnv = process.env, root = "/"): boolean {
  const init = read(path.join(root, "proc/1/cmdline"));
  let devices: string[] = [];
  try {
    devices = fs.readdirSync(path.join(root, "sys/class/net"));
  } catch {
    return false;
  }
  return (
    env.BUGBASH_CONTAINER === "1" &&
    init?.startsWith("/sbin/docker-init\0") === true &&
    devices.join() === "lo"
  );
}

/** True in a sandbox container whose launcher started a provider proxy for this job. */
export function modelDrivenSandbox(env: NodeJS.ProcessEnv = process.env, root = "/"): boolean {
  if (!inSandbox(env, root) || env.BUGBASH_MODEL_DRIVEN !== "1") return false;
  const socket = fs.lstatSync(path.join(root, PROXY_SOCKET), { throwIfNoEntry: false });
  return socket?.isSocket() === true;
}

/** Forwards each TCP connection on 127.0.0.1:`port` to the unix socket. Port 0 picks one. */
export async function forwardToProxy(port = PROXY_PORT, socketPath = PROXY_SOCKET) {
  const server = net.createServer((inner) => {
    const outer = net.connect(socketPath);
    const end = () => {
      inner.destroy();
      outer.destroy();
    };
    for (const side of [inner, outer]) side.on("error", end).on("close", end);
    inner.pipe(outer);
    outer.pipe(inner);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
