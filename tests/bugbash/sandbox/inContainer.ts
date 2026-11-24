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
  return env.BUGBASH_CONTAINER === "1" && sandboxShaped(root);
}

/** The filesystem part of inSandbox(): docker-init as PID 1 and loopback as the only device. */
export function sandboxShaped(root = "/"): boolean {
  const init = read(path.join(root, "proc/1/cmdline"));
  let devices: string[] = [];
  try {
    devices = fs.readdirSync(path.join(root, "sys/class/net"));
  } catch {
    return false;
  }
  return init?.startsWith("/sbin/docker-init\0") === true && devices.join() === "lo";
}

/** Whether a proxy socket is mounted: the launcher started a model-driven job here. */
export function proxySocketMounted(root = "/"): boolean {
  const socket = fs.lstatSync(path.join(root, PROXY_SOCKET), { throwIfNoEntry: false });
  return socket?.isSocket() === true;
}

/**
 * True in a sandbox container whose launcher started a provider proxy for this job. Also the
 * launcher's own marks, as entry.ts checks them: this host's boot ID and the nonce that it wrote
 * into the staged copy. Another container with `--init`, `--network none` and a socket at that
 * path fails here.
 */
export function modelDrivenSandbox(env: NodeJS.ProcessEnv = process.env, root = "/"): boolean {
  if (!inSandbox(env, root) || env.BUGBASH_MODEL_DRIVEN !== "1") return false;
  const boot = read(path.join(root, "proc/sys/kernel/random/boot_id"))?.trim();
  const nonce = read(path.join(root, "repo/.sandbox-nonce"));
  const marked =
    boot != null && boot !== "" && boot === env.BUGBASH_HOST_BOOT &&
    nonce != null && nonce !== "" && nonce === env.BUGBASH_HOST_NONCE; // prettier-ignore
  return marked && proxySocketMounted(root);
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

/**
 * The capability sets of a `/proc/<pid>/status` text that are not all zero (selfCheck.ts). All
 * five count: a capability left in the permitted, inheritable, bounding or ambient set can be
 * made effective again, so CapEff 0 alone proves nothing. A missing set counts as nonzero.
 */
export const CAP_SETS = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] as const;
export function nonzeroCapSets(status: string): string[] {
  return CAP_SETS.flatMap((set) => {
    const value = new RegExp(`^${set}:\\s*([0-9a-f]+)$`, "m").exec(status)?.[1];
    return value != null && /^0+$/.test(value) ? [] : [`${set} ${value ?? "missing"}`];
  });
}
