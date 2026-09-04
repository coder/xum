import { describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Tool } from "ai";
import {
  MEMORY_INTUITION_MAX_USES_PER_TURN,
  MEMORY_INTUITION_TIMEOUT_MS,
} from "@/common/constants/memory";
import { IntuitionToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { Config } from "@/node/config";
import { InitStateManager } from "@/node/services/initStateManager";
import { MemoryService } from "@/node/services/memoryService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { createIntuitionTool } from "./intuition";
import { memoryScopeContextFromToolConfig } from "./memory";
import { TestTempDir, createTestToolConfig, mockToolCallOptions } from "./testHelpers";

const rememberedPath = "/memories/global/remembered.md";
const candidatePath = "/memories/global/candidate.md";
const memory = {
  path: rememberedPath,
  relevance: 0.9,
  excerpt: "Use explicit locks.",
  why: "Protect the shared write.",
};
const candidate = { path: candidatePath, relevance: 0.5, excerpt: "", why: "Possibly relevant." };

function reportingModel(items = [memory, memory, candidate]) {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      const first = step++ === 0;
      const chunks: LanguageModelV3StreamPart[] = [
        {
          type: "tool-call",
          toolCallId: `call-${step}`,
          toolName: first ? "memory_read" : "intuition_report",
          input: JSON.stringify(first ? { path: candidatePath } : { items }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 5, cacheRead: 3, cacheWrite: 2 },
            outputTokens: { total: 4, text: 3, reasoning: 1 },
          },
          providerMetadata: { anthropic: { cacheCreationInputTokens: 2 } },
        },
      ];
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

async function fixture(empty = false) {
  const temp = new TestTempDir("intuition-tool");
  const root = path.join(temp.path, "xum");
  await fs.mkdir(path.join(root, "memory/global"), { recursive: true });
  if (!empty) {
    await fs.writeFile(path.join(root, "memory/global/remembered.md"), memory.excerpt);
    await fs.writeFile(path.join(root, "memory/global/candidate.md"), "Check the write path.");
  }
  const hostConfig = new Config(root);
  const meta = new MemoryMetaService(root);
  const memoryService = new MemoryService(hostConfig, meta);
  const controller = new AbortController();
  const createModel = mock((_modelString: string) => Promise.resolve({ model: reportingModel() }));
  const resolveAgentBody = mock(() =>
    Promise.resolve("Read memories and report relevant evidence.")
  );
  const reportModelUsage = mock<
    NonNullable<ReturnType<typeof createTestToolConfig>["reportModelUsage"]>
  >(() => undefined);
  const config = {
    ...createTestToolConfig(temp.path),
    experiments: { memory: true },
    memoryService,
    reportModelUsage,
    intuitionRuntime: {
      modelString: "openai:intuition-model",
      maxUsesPerTurn: MEMORY_INTUITION_MAX_USES_PER_TURN,
      createModel,
      resolveAgentBody,
      abortSignal: controller.signal,
    },
  };
  return {
    config,
    hostConfig,
    meta,
    memoryService,
    controller,
    createModel,
    resolveAgentBody,
    reportModelUsage,
    [Symbol.dispose]: () => temp[Symbol.dispose](),
  };
}

async function execute(tool: Tool, abortSignal?: AbortSignal) {
  expect(tool.execute).toBeDefined();
  return IntuitionToolResultSchema.parse(
    await tool.execute!(
      { cue: "protect concurrent writes" },
      { ...mockToolCallOptions, abortSignal }
    )
  );
}

describe("intuition tool", () => {
  it("returns verified recall, accounts total usage in the pinned model, and records only unique recognized paths", async () => {
    using f = await fixture();
    const result = await execute(createIntuitionTool(f.config));
    expect(result).toMatchObject({
      kind: "recognized",
      memories: [memory],
      candidates: [{ path: candidatePath, relevance: 0.5 }],
      model: f.config.intuitionRuntime.modelString,
    });
    const entries = await f.meta.getEntries();
    expect([...entries.keys()]).toEqual(["global:remembered.md"]);
    expect(entries.get("global:remembered.md")).toMatchObject({ accessCount: 1 });
    expect(f.createModel).toHaveBeenCalledWith(f.config.intuitionRuntime.modelString);
    expect(f.reportModelUsage).toHaveBeenCalledTimes(1);
    expect(f.reportModelUsage.mock.calls[0][0].timestamp).toBeGreaterThan(0);
    expect(f.reportModelUsage.mock.calls[0][0]).toMatchObject({
      source: "tool",
      toolName: "intuition",
      model: f.config.intuitionRuntime.modelString,
      toolCallId: mockToolCallOptions.toolCallId,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 4 } },
    });
  });

  it("leaves candidate scans out of recall metadata", async () => {
    using f = await fixture();
    f.createModel.mockImplementation(() => Promise.resolve({ model: reportingModel([candidate]) }));
    expect(await execute(createIntuitionTool(f.config))).toMatchObject({
      kind: "uncertain",
      candidates: [{ path: candidatePath }],
    });
    expect((await f.meta.getEntries()).size).toBe(0);
  });

  it("skips model, body, and usage for an empty index, including through registration without runtime init", async () => {
    using f = await fixture(true);
    const init = new InitStateManager(f.hostConfig);
    const waitForInit = spyOn(init, "waitForInit").mockImplementation(() =>
      Promise.reject(new Error("runtime must not initialize"))
    );
    try {
      const tools = await getToolsForModel("openai:gpt-5.2", f.config, f.config.workspaceId!, init);
      expect(tools.intuition).toBeDefined();
      expect(tools.memory).toBeDefined();
      const result = await execute(tools.intuition);
      expect(result).toMatchObject({
        kind: "uncertain",
        candidates: [],
        stats: { indexEntriesConsidered: 0, timedOut: false },
      });
      expect(result.kind === "uncertain" && typeof result.note === "string").toBe(true);
      expect(waitForInit).not.toHaveBeenCalled();
      expect(f.createModel).not.toHaveBeenCalled();
      expect(f.resolveAgentBody).not.toHaveBeenCalled();
      expect(f.reportModelUsage).not.toHaveBeenCalled();
      const disabled = await getToolsForModel(
        "openai:gpt-5.2",
        { ...f.config, experiments: { memory: false } },
        f.config.workspaceId!,
        init
      );
      expect(disabled.intuition).toBeUndefined();
      expect(disabled.memory).toBeUndefined();
    } finally {
      waitForInit.mockRestore();
    }
  });

  it("reserves concurrent uses before awaiting and resets the cap for a new turn", async () => {
    using f = await fixture(true);
    const tool = createIntuitionTool(f.config);
    const results = await Promise.all(
      Array.from({ length: MEMORY_INTUITION_MAX_USES_PER_TURN + 1 }, () => execute(tool))
    );
    expect(results.map((r) => r.kind)).toEqual([
      "uncertain",
      "uncertain",
      "uncertain",
      "limit_reached",
    ]);
    expect((await execute(createIntuitionTool(f.config))).kind).toBe("uncertain");
  });

  it("preserves verified recall when usage reporting throws", async () => {
    using f = await fixture();
    f.reportModelUsage.mockImplementation(() => {
      throw new Error("telemetry offline");
    });
    expect((await execute(createIntuitionTool(f.config))).kind).toBe("recognized");
    expect((await f.meta.getEntries()).size).toBe(1);
  });

  it("maps setup failures and caller cancellation to errors without counting recall", async () => {
    using f = await fixture();
    f.createModel.mockImplementationOnce(() => Promise.reject(new Error("provider unavailable")));
    const tool = createIntuitionTool(f.config);
    expect(await execute(tool)).toMatchObject({ kind: "error", isError: true });
    expect(await execute(tool, AbortSignal.abort())).toMatchObject({
      kind: "error",
      isError: true,
    });
    f.reportModelUsage.mockImplementation(() => {
      f.controller.abort();
    });
    expect(await execute(tool, new AbortController().signal)).toMatchObject({
      kind: "error",
      isError: true,
    });
    expect((await f.meta.getEntries()).size).toBe(0);
  });

  it("returns committed recall when cancellation races with metadata persistence", async () => {
    using f = await fixture();
    const recordRecall = f.memoryService.recordRecall.bind(f.memoryService);
    const recall = spyOn(f.memoryService, "recordRecall").mockImplementation(async (ctx, path) => {
      await recordRecall(ctx, path);
      f.controller.abort();
    });
    try {
      const result = await execute(createIntuitionTool(f.config));
      expect(result).toMatchObject({ kind: "recognized", memories: [memory] });
      expect(recall).toHaveBeenCalledTimes(1);
      expect((await f.meta.getEntries()).get("global:remembered.md")?.accessCount).toBe(1);
    } finally {
      recall.mockRestore();
    }
  });

  it(
    "maps an internal timeout to uncertainty, not cancellation",
    async () => {
      using f = await fixture();
      f.createModel.mockImplementation(
        () =>
          new Promise(() => {
            /* hung provider setup */
          })
      );
      const result = await execute(createIntuitionTool(f.config));
      expect(result).toMatchObject({
        kind: "uncertain",
        candidates: [],
        stats: { timedOut: true },
      });
      expect(result.kind === "uncertain" && typeof result.note === "string").toBe(true);
      expect((await f.meta.getEntries()).size).toBe(0);
    },
    MEMORY_INTUITION_TIMEOUT_MS + 5000
  );

  it("uses stable project identity and disables ambiguous multi-project memory", async () => {
    using f = await fixture(true);
    const config = { ...f.config, workspaceProjectPath: "/stable/project" };
    expect(memoryScopeContextFromToolConfig(config)).toMatchObject({
      checkoutCwd: config.cwd,
      workspaceId: config.workspaceId,
      projectPath: "/stable/project",
    });
    expect(
      memoryScopeContextFromToolConfig({
        ...config,
        projects: [
          { projectPath: "/one", projectName: "one" },
          { projectPath: "/two", projectName: "two" },
        ],
      }).projectPath
    ).toBe("");
  });
});
