import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { e2eCommandRefusal } from "./hostPause";

const DIR = import.meta.dir;
const ROOT = path.resolve(DIR, "../..");
const CLI = path.join(ROOT, "node_modules/e2e/dist/cli/bin.js");
const CLI_LINK = path.join(ROOT, "node_modules/.bin/e2e");
const WORKER = path.join(ROOT, "node_modules/e2e/dist/run/worker/entry.js");

test("only `e2e run` and `e2e list` may load a bug-bash config", () => {
  for (const argv of [
    ["node", CLI, "run", "--config", "e2e.config.ts", "--tag", "mock-only"],
    ["node", CLI_LINK, "list", "--config=e2e.config.ts"],
    ["node", WORKER], // forked by a CLI run that passed this check
  ])
    expect(e2eCommandRefusal(argv)).toBeNull();
  for (const argv of [
    ["node", CLI, "explore", "--config", "e2e.config.ts", "find bugs"],
    ["node", CLI_LINK, "explore"],
    ["node", CLI, "mcp"],
    ["node", CLI, "cache", "ls"],
    ["node", CLI],
    ["node", path.join(DIR, "run.ts"), "run"], // not the e2e CLI
    ["bun", "-e", "import('./e2e.config.ts')"],
    ["node"],
  ])
    expect(e2eCommandRefusal(argv)).toContain("paused on this host");
});

// A fake app command (`bun`, see e2e.config.ts) and a fake e2e node record every start, and a
// fake provider counts model requests. The guard must stop each refused path before all three.
let bin = "";
let started = "";
let modelRequests = 0;
let provider: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-host-pause-"));
  started = path.join(bin, "started.log");
  for (const name of ["bun", "e2e-node"])
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${started}\n`, {
      mode: 0o755,
    });
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      modelRequests += 1;
      return new Response("{}", { status: 500 });
    },
  });
});
afterAll(async () => {
  await provider.stop(true);
  fs.rmSync(bin, { recursive: true, force: true });
});

// Async on purpose: spawnSync would block this event loop, so the fake provider could not
// count a request that the child sends before it refuses.
async function run(command: string[], env: Record<string, string> = {}) {
  fs.rmSync(started, { force: true });
  modelRequests = 0;
  const base = `http://127.0.0.1:${provider.port}/v1`;
  const child = spawn(command[0], command.slice(1), {
    cwd: DIR,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      E2E_TELEMETRY_DISABLED: "1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: base,
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: base,
      BUGBASH_MODEL: "anthropic:claude-opus-5-5",
      ...env,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject).on("close", (code) => resolve(code));
  });
  return {
    status,
    output,
    started: fs.existsSync(started) ? fs.readFileSync(started, "utf8") : "",
  };
}

const node = process.env.E2E_NODE ?? Bun.which("node") ?? "node";
const e2e = (...args: string[]) => [node, CLI, ...args];

test.each([
  ["e2e explore", e2e("explore", "--config", "e2e.config.ts", "find bugs"), { BUGBASH_AI: "mock" }],
  [
    "e2e explore, MCP Apps",
    e2e("explore", "--config", "e2e.mcpapps.config.ts", "x"),
    { BUGBASH_AI: "mock" },
  ],
  ["e2e run, MCP Apps", e2e("run", "--config", "e2e.mcpapps.config.ts"), { BUGBASH_AI: "mock" }],
  [
    // The sandbox env names alone do not pass: this host has no docker-init and no proxy socket.
    "e2e run, MCP Apps, sandbox env on the host",
    e2e("run", "--config", "e2e.mcpapps.config.ts"),
    { BUGBASH_AI: "mock", BUGBASH_CONTAINER: "1", BUGBASH_MODEL_DRIVEN: "1" },
  ],
  // No app AI mode: e2e.config.ts would throw its own error first, without the pause.
  ["e2e list, MCP Apps, no app AI mode", e2e("list", "--config", "e2e.mcpapps.config.ts"), {}],
  [
    "e2e explore, real app AI",
    e2e("explore", "--config", "e2e.config.ts", "x"),
    { BUGBASH_AI_RESOLVED: "real" },
  ],
  [
    // Unguarded, run.ts probes the app model first (BUGBASH_AI=auto) and then starts e2e-node.
    "run.ts (make bug-bash)",
    [process.execPath, "run.ts", "--only", "composer"],
    {},
  ],
] as const)(
  "%s refuses before any app, e2e or model starts",
  async (_name, command, env) => {
    const r = await run([...command], { ...env, E2E_NODE: path.join(bin, "e2e-node") });
    expect({ status: r.status, started: r.started, modelRequests }).toEqual({
      status: 2,
      started: "",
      modelRequests: 0,
    });
    expect(r.output).toContain(
      "paused on this host until they run in the bug-bash sandbox (#5714)"
    );
  },
  60_000
);

test("control: exact-step repros still load and list", async () => {
  const r = await run(e2e("list", "--config", "e2e.config.ts", "--tag", "mock-only"), {
    BUGBASH_AI: "mock",
  });
  expect([r.status, r.started, modelRequests]).toEqual([0, "", 0]);
  expect(r.output).toMatch(/^repros\/\S+\.e2e\.ts › /m);
  expect(r.output).not.toContain("#5714");
});
