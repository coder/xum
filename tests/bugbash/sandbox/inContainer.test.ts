import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { forwardToProxy, inSandbox, modelDrivenSandbox, PROXY_SOCKET } from "./inContainer";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fake filesystem root that looks like the sandbox container, with a listening proxy socket. */
async function fakeRoot(over: { init?: string; devices?: string[]; socket?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-incontainer-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "proc/1"), { recursive: true });
  fs.writeFileSync(path.join(root, "proc/1/cmdline"), over.init ?? "/sbin/docker-init\0--\0bun\0");
  for (const device of over.devices ?? ["lo"])
    fs.mkdirSync(path.join(root, "sys/class/net", device), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, PROXY_SOCKET)), { recursive: true });
  if (over.socket !== false) {
    const server = net.createServer((socket) => socket.end("proxy says hi"));
    await new Promise<void>((resolve) => server.listen(path.join(root, PROXY_SOCKET), resolve));
    cleanups.push(() => new Promise((done) => server.close(done)));
  }
  return root;
}

const SANDBOX_ENV = { BUGBASH_CONTAINER: "1", BUGBASH_MODEL_DRIVEN: "1" };

test("model-driven jobs pass only in a sandbox container with a proxy socket", async () => {
  expect(modelDrivenSandbox(SANDBOX_ENV, await fakeRoot())).toBe(true);
  // This host: its PID 1 is no docker-init, and it has other network devices.
  expect(inSandbox(SANDBOX_ENV)).toBe(false);
  expect(modelDrivenSandbox(SANDBOX_ENV)).toBe(false);
  const cases: [Record<string, string>, Parameters<typeof fakeRoot>[0]][] = [
    [{ BUGBASH_MODEL_DRIVEN: "1" }, {}],
    [{ BUGBASH_CONTAINER: "1" }, {}],
    [SANDBOX_ENV, { init: "/sbin/init\0" }],
    [SANDBOX_ENV, { devices: ["lo", "eth0"] }],
    [SANDBOX_ENV, { socket: false }],
  ];
  for (const [env, over] of cases)
    expect(modelDrivenSandbox(env, await fakeRoot(over))).toBe(false);
});

test("a regular file in place of the proxy socket does not count", async () => {
  const root = await fakeRoot({ socket: false });
  fs.writeFileSync(path.join(root, PROXY_SOCKET), "");
  expect(modelDrivenSandbox(SANDBOX_ENV, root)).toBe(false);
});

test("the forwarder passes bytes both ways and closes with its server", async () => {
  const root = await fakeRoot();
  const server = await forwardToProxy(0, path.join(root, PROXY_SOCKET));
  const { port } = server.address() as net.AddressInfo;
  const reply = await new Promise<string>((resolve) => {
    let text = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write("hello"));
    socket.on("data", (chunk) => (text += chunk.toString())).on("close", () => resolve(text));
  });
  expect(reply).toBe("proxy says hi");
  await new Promise((done) => server.close(done));
  const after = await new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve("connected"));
    socket.on("error", () => resolve("refused"));
  });
  expect(after).toBe("refused");
});
