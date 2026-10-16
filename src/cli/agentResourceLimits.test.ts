import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";

const BUN_EXECUTABLE = process.execPath;
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");
const SRC_DIR = path.resolve(import.meta.dir, "..");
const MOCK_PROVIDER = "local-mock";
const MOCK_MODEL = "mock-model";

/**
 * A xum root that saves a CPU limit of 2 cores and trusts `repo`, and a preload that points the
 * CLI's cgroup host at a fake cgroup tree. `cpuMax()` reads the limit the CLI wrote there.
 */
async function prepareHeadlessRoot(tmp: string) {
  const repo = path.join(tmp, "repo");
  const xumRoot = path.join(tmp, "xum-root");
  const treeRootFile = path.join(tmp, "cgroup-root");
  await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
  await fs.mkdir(xumRoot, { recursive: true });
  await Bun.$`${BUN_EXECUTABLE} -e ${`import { Config } from "./src/node/config"; const c = new Config(); await c.editConfig((cfg) => { cfg.projects.set(process.argv[1], { workspaces: [], trusted: true }); return cfg; }); await c.updateAgentResourceLimits({ cpuCores: 2 });`} ${repo}`
    .env({ ...process.env, MUX_ROOT: xumRoot })
    .quiet();

  const preload = path.join(tmp, "fake-cgroup.ts");
  const module = (name: string) =>
    JSON.stringify(path.join(SRC_DIR, "node/services/agentResourceLimits", name));
  await fs.writeFile(
    preload,
    `import * as fs from "node:fs/promises";
import { linuxAgentCgroupHost } from ${module("agentCgroup")};
import { createFakeCgroupTree } from ${module("testHelpers")};
const tree = await createFakeCgroupTree({ own: "/xum", cgroups: { xum: { controllers: "cpu memory" } } });
Object.assign(linuxAgentCgroupHost, tree.host);
await fs.writeFile(${JSON.stringify(treeRootFile)}, tree.root);
`,
    "utf-8"
  );

  const cpuMax = async (): Promise<string | null> => {
    const treeRoot = await fs.readFile(treeRootFile, "utf-8");
    try {
      return await fs.readFile(path.join(treeRoot, "xum", "xum-agents", "cpu.max"), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      await fs.rm(treeRoot, { recursive: true, force: true });
    }
  };
  return { repo, xumRoot, preload, cpuMax };
}

/** An OpenAI-compatible server whose model answers every request with "done". */
async function startMockModel(xumRoot: string): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: 1,
          model: MOCK_MODEL,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: "done" }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fs.writeFile(
    path.join(xumRoot, "providers.jsonc"),
    JSON.stringify({
      [MOCK_PROVIDER]: {
        providerType: "openai-compatible",
        baseUrl: `${origin}/v1`,
        models: [{ id: MOCK_MODEL, mappedToModel: "anthropic:claude-haiku-4-5" }],
      },
    }),
    "utf-8"
  );
  return server;
}

describe("headless CLI roots apply the saved agent resource limits", () => {
  test("xum workflow", async () => {
    using tmp = new DisposableTempDir("limits-cli-workflow");
    const root = await prepareHeadlessRoot(tmp.path);
    await fs.writeFile(
      path.join(root.repo, "workflows", "echo.js"),
      `export default function workflow() { return { reportMarkdown: "ok" }; }\n`,
      "utf-8"
    );

    const result =
      await Bun.$`${BUN_EXECUTABLE} --preload ${root.preload} ${INDEX_ENTRY} workflow run ./workflows/echo.js --dir ${root.repo}`
        .env({ ...process.env, XUM_ROOT: root.xumRoot, MUX_ROOT: root.xumRoot, NO_COLOR: "1" })
        .nothrow()
        .quiet();

    expect(result.exitCode).toBe(0);
    expect(await root.cpuMax()).toBe("200000 100000");
  }, 60_000);

  test("xum run", async () => {
    using tmp = new DisposableTempDir("limits-cli-run");
    const root = await prepareHeadlessRoot(tmp.path);
    const model = await startMockModel(root.xumRoot);
    try {
      const result =
        await Bun.$`${BUN_EXECUTABLE} --preload ${root.preload} ${INDEX_ENTRY} run --dir ${root.repo} --model ${`${MOCK_PROVIDER}:${MOCK_MODEL}`} --json ${"Say done"}`
          .env({ ...process.env, XUM_ROOT: root.xumRoot, MUX_ROOT: root.xumRoot, NO_COLOR: "1" })
          .nothrow()
          .quiet();

      expect(result.exitCode).toBe(0);
      expect(await root.cpuMax()).toBe("200000 100000");
    } finally {
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
    }
  }, 90_000);
});
