import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import * as net from "net";
import { appSwitches, waitForHealth } from "./startApp";

let server: net.Server | undefined;
let child: ChildProcess | undefined;
const sockets = new Set<net.Socket>();

afterEach(() => {
  child?.kill("SIGKILL");
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
