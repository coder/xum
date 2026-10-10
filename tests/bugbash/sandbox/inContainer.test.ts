import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  forwardToProxy,
  inSandbox,
  modelDrivenSandbox,
  nonzeroCapSets,
  PROXY_SOCKET,
} from "./inContainer";
import { e2eCommandRefusal } from "../hostPause";
import { explorerModel } from "./explorerModel";
import { AiModeError, resolveAiMode } from "../aiMode";
import { modelDrivenGuard } from "../startApp";

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
  fs.mkdirSync(path.join(root, "proc/sys/kernel/random"), { recursive: true });
  fs.writeFileSync(path.join(root, "proc/sys/kernel/random/boot_id"), "boot-1\n");
  fs.mkdirSync(path.join(root, "repo"), { recursive: true });
  fs.writeFileSync(path.join(root, "repo/.sandbox-nonce"), "nonce-1");
  fs.mkdirSync(path.dirname(path.join(root, PROXY_SOCKET)), { recursive: true });
  if (over.socket !== false) {
    const server = net.createServer((socket) => socket.end("proxy says hi"));
    await new Promise<void>((resolve) => server.listen(path.join(root, PROXY_SOCKET), resolve));
    cleanups.push(() => new Promise((done) => server.close(done)));
  }
  return root;
}

const SANDBOX_ENV = {
  BUGBASH_CONTAINER: "1",
  BUGBASH_MODEL_DRIVEN: "1",
  BUGBASH_HOST_BOOT: "boot-1",
  BUGBASH_HOST_NONCE: "nonce-1",
};

test("B3: a container without the launcher's boot ID and nonce is no model-driven job", async () => {
  const root = await fakeRoot();
  expect(modelDrivenSandbox(SANDBOX_ENV, root)).toBe(true);
  for (const over of [
    { BUGBASH_HOST_NONCE: "nonce-2" },
    { BUGBASH_HOST_BOOT: "boot-2" },
    { BUGBASH_HOST_NONCE: "" },
    { BUGBASH_HOST_BOOT: undefined },
  ])
    expect(modelDrivenSandbox({ ...SANDBOX_ENV, ...over }, root)).toBe(false);
  fs.writeFileSync(path.join(root, "repo/.sandbox-nonce"), "");
  expect(modelDrivenSandbox({ ...SANDBOX_ENV, BUGBASH_HOST_NONCE: "" }, root)).toBe(false);
});

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

// B2: `e2e explore` with e2e.config.ts, inside a model-driven sandbox job only.
const CLI = path.resolve(import.meta.dir, "../../../node_modules/e2e/dist/cli/bin.js");
const DRIVEN = { ...SANDBOX_ENV, BUGBASH_MODEL: "anthropic:claude-sonnet-5-5" };

test("e2e explore passes the host pause only in a model-driven sandbox job", async () => {
  const root = await fakeRoot();
  const explore = ["node", CLI, "explore", "--config", "e2e.config.ts", "find bugs"];
  expect(e2eCommandRefusal(explore, DRIVEN, root)).toBeNull();
  // The same command on this host, without the model-driven marker, or as another command.
  expect(e2eCommandRefusal(explore, DRIVEN)).toContain("paused on this host");
  expect(e2eCommandRefusal(explore, { BUGBASH_CONTAINER: "1" }, root)).toContain("paused");
  expect(e2eCommandRefusal(["node", CLI, "mcp"], DRIVEN, root)).toContain("paused");
});

test("the agents get the proxy model for `e2e explore` in the sandbox, and never for `e2e run`", async () => {
  const root = await fakeRoot();
  const model = explorerModel(["node", CLI, "explore", "x"], DRIVEN, root);
  expect(model?.modelId).toBe("claude-sonnet-5-5");
  expect(explorerModel(["node", CLI, "run", "--config", "e2e.config.ts"], DRIVEN, root)).toBe(
    undefined
  );
  expect(explorerModel(["node", CLI, "explore", "x"], DRIVEN)).toBeUndefined(); // this host
  expect(() =>
    explorerModel(["node", CLI, "explore", "x"], { ...DRIVEN, BUGBASH_MODEL: "openai:x" }, root)
  ).toThrow(/anthropic/);
});

const ALL_OFF = {
  XUM_DISABLE_AGENT_TOOLS: "1",
  XUM_DISABLE_TERMINALS: "1",
  XUM_DISABLE_PROJECT_AUTOMATION: "1",
};

test("B3: the app refuses to start in a proxied sandbox job without the marker or a switch", async () => {
  const root = await fakeRoot();
  // The marker was dropped on its way to the app: the mounted socket still tells.
  expect(modelDrivenGuard(ALL_OFF, {}, root)).toContain("BUGBASH_MODEL_DRIVEN did not reach");
  expect(modelDrivenGuard(ALL_OFF, { BUGBASH_MODEL_DRIVEN: "1" }, root)).toBeNull();
  const { XUM_DISABLE_TERMINALS: _, ...twoOff } = ALL_OFF;
  expect(modelDrivenGuard(twoOff, { BUGBASH_MODEL_DRIVEN: "1" }, root)).toContain(
    "without XUM_DISABLE_TERMINALS"
  );
  // A repro job (no socket) and this host start as before.
  expect(modelDrivenGuard({}, {}, await fakeRoot({ socket: false }))).toBeNull();
  expect(modelDrivenGuard({}, {})).toBeNull();
});

test("B3: a resolved real app AI in the sandbox talks to the proxy, never with a host key", async () => {
  const root = await fakeRoot();
  const env = {
    ...SANDBOX_ENV,
    BUGBASH_AI_RESOLVED: "real",
    BUGBASH_APP_MODEL: "anthropic:claude-haiku-4-5",
    ANTHROPIC_API_KEY: "sk-must-not-be-used",
  };
  expect(await resolveAiMode(env, root)).toMatchObject({
    mode: "real",
    provider: "anthropic",
    model: "anthropic:claude-haiku-4-5",
    apiKey: "bugbash-sandbox-placeholder",
    baseUrl: "http://127.0.0.1:4141/anthropic/v1",
  });
  const openai = { ...env, BUGBASH_APP_MODEL: "openai:gpt-6.1-sol" };
  expect(await resolveAiMode(openai, root).catch((e: unknown) => e)).toBeInstanceOf(AiModeError);
  // Outside a model-driven sandbox job, real mode keeps reading the host settings.
  expect(await resolveAiMode(env, await fakeRoot({ socket: false }))).toMatchObject({
    apiKey: "sk-must-not-be-used",
  });
});

test("D2: no capabilities needs all five sets zero, not only CapEff", () => {
  const status = (prm: string, amb = "0000000000000000") =>
    `Name:\tbun\nCapInh:\t0000000000000000\nCapPrm:\t${prm}\nCapEff:\t0000000000000000\n` +
    `CapBnd:\t0000000000000000\nCapAmb:\t${amb}\nNoNewPrivs:\t1\n`;
  expect(nonzeroCapSets(status("0000000000000000"))).toEqual([]);
  // CapEff is 0, but a permitted capability could be made effective again.
  expect(nonzeroCapSets(status("0000000000000400"))).toEqual(["CapPrm 0000000000000400"]);
  expect(nonzeroCapSets(status("0000000000000000", "0000000000002000"))).toEqual([
    "CapAmb 0000000000002000",
  ]);
  // A set that is missing from the status text cannot prove anything.
  expect(nonzeroCapSets("CapEff:\t0000000000000000\n")).toEqual([
    "CapInh missing",
    "CapPrm missing",
    "CapBnd missing",
    "CapAmb missing",
  ]);
});
