import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ServerLockfile } from "../../../src/node/services/serverLockfile";

const appRoot = path.resolve(__dirname, "..", "..", "..");
// `make test-e2e` builds the CLI and the web UI the server serves (dist/index.html).
const CLI_ENTRY = path.join(appRoot, "dist", "cli", "index.js");
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

export interface XumServerProcess {
  baseUrl: string;
  pid: number;
  stop(): Promise<void>;
}

export async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Cannot pick a free port");
  return address.port;
}

/**
 * Start a real `xum server` on a test root and wait until it owns the root's server.lock and
 * answers /health. The token comes from XUM_SERVER_AUTH_TOKEN, which the server never prints.
 */
export async function startXumServer(options: {
  root: string;
  port: number;
  token: string;
  logPath: string;
}): Promise<XumServerProcess> {
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(`Missing ${CLI_ENTRY}. Run \`make build\` first (\`make test-e2e\` does).`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XUM_ROOT: options.root,
    XUM_SERVER_AUTH_TOKEN: options.token,
    XUM_MOCK_AI: "1",
  };
  // Desktop-only switches and legacy aliases must not leak into the server.
  for (const key of [
    "XUM_NO_API_SERVER",
    "MUX_NO_API_SERVER",
    "MUX_ROOT",
    "MUX_SERVER_AUTH_TOKEN",
  ]) {
    delete env[key];
  }
  const logFd = fs.openSync(options.logPath, "a");
  const child = spawn(
    "node",
    [CLI_ENTRY, "server", "--host", "127.0.0.1", "--port", String(options.port)],
    { cwd: appRoot, env, stdio: ["ignore", logFd, logFd] }
  );
  fs.closeSync(logFd);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const pid = child.pid;
  if (pid === undefined) throw new Error("Failed to spawn xum server");

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
    ]);
    if (!stopped) {
      child.kill("SIGKILL");
      await exited;
    }
  };

  const lockfile = new ServerLockfile(options.root);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const log = fs.readFileSync(options.logPath, "utf-8").slice(-2_000);
      throw new Error(`xum server exited before it was ready:\n${log}`);
    }
    const lock = await lockfile.peek();
    if (lock?.pid === pid) {
      const healthy = await fetch(`${lock.baseUrl}/health`).then(
        (response) => response.ok,
        () => false
      );
      if (healthy) return { baseUrl: lock.baseUrl, pid, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stop();
  throw new Error(`xum server was not ready within ${READY_TIMEOUT_MS} ms`);
}
