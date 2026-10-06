import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import * as net from "net";
import { waitForHealth } from "./startApp";

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
  await expect(waitForHealth(`http://127.0.0.1:${port}`, child)).rejects.toThrow(
    "seed server exited early"
  );
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);
