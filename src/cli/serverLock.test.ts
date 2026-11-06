import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { ServerLockDataSchema } from "@/node/services/serverLockfile";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  startFakeBackend,
  startUnrelatedProcess,
  unservedBaseUrl,
} from "@/node/services/testXumBackend";

// The real `xum server` entry point: its early server.lock check has no seam of its own, because
// main() runs on import and calls process.exit.
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");
const START_DEADLINE_MS = 100_000;

interface RunningServer {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
  stop: () => Promise<void>;
}

function startXumServer(root: string): RunningServer {
  // The caller's own XUM_* and MUX_* settings (a server URL, a root) must not reach the child.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(XUM|MUX)_/.test(key))
  );
  const child = spawn(
    process.execPath,
    [INDEX_ENTRY, "server", "--host", "127.0.0.1", "--port", "0"],
    { env: { ...env, XUM_ROOT: root, XUM_MOCK_AI: "1" }, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  };
  return { child, output: () => output.slice(-2_000), exited, stop };
}

/** Resolves "lock" once server.lock names `pid`, or "exited" when the process ends first. */
async function lockOrExit(lockPath: string, server: RunningServer): Promise<"lock" | "exited"> {
  let exited = false;
  void server.exited.then(() => (exited = true));
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (exited) return "exited";
    const lock = await fs.readFile(lockPath, "utf-8").then(
      (text) => JSON.parse(text) as { pid?: number },
      () => null
    );
    if (lock?.pid === server.child.pid) return "lock";
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`xum server neither took the lock nor exited:\n${server.output()}`);
}

describe.skipIf(process.platform === "win32")("xum server and server.lock", () => {
  test("starts over a lock whose pid an unrelated live process holds", async () => {
    // The backend that wrote the lock crashed. Some other process holds its pid now, and
    // nothing serves its port: the lock is stale, not "already running".
    using tmp = new DisposableTempDir("xum-server-lock");
    const unrelated = startUnrelatedProcess();
    const lockPath = path.join(tmp.path, "server.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: unrelated.pid,
        baseUrl: await unservedBaseUrl(),
        token: "old-token",
        startedAt: "2026-01-01T00:00:00.000Z",
      })
    );
    const server = startXumServer(tmp.path);
    try {
      const outcome = await lockOrExit(lockPath, server);
      if (outcome !== "lock") throw new Error(`xum server exited early:\n${server.output()}`);
      expect(server.output()).not.toContain("already running");
    } finally {
      await server.stop();
      unrelated.kill();
    }
  }, 120_000);

  test("refuses to start next to a running backend", async () => {
    using tmp = new DisposableTempDir("xum-server-lock");
    const running = await startFakeBackend("xum");
    const unrelated = startUnrelatedProcess(); // stands in for the running backend's process
    const lockPath = path.join(tmp.path, "server.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: unrelated.pid,
        baseUrl: running.baseUrl,
        token: "running-token",
        startedAt: new Date().toISOString(),
      })
    );
    const server = startXumServer(tmp.path);
    try {
      expect(await lockOrExit(lockPath, server)).toBe("exited");
      expect(await server.exited).toBe(1);
      expect(server.output()).toContain(`already running at ${running.baseUrl}`);
      const lock = ServerLockDataSchema.parse(JSON.parse(await fs.readFile(lockPath, "utf-8")));
      expect(lock.token).toBe("running-token");
    } finally {
      await server.stop();
      unrelated.kill();
      await running.close();
    }
  }, 120_000);
});
