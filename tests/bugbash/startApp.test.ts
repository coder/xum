import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { appControlPath, readAppControl } from "./appControl";
import { appSwitches, distFile, waitForHealth } from "./startApp";

let server: net.Server | undefined;
let child: ChildProcess | undefined;
let supervisor: ChildProcess | undefined;
let tempRoot: string | undefined;
const sockets = new Set<net.Socket>();

afterEach(() => {
  child?.kill("SIGKILL");
  // The supervisor leads its own process group, so this also stops the fake server it started
  // when a test fails before its own SIGTERM. The group is gone already after a clean exit.
  if (supervisor?.pid != null) {
    try {
      process.kill(-supervisor.pid, "SIGKILL");
    } catch {
      // ESRCH: the group already exited.
    }
  }
  supervisor = undefined;
  if (tempRoot !== undefined) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  server?.close();
  server = undefined;
  child = undefined;
});

// A server that accepts the connection and never answers, like a seed server stuck in startup.
function listenSilently(): Promise<number> {
  return new Promise((resolve, reject) => {
    const silent = net.createServer((socket) => sockets.add(socket));
    server = silent;
    silent.once("error", reject);
    silent.listen(0, "127.0.0.1", () => {
      const address = silent.address();
      if (address == null || typeof address === "string") reject(new Error("no TCP address"));
      else resolve(address.port);
    });
  });
}

test("a hung /health request does not hide a seed server that exited", async () => {
  const port = await listenSilently();
  child = spawn("sleep", ["0.2"], { stdio: "ignore" });
  // Each probe must give up on its own, so the loop sees the exit long before its 60 s deadline.
  const started = Date.now();
  const error = await waitForHealth(`http://127.0.0.1:${port}`, child).then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("seed server exited early");
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

test("a model-driven job gets every kill switch, also with the mock app AI", () => {
  const all = [
    "XUM_DISABLE_AGENT_TOOLS",
    "XUM_DISABLE_PROJECT_AUTOMATION",
    "XUM_DISABLE_TERMINALS",
  ];
  const keys = (env: Record<string, string>) => Object.keys(env).sort();
  expect(keys(appSwitches("mock", false, true))).toEqual([...all, "XUM_MOCK_AI"]);
  expect(keys(appSwitches("real", false, false))).toEqual(all);
  // Exact-step repros keep today's app env.
  expect(appSwitches("mock", false, false)).toEqual({ XUM_MOCK_AI: "1" });
  expect(keys(appSwitches("mock", true, false))).toEqual([
    "XUM_DISABLE_AGENT_TOOLS",
    "XUM_DISABLE_TERMINALS",
  ]);
});

// A stand-in for `xum server`: /health answers with its pid and the marker file in its XUM_ROOT.
const FAKE_SERVER = `
const fs = require("fs");
require("http")
  .createServer((req, res) => {
    const marker = fs.readFileSync(process.env.XUM_ROOT + "/marker", "utf8");
    res.end(JSON.stringify({ pid: process.pid, marker }));
  })
  .listen(Number(process.argv[1]), "127.0.0.1");
`;

/**
 * Runs startApp.ts's signal handlers and serve() in their own process (signals must reach a
 * process of their own), with FAKE_SERVER in place of `xum server`, on a free port.
 */
async function startSupervisor(): Promise<{
  port: number;
  xumRoot: string;
  exited: Promise<number | null>;
}> {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-serve-test-"));
  const xumRoot = path.join(tempRoot, "xum");
  fs.mkdirSync(xumRoot);
  fs.writeFileSync(path.join(xumRoot, "marker"), "written before the first server");
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address == null || typeof address === "string") reject(new Error("no TCP address"));
      else probe.close(() => resolve(address.port));
    });
  });
  const script = path.join(tempRoot, "supervisor.ts");
  fs.writeFileSync(
    script,
    `import { spawn } from "child_process";
import { handleSignals, serve, type ServerSlot } from ${JSON.stringify(path.join(import.meta.dir, "startApp.ts"))};
const slot: ServerSlot = { current: null, stopping: false, serving: false, restarting: false };
handleSignals(slot);
const start = () => spawn("node", ["-e", ${JSON.stringify(FAKE_SERVER)}, "${port}"], { stdio: "inherit" });
process.exit((await serve(slot, ${port}, start)) ?? 0);
`
  );
  const proc = spawn("bun", [script], {
    cwd: import.meta.dir,
    env: { ...process.env, XUM_ROOT: xumRoot },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  supervisor = proc;
  const exited = new Promise<number | null>((resolve) =>
    proc.once("exit", (code) => resolve(code))
  );
  return { port, xumRoot, exited };
}

async function until<T>(what: string, probe: () => T | null | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function health(port: number): Promise<{ pid: number; marker: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return (await response.json()) as { pid: number; marker: string };
}

test("SIGUSR2 restarts the app server on the same port and XUM_ROOT", async () => {
  const { port, exited } = await startSupervisor();
  const first = await until("generation 1", () => readAppControl(port));
  expect(first).toEqual({ pid: supervisor?.pid ?? -1, generation: 1, ready: true });
  const before = await health(port);
  expect(before.marker).toBe("written before the first server");

  process.kill(first.pid, "SIGUSR2");
  const second = await until("generation 2", () => {
    const control = readAppControl(port);
    return control?.generation === 2 ? control : null;
  });
  expect(second.pid).toBe(first.pid);
  const after = await health(port);
  // A new server process, and the root (with the file written before) is still there.
  expect(after.pid).not.toBe(before.pid);
  expect(after.marker).toBe("written before the first server");

  process.kill(first.pid, "SIGTERM");
  expect(await exited).toBe(0);
  expect(fs.existsSync(appControlPath(port))).toBe(false);
}, 30_000);

test("SIGTERM during a restart stops cleanly, with no new server", async () => {
  const { port, exited } = await startSupervisor();
  const first = await until("generation 1", () => readAppControl(port));
  process.kill(first.pid, "SIGUSR2");
  process.kill(first.pid, "SIGTERM");
  expect(await exited).toBe(0);
  expect(fs.existsSync(appControlPath(port))).toBe(false);
  const error = await fetch(`http://127.0.0.1:${port}/health`).then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
}, 30_000);

test("the Electron renderer server maps URL paths into dist only", () => {
  const dist = "/repo/dist";
  expect(distFile(dist, "/")).toBe("/repo/dist/index.html");
  expect(distFile(dist, "/assets/a%20b.js")).toBe("/repo/dist/assets/a b.js");
  // A path out of dist (raw or encoded), or one that cannot be decoded, gets no file.
  for (const outside of ["/../package.json", "/%2e%2e/package.json", "/a/../../x", "/%E0%A4%A"])
    expect(distFile(dist, outside)).toBeNull();
});
