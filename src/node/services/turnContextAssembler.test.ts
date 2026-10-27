import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { sliceMessagesFromLatestCompactionBoundary } from "@/common/utils/messages/compactionBoundary";
import {
  createMuxMessage,
  type MuxMessage,
  type VolatileSystemTailRecord,
} from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { buildWorkflowRunCardMessage } from "@/common/utils/workflowRunMessages";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import { jsonSchema, tool, type Tool } from "ai";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RuntimeError, type Runtime } from "@/node/runtime/Runtime";
import type { PlanFileLocation } from "@/node/utils/runtime/planLocation";
import { createRemoteProjectId } from "@/node/runtime/remoteProjectLayout";
import { DisposableTempDir } from "@/node/services/tempDir";
import { createTestHistoryService } from "./testHistoryService";
import { createFileChangeNotificationMessage } from "./utils/fileChangeTracker";
import { createContextBudgetWarning } from "./contextWindowRollover";
import { extractToolInstructionsFromSources } from "./systemMessage";

import {
  assemblePromptPayload,
  measureVolatileSystemSuffix,
  buildPlanInstructions,
  buildStreamSystemContext,
  prepareProviderRequestMessages,
  removeMemoryGuidance,
} from "./turnContextAssembler";
// The Node layer: these tests read through host runtimes.
import { nodeRuntimeFactory as runtimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";

class TestRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly xumHomePath: string
  ) {
    super(projectPath);
  }

  override getXumHome(): string {
    return this.xumHomePath;
  }
}

function createWorkspaceMetadata(args: {
  id: string;
  name: string;
  projectName: string;
  projectPath: string;
  parentWorkspaceId?: string;
}): WorkspaceMetadata {
  return {
    id: args.id,
    name: args.name,
    projectName: args.projectName,
    projectPath: args.projectPath,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: args.parentWorkspaceId,
  };
}

function createProjectsConfig(args: {
  projectPath: string;
  workspaces: Array<{
    id: string;
    name: string;
    parentWorkspaceId?: string;
  }>;
}): ProjectsConfig {
  return {
    projects: new Map([
      [
        args.projectPath,
        {
          trusted: true,
          workspaces: args.workspaces.map((workspace) => ({
            path: path.join(args.projectPath, workspace.name),
            id: workspace.id,
            name: workspace.name,
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            parentWorkspaceId: workspace.parentWorkspaceId,
          })),
        },
      ],
    ]),
  };
}

async function buildSystemContextForTest(args: {
  runtime: TestRuntime;
  metadata: WorkspaceMetadata;
  workspacePath: string;
  cfg: ProjectsConfig;
  isSubagentWorkspace: boolean;
  effectiveAdditionalInstructions?: string;
  planFilePath?: string;
  memoryToolAvailable?: boolean;
  tokenBudgetEnabled?: boolean;
  workspaceMemoryWritable?: boolean;
  instructionSources?: Parameters<typeof buildStreamSystemContext>[0]["instructionSources"];
}) {
  return buildStreamSystemContext({
    runtime: args.runtime,
    metadata: args.metadata,
    workspacePath: args.workspacePath,
    workspaceId: args.metadata.id,
    agentDefinition: { id: "exec", scope: "built-in" },
    effectiveMode: "exec",
    agentDiscoveryRuntime: args.runtime,
    agentDiscoveryPath: args.workspacePath,
    isSubagentWorkspace: args.isSubagentWorkspace,
    effectiveAdditionalInstructions: args.effectiveAdditionalInstructions,
    planFilePath: args.planFilePath,
    modelString: "openai:gpt-5.2",
    cfg: args.cfg,
    providersConfig: null,
    memoryToolAvailable: args.memoryToolAvailable,
    tokenBudgetEnabled: args.tokenBudgetEnabled,
    workspaceMemoryWritable: args.workspaceMemoryWritable,
    instructionSources: args.instructionSources,
    runtimeFactory,
  });
}

/** A local runtime's plan location (no shared legacy fallback; see planLocation.ts). */
function localPlanLocation(
  runtime: Runtime,
  metadata: { id: string; name: string; projectName: string }
): PlanFileLocation {
  return {
    planPath: getPlanFilePath(metadata.name, metadata.projectName, runtime.getXumHome()),
    legacyIdPath: getLegacyPlanFilePath(metadata.id, runtime.getXumHome()),
  };
}

describe("prepareProviderRequestMessages", () => {
  test("slices at reset boundaries before filtering empty assistant messages", () => {
    const oldMessage = createMuxMessage("old-user", "user", "old context", {
      historySequence: 1,
    });
    const resetBoundary = createMuxMessage("reset-boundary", "assistant", "", {
      historySequence: 2,
      contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
    });
    const newMessage = createMuxMessage("new-user", "user", "new context", {
      historySequence: 3,
    });

    const result = prepareProviderRequestMessages(
      [oldMessage, resetBoundary, newMessage],
      "openai",
      "off"
    );

    expect(result.activeContextMessages.map((message) => message.id)).toEqual(["new-user"]);
    expect(result.providerRequestMessages.map((message) => message.id)).toEqual(["new-user"]);
  });

  test.each(["rejected", "workflow", "rejected-workflow", "normal"] as const)(
    "honors an externally edited reset across archive and active history before %s filtering",
    async (kind) => {
      const { historyService, config, cleanup } = await createTestHistoryService();
      try {
        const workspaceId = "external-reset-filter";
        const sessionDir = path.join(config.sessionsDir, workspaceId);
        await fs.mkdir(sessionDir, { recursive: true });
        const archived = createMuxMessage("archived-private", "user", "Sealed private context", {
          historySequence: 0,
        });
        const oldActive = createMuxMessage("active-private", "user", "Old private context", {
          historySequence: 1,
        });
        const reset = createMuxMessage("externally-edited-reset", "assistant", "", {
          historySequence: 2,
          contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
          ...(kind === "rejected" || kind === "rejected-workflow"
            ? { contextBudgetRejected: true as const }
            : {}),
          ...(kind === "workflow" || kind === "rejected-workflow"
            ? { muxMetadata: { type: "workflow-run-card-display" as const, runId: "wfr_reset" } }
            : {}),
        });
        const current = createMuxMessage("current-user", "user", "Fresh request", {
          historySequence: 3,
        });
        await fs.writeFile(
          path.join(sessionDir, "chat-archive.jsonl"),
          JSON.stringify(archived) + "\n"
        );
        // External editors need not use the writer's compact JSON layout. Both
        // provider reads and replay assembly must still honor the parsed reset.
        const resetLine = JSON.stringify(reset).replace(
          '"contextBoundaryKind":"reset"',
          '"contextBoundaryKind" : "reset"'
        );
        await fs.writeFile(
          path.join(sessionDir, "chat.jsonl"),
          [JSON.stringify(oldActive), resetLine, JSON.stringify(current)].join("\n") + "\n"
        );
        const loaded = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(loaded.success).toBe(true);
        if (!loaded.success) throw new Error(loaded.error);
        expect(loaded.data.map((row) => row.id)).toEqual([reset.id, current.id]);
        expect(
          prepareProviderRequestMessages(loaded.data, "openai", "off").providerRequestMessages.map(
            (row) => row.id
          )
        ).toEqual([current.id]);
        // The provider reader now clamps first; broader replay snapshots still
        // need the assembler's independent boundary-before-filtering protection.
        const prepared = prepareProviderRequestMessages(
          [archived, oldActive, ...loaded.data],
          "openai",
          "off"
        );
        expect(prepared.activeContextMessages.map((row) => row.id)).toEqual([current.id]);
        expect(prepared.providerRequestMessages.map((row) => row.id)).toEqual([current.id]);
        expect(prepared.contextBoundarySlicedCount).toBe(kind === "normal" ? 3 : 2);
        expect(await fs.readFile(path.join(sessionDir, "chat.jsonl"), "utf8")).toContain(resetLine);
      } finally {
        await cleanup();
      }
    }
  );

  test("filters workflow display rows while keeping provider-visible workflow results", () => {
    const trigger = createMuxMessage("workflow-command", "user", "/shallow-review mux", {
      historySequence: 1,
      muxMetadata: {
        type: "workflow-trigger-display",
        rawCommand: "/shallow-review mux",
        commandPrefix: "/shallow-review",
        runId: "wfr_1",
      },
    });
    const card = buildWorkflowRunCardMessage(
      { name: "shallow-review", args: { input: "mux" } },
      { runId: "wfr_1", status: "running", result: null },
      2
    );
    card.metadata = {
      historySequence: 2,
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "workflow-run-card-display", runId: "wfr_1" },
    };
    const result = createMuxMessage(
      "workflow-result",
      "user",
      "/shallow-review mux\n\n<mux_workflow_result>{}</mux_workflow_result>",
      {
        historySequence: 3,
        muxMetadata: {
          type: "workflow-result",
          rawCommand: "/shallow-review mux",
          commandPrefix: "/shallow-review",
          runId: "wfr_1",
        },
      }
    );
    const nextUser = createMuxMessage("next-user", "user", "continue normal work", {
      historySequence: 4,
    });

    const prepared = prepareProviderRequestMessages(
      [trigger, card, result, nextUser],
      "openai",
      "off"
    );

    expect(prepared.activeContextMessages.map((message) => message.id)).toEqual([
      "workflow-result",
      "next-user",
    ]);
    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "workflow-result",
      "next-user",
    ]);
  });

  test("drops hidden plan-review record rows but keeps authentic feedback rows", () => {
    const snapshotRecord: PlanReviewRecord = {
      v: 1,
      kind: "snapshot",
      recordId: "rec1",
      snapshotId: "s1",
      planPath: "/plans/p.md",
      contentHash: "a".repeat(64),
      content: "# Secret plan\n",
    };
    const feedbackRecord: PlanReviewRecord = {
      v: 1,
      kind: "feedback",
      recordId: "rec2",
      feedbackId: "f1",
      snapshotId: "s1",
      contentHash: "a".repeat(64),
      comments: [{ threadId: "t1", anchor: { startLine: 1, endLine: 1 }, quote: "#", body: "?" }],
      replies: [],
    };
    const snapshot = createMuxMessage(
      "plan-review-snapshot",
      "user",
      formatPlanReviewEnvelope(snapshotRecord),
      { historySequence: 1, synthetic: true, muxMetadata: buildPlanReviewMetadata(snapshotRecord) }
    );
    const feedback = createMuxMessage(
      "plan-review-feedback",
      "user",
      formatPlanReviewEnvelope(feedbackRecord),
      { historySequence: 2, muxMetadata: buildPlanReviewMetadata(feedbackRecord) }
    );
    const answer = createMuxMessage("answer", "assistant", "revised", { historySequence: 3 });
    const resolve = createMuxMessage("plan-review-resolve", "user", "<mux_plan_review>…", {
      historySequence: 4,
      synthetic: true,
      muxMetadata: { type: "plan-review", kind: "resolve", recordId: "rec3", threadId: "t1" },
    });
    // A hidden snapshot whose metadata kind was corrupted to "feedback" must stay hidden: only
    // an authentic feedback envelope is provider-visible, never a bare kind claim.
    const corruptedKind = createMuxMessage(
      "plan-review-corrupted",
      "user",
      formatPlanReviewEnvelope({ ...snapshotRecord, recordId: "rec4", snapshotId: "s2" }),
      {
        historySequence: 5,
        synthetic: true,
        muxMetadata: { type: "plan-review", kind: "feedback", recordId: "rec4", snapshotId: "s2" },
      }
    );
    const nextUser = createMuxMessage("next-user", "user", "continue", { historySequence: 6 });

    const prepared = prepareProviderRequestMessages(
      [snapshot, feedback, answer, resolve, corruptedKind, nextUser],
      "openai",
      "off"
    );

    expect(prepared.activeContextMessages.map((message) => message.id)).toEqual([
      "plan-review-feedback",
      "answer",
      "next-user",
    ]);
    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "plan-review-feedback",
      "answer",
      "next-user",
    ]);
    // Hidden rows are ordinary content filtering, not a boundary/keep-recent removal.
    expect(prepared.contextBoundarySlicedCount).toBe(0);
  });

  test("excludes the stamped keep-recent tail from RLM compaction summarization requests", () => {
    const head = createMuxMessage("head-user", "user", "old context", { historySequence: 1 });
    const headReply = createMuxMessage("head-assistant", "assistant", "old reply", {
      historySequence: 2,
    });
    const tail = createMuxMessage("tail-user", "user", "recent context", { historySequence: 3 });
    const tailReply = createMuxMessage("tail-assistant", "assistant", "recent reply", {
      historySequence: 4,
    });
    const stampedRequest = createMuxMessage("compact-req", "user", "/compact", {
      historySequence: 5,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
        keepRecentTail: { startHistorySequence: 3 },
      },
    });

    const prepared = prepareProviderRequestMessages(
      [head, headReply, tail, tailReply, stampedRequest],
      "openai",
      "off"
    );

    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "head-user",
      "head-assistant",
      "compact-req",
    ]);
  });

  test("preserves keep-recent selection and excludes content filters from the sliced count", () => {
    const rows = [
      createMuxMessage("old", "user", "Before reset", { historySequence: 0 }),
      createMuxMessage("reset", "assistant", "", {
        historySequence: 1,
        contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
        contextBudgetRejected: true,
      }),
      createMuxMessage("head", "user", "Summarize this", { historySequence: 2 }),
      createMuxMessage("display", "assistant", "Workflow card", {
        historySequence: 3,
        muxMetadata: { type: "workflow-run-card-display", runId: "wfr_1" },
      }),
      createMuxMessage("tail", "user", "Preserve this", { historySequence: 4 }),
      createMuxMessage("tail-answer", "assistant", "Recent answer", { historySequence: 5 }),
      createMuxMessage("compact", "user", "/compact", {
        historySequence: 6,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: {},
          keepRecentTail: { startHistorySequence: 4 },
        },
      }),
      createMuxMessage("rejected", "user", "Not part of the request", {
        historySequence: 7,
        contextBudgetRejected: true,
      }),
    ];
    const prepared = prepareProviderRequestMessages(rows, "openai", "off");
    expect(prepared.providerRequestMessages.map((row) => row.id)).toEqual(["head", "compact"]);
    expect(prepared.contextBoundarySlicedCount).toBe(3);
  });

  test("keeps whole-epoch summarization for unstamped compaction requests (RLM off)", () => {
    const head = createMuxMessage("head-user", "user", "old context", { historySequence: 1 });
    const tail = createMuxMessage("tail-user", "user", "recent context", { historySequence: 2 });
    const request = createMuxMessage("compact-req", "user", "/compact", {
      historySequence: 3,
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    });

    const prepared = prepareProviderRequestMessages([head, tail, request], "openai", "off");

    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "head-user",
      "tail-user",
      "compact-req",
    ]);
  });
});

describe("assemblePromptPayload", () => {
  const createTools = () => ({
    first: tool({
      description: "first",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => Promise.resolve({ ok: true }),
    }),
    terminal: tool({
      description: "terminal",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => Promise.resolve({ ok: true }),
    }),
  });

  const assemble = (overrides: Partial<Parameters<typeof assemblePromptPayload>[0]> = {}) =>
    assemblePromptPayload({
      history: [createMuxMessage("user", "user", "hello")],
      systemMessage: "system",
      tools: createTools(),
      modelString: "google:gemini-2.5-pro",
      providerForMessages: "google",
      effectiveThinkingLevel: "off",
      effectiveAgentId: "exec",
      toolNamesForSentinel: ["first", "terminal"],
      workspaceId: "workspace",
      ...overrides,
    });

  test("puts request context at the start of the newest user message, or last without one", async () => {
    const context = createMuxMessage("ctx", "user", "VIEW-CONTEXT");
    const turns = [
      createMuxMessage("u1", "user", "FIRST"),
      createMuxMessage("a1", "assistant", "ANSWER"),
    ];
    const order = async (history: typeof turns) => {
      const payload = await assemble({ history, requestContextMessage: context });
      // Request-only: never part of the rows the request was built from.
      expect(payload.providerRequestMessages.some((m) => m.id === "ctx")).toBe(false);
      const wire = JSON.stringify(payload.messages);
      return ["FIRST", "ANSWER", "VIEW-CONTEXT", "NEWEST"]
        .filter((text) => wire.includes(text))
        .sort((a, b) => wire.indexOf(a) - wire.indexOf(b));
    };
    expect(await order([...turns, createMuxMessage("u2", "user", "NEWEST")])).toEqual([
      "FIRST",
      "ANSWER",
      "VIEW-CONTEXT",
      "NEWEST",
    ]);
    // At the provider the two user rows are one message (mergeConsecutiveUserMessages): the
    // context block first, then the user's text.
    const merged = await assemble({
      history: [...turns, createMuxMessage("u2", "user", "NEWEST")],
      requestContextMessage: context,
    });
    expect(merged.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(merged.messages[2])).toContain("VIEW-CONTEXT\\nNEWEST");
    expect(await order(turns)).toEqual(["FIRST", "ANSWER", "VIEW-CONTEXT"]);
    const plain = await assemble({ history: turns });
    const withContext = await assemble({ history: turns, requestContextMessage: context });
    expect(withContext.system).toEqual(plain.system);
  });

  test("request context keeps every part of the user message it merges into", async () => {
    const context = createMuxMessage("ctx", "user", "VIEW-CONTEXT");
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg><text>SVG-BODY</text></svg>").toString("base64")}`;
    const history = [
      createMuxMessage("u1", "user", "NEWEST", undefined, [
        { type: "file", mediaType: "image/svg+xml", url: svg, filename: "chart.svg" },
      ]),
    ];
    const payload = await assemble({ history, requestContextMessage: context });
    expect(payload.messages.map((m) => m.role)).toEqual(["user"]);
    const wire = JSON.stringify(payload.messages);
    // The SVG reaches the provider as text, after the context and the user's own text.
    expect(wire).toContain("SVG-BODY");
    expect(wire.indexOf("VIEW-CONTEXT")).toBeLessThan(wire.indexOf("NEWEST"));
    expect(wire.indexOf("NEWEST")).toBeLessThan(wire.indexOf("SVG-BODY"));
  });

  test("puts request context before the request a trailing partial assistant continues", async () => {
    const context = createMuxMessage("ctx", "user", "VIEW-CONTEXT");
    // The refusal fallback (and an interrupted turn) ends the history in the partial reply.
    const history = [
      createMuxMessage("u1", "user", "FIRST"),
      createMuxMessage("a1", "assistant", "ANSWER"),
      createMuxMessage("u2", "user", "NEWEST"),
      createMuxMessage("a2", "assistant", "PARTIAL", { partial: true }),
    ];
    const payload = await assemble({ history, requestContextMessage: context });
    const wire = JSON.stringify(payload.messages);
    const order = ["FIRST", "ANSWER", "VIEW-CONTEXT", "NEWEST", "PARTIAL"]
      .filter((text) => wire.includes(text))
      .sort((a, b) => wire.indexOf(a) - wire.indexOf(b));
    expect(order).toEqual(["FIRST", "ANSWER", "VIEW-CONTEXT", "NEWEST", "PARTIAL"]);
    // Nothing but the continuation sentinel follows the partial reply.
    const afterPartial = wire.slice(wire.indexOf("PARTIAL"));
    expect(afterPartial).not.toContain("VIEW-CONTEXT");
    expect(afterPartial).toContain("[CONTINUE]");
  });

  test("replays tool_catalog_search results as tool references only for deferred tools", async () => {
    const history = [
      createMuxMessage("user", "user", "find it"),
      createMuxMessage("search", "assistant", "", undefined, [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "tool_catalog_search",
          state: "output-available",
          input: { query: "terminal" },
          output: {
            query: "terminal",
            matches: [{ name: "terminal", description: "terminal" }],
            totalDeferred: 1,
          },
        },
      ]),
      createMuxMessage("next", "user", "continue"),
    ];
    const toolOutput = async (tools: Record<string, Tool>) => {
      const payload = await assemble({
        history,
        tools,
        modelString: "anthropic:claude-sonnet-4-5",
        providerForMessages: "anthropic",
      });
      const toolMessage = payload.messages.find((message) => message.role === "tool");
      const part = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
      return part?.type === "tool-result" ? part.output : undefined;
    };
    const deferred = createTools();
    deferred.terminal.providerOptions = { anthropic: { deferLoading: true } };

    expect(await toolOutput(deferred)).toEqual({
      type: "content",
      value: [
        {
          type: "custom",
          providerOptions: { anthropic: { type: "tool-reference", toolName: "terminal" } },
        },
      ],
    });
    expect((await toolOutput(createTools()))?.type).toBe("json");
  });

  for (const testCase of [
    {
      name: "folds Anthropic system and caches the terminal tool",
      modelString: "anthropic:claude-sonnet-4-5",
      providerForMessages: "anthropic",
      expectedSystem: "folded",
    },
    {
      name: "uses an explicit system breakpoint for eligible OpenAI requests",
      modelString: "openai:gpt-6-luna",
      providerForMessages: "openai",
      routeProvider: "openai",
      providersConfig: { openai: { apiKeySet: true, isEnabled: true, isConfigured: true } },
      expectedSystem: "structured",
    },
    {
      name: "keeps plain system instructions for providers without explicit caching",
      modelString: "google:gemini-2.5-pro",
      providerForMessages: "google",
      expectedSystem: "plain",
    },
  ] as const) {
    test(testCase.name, async () => {
      const payload = await assemble({ ...testCase, anthropicCacheTtl: "1h" });

      if (testCase.expectedSystem === "folded") {
        expect(payload.system).toBeUndefined();
        expect(payload.messages[0]?.role).toBe("system");
        expect(payload.tools?.terminal.providerOptions).toEqual({
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        });
        expect(payload.tools?.first.providerOptions).toBeUndefined();
      } else if (testCase.expectedSystem === "structured") {
        expect(payload.system).toEqual({
          role: "system",
          content: "system",
          providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
        });
      } else {
        expect(payload.system).toBe("system");
      }
    });
  }

  test("puts a volatile system tail after each provider's cached stable block", async () => {
    const stable = "stable instructions";
    const withTail = (tail: string) => ({
      systemMessage: stable + tail,
      volatileSystemSuffixLength: tail.length,
    });
    const openai = {
      modelString: "openai:gpt-6-luna",
      providerForMessages: "openai",
      routeProvider: "openai",
      providersConfig: { openai: { apiKeySet: true, isEnabled: true, isConfigured: true } },
    };
    const tails = ["\n\n[Warning: a]", "\n\n<context_window>b</context_window>"];

    // The stable (cached) block is byte-identical whatever the tail says,
    // and the tail block is delivered uncached right after it.
    for (const tail of tails) {
      const anthropic = await assemble({
        modelString: "anthropic:claude-sonnet-4-5",
        providerForMessages: "anthropic",
        ...withTail(tail),
      });
      expect(anthropic.messages.slice(0, 2)).toEqual([
        {
          role: "system",
          content: stable,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        { role: "system", content: tail },
      ]);

      const structured = await assemble({ ...openai, ...withTail(tail) });
      expect(structured.system).toEqual([
        {
          role: "system",
          content: stable,
          providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
        },
        { role: "system", content: tail },
      ]);

      // No explicit breakpoints: one string, volatile text last.
      expect((await assemble(withTail(tail))).system).toBe(stable + tail);
    }
  });

  describe("volatile tail changes inside a context segment (mechanism 10)", () => {
    const stable = "stable instructions";
    const warning = (text: string) => `\n\n[Warning: ${text}]`;
    const opus = {
      modelString: "anthropic:claude-opus-5-5",
      providerForMessages: "anthropic",
      routeProvider: "anthropic",
    };
    const answer = (id: string, placement: "system" | "row", text: string, extra = {}) =>
      createMuxMessage(id, "assistant", `answer ${id}`, {
        volatileSystemTail: { text, placement },
        ...extra,
      });
    const withTail = (tail: string, history: MuxMessage[], route: object = opus) =>
      assemble({
        ...route,
        history,
        systemMessage: stable + tail,
        volatileSystemSuffixLength: tail.length,
      });
    const roles = (payload: Awaited<ReturnType<typeof assemble>>) =>
      payload.messages.map((message) =>
        message.role === "system" && typeof message.content === "string"
          ? message.content === stable
            ? "system:stable"
            : // The frozen tail keeps its "\n\n" separator; a mid-conversation row does not.
              message.content.startsWith("\n\n")
              ? `system:${message.content}`
              : "system-row"
          : message.role
      );
    const withoutMarkers = (messages: unknown[]) =>
      JSON.stringify(messages, (key, value: unknown) =>
        key === "cacheControl" ? undefined : value
      ).replace(/,?"providerOptions":\{"anthropic":\{\}\}/g, "");

    test("freezes the system tail and sends a change as a row the next turn repeats", async () => {
      const u1 = createMuxMessage("u1", "user", "first");
      const u2 = createMuxMessage("u2", "user", "second");
      const start = await withTail(warning("A"), [u1]);
      expect(start.volatileSystemTail).toEqual({ text: warning("A"), placement: "system" });

      const history = [u1, answer("a1", "system", warning("A")), u2];
      const changed = await withTail(warning("B"), history);
      // The system tail stays A; B goes after the newest user row.
      expect(roles(changed)).toEqual([
        "system:stable",
        `system:${warning("A")}`,
        "user",
        "assistant",
        "user",
        "system-row",
      ]);
      expect(JSON.stringify(changed.messages.at(-1))).toContain("[Warning: B]");
      expect(changed.volatileSystemTail).toEqual({ text: warning("B"), placement: "row" });

      // The next turn rebuilds the row in place and adds none for an unchanged tail.
      const u3 = createMuxMessage("u3", "user", "third");
      const next = await withTail(warning("B"), [
        ...history,
        answer("a2", "row", warning("B")),
        u3,
      ]);
      expect(next.volatileSystemTail).toBeUndefined();
      expect(roles(next).filter((role) => role.startsWith("system")).length).toBe(3);
      expect(withoutMarkers(next.messages.slice(0, changed.messages.length - 1))).toBe(
        withoutMarkers(changed.messages.slice(0, -1))
      );
      expect(withoutMarkers([next.messages[changed.messages.length - 1]])).toBe(
        withoutMarkers([changed.messages.at(-1)])
      );
    });

    test("other models and an assistant-last history keep the old placement", async () => {
      const history = [
        createMuxMessage("u1", "user", "first"),
        answer("a1", "system", warning("A")),
        createMuxMessage("u2", "user", "second"),
      ];
      // A model without mid-conversation system rows: the records change nothing.
      const sonnet45 = await withTail(warning("B"), history, {
        modelString: "anthropic:claude-sonnet-4-5",
        providerForMessages: "anthropic",
        routeProvider: "anthropic",
      });
      expect(roles(sonnet45)).toEqual([
        "system:stable",
        `system:${warning("B")}`,
        "user",
        "assistant",
        "user",
      ]);
      expect(sonnet45.volatileSystemTail).toBeUndefined();
      // A route that converts the body on its side: unverified, so the old placement too.
      const gateway = await withTail(warning("B"), history, {
        modelString: "openrouter:anthropic/claude-opus-5-5",
        providerForMessages: "anthropic",
        routeProvider: "openrouter",
      });
      expect(roles(gateway).slice(0, 2)).toEqual(["system:stable", `system:${warning("B")}`]);
      expect(gateway.volatileSystemTail).toBeUndefined();
      const gemini = await withTail(warning("B"), history, {});
      expect(gemini.system).toBe(stable + warning("B"));
      expect(gemini.volatileSystemTail).toBeUndefined();
    });

    test("an assistant-last request keeps the frozen tail and the next user turn sends the row", async () => {
      // F36: a retry after a stream failure (or a resume) ends with an assistant row, where
      // Anthropic rejects a system row. It re-froze at the live tail and rewrote the warm
      // cache seconds after the failed attempt. Now it keeps A and row B, and records nothing.
      const history = [
        createMuxMessage("u1", "user", "first"),
        answer("a1", "system", warning("A")),
        createMuxMessage("u2", "user", "second"),
        answer("a2", "row", warning("B")),
        createMuxMessage("u3", "user", "third"),
      ];
      const sent = await withTail(warning("B"), history);
      const resumed = await withTail(warning("C"), [
        ...history,
        createMuxMessage("a3", "assistant", "partial", { partial: true }),
      ]);
      expect(resumed.volatileSystemTail).toBeUndefined();
      expect(withoutMarkers(resumed.messages.slice(0, sent.messages.length))).toBe(
        withoutMarkers(sent.messages)
      );
      expect(JSON.stringify(resumed.messages)).not.toContain("[Warning: C]");

      // The next request after a user message sends C as a row.
      const next = await withTail(warning("C"), [
        ...history,
        createMuxMessage("a3", "assistant", "answer"),
        createMuxMessage("u4", "user", "fourth"),
      ]);
      expect(next.volatileSystemTail).toEqual({ text: warning("C"), placement: "row" });
      expect(roles(next).slice(0, 2)).toEqual(["system:stable", `system:${warning("A")}`]);
    });

    test("a row skipped on rebuild does not hide its tail from the model", async () => {
      // The empty-row filter depends on the thinking level, so a row's neighbor can change
      // between the request that recorded it and a later rebuild. Each step below sends the
      // request the assembler builds and records what it returns, as a turn does.
      const thinking = { ...opus, effectiveThinkingLevel: "high" as const };
      const u1 = createMuxMessage("u1", "user", "first");
      const first = await withTail(warning("A"), [u1], thinking);
      const a1 = answer("a1", "system", warning("A"));
      expect(first.volatileSystemTail).toEqual(a1.metadata?.volatileSystemTail);
      // The user stops the next turn while the model still thinks: a reasoning-only partial.
      const u2 = createMuxMessage("u2", "user", "second");
      const a2: MuxMessage = {
        id: "a2",
        role: "assistant",
        parts: [{ type: "reasoning", text: "thinking" }],
        metadata: { partial: true },
      };
      // With thinking off and a new warning, the user resumes. The filter drops a2, so
      // the request ends with u2 and B goes into a row that a3 records.
      const resumed = await withTail(warning("B"), [u1, a1, u2, a2], opus);
      expect(resumed.volatileSystemTail).toEqual({ text: warning("B"), placement: "row" });
      const a3 = answer("a3", "row", warning("B"));
      // Thinking on again: a2 comes back between u2 and a3, so a3's row is skipped. The live
      // tail is still B and must reach the model (before the fix it saw only A).
      const u3 = createMuxMessage("u3", "user", "third");
      const next = await withTail(warning("B"), [u1, a1, u2, a2, a3, u3], thinking);
      expect(roles(next).at(-1)).toBe("system-row");
      expect(JSON.stringify(next.messages.at(-1))).toContain("[Warning: B]");
      expect(next.volatileSystemTail).toEqual({ text: warning("B"), placement: "row" });

      // A replay derives the live tail by the same rule. The planner sends this request for
      // live A, and an older build sent it for live B: frozen A, no row, no record.
      const history = [u1, a1, u2, a2, a3, u3];
      const stale = await withTail(warning("A"), history, thinking);
      expect(stale.volatileSystemTail).toBeUndefined();
      for (const sent of [next, stale]) {
        const replayed = await assemble({
          ...thinking,
          history,
          systemMessage: sent.sentSystem.message,
          volatileSystemSuffixLength: sent.sentSystem.volatileSuffixLength,
          replayedTurn: { record: sent.volatileSystemTail },
        });
        expect(JSON.stringify(replayed.messages)).toBe(JSON.stringify(sent.messages));
      }
    });

    test("a replay from the sent system content rebuilds the live request", async () => {
      // PRRT_kwDOPxxmWM6srqjr: the envelope records what was sent (the frozen tail), so the
      // replay derives the live tail from the turn's record, or from the segment's last tail.
      const base = [
        createMuxMessage("u1", "user", "first"),
        answer("a1", "system", warning("A")),
        createMuxMessage("u2", "user", "second"),
      ];
      const unchanged = [
        ...base,
        answer("a2", "row", warning("B")),
        createMuxMessage("u3", "user", "x"),
      ];
      const cases = [
        { history: base, live: warning("B") },
        { history: unchanged, live: warning("B") },
      ];
      for (const { history, live } of cases) {
        const sent = await withTail(live, history);
        const replayed = await assemble({
          ...opus,
          history,
          systemMessage: sent.sentSystem.message,
          volatileSystemSuffixLength: sent.sentSystem.volatileSuffixLength,
          replayedTurn: { record: sent.volatileSystemTail },
        });
        expect(sent.sentSystem.message).toBe(stable + warning("A"));
        expect(JSON.stringify(replayed.messages)).toBe(JSON.stringify(sent.messages));
      }
    });

    test("a compaction request sends the live tail with no rows", async () => {
      // Codex P2 (PRRT_kwDOPxxmWM6srL1X): the compaction trim fits the history to the budget
      // before the tail is planned, so rebuilt rows would add tokens the trim never counted.
      const history = [
        createMuxMessage("u1", "user", "first"),
        answer("a1", "system", warning("A")),
        createMuxMessage("u2", "user", "second"),
        answer("a2", "row", warning("B")),
        createMuxMessage("u3", "user", "third"),
        answer("a3", "row", warning("C")),
        createMuxMessage("u4", "user", "summarize"),
      ];
      const tail = warning("D");
      const payload = await assemble({
        ...opus,
        history,
        systemMessage: stable + tail,
        volatileSystemSuffixLength: tail.length,
        compactionInputBudgetTokens: 100_000,
      });
      expect(roles(payload).filter((role) => role.startsWith("system"))).toEqual([
        "system:stable",
        `system:${tail}`,
      ]);
      expect(payload.volatileSystemTail).toBeUndefined();
    });

    test("an empty or unsplittable tail turns the rows off for the request", async () => {
      // Codex P2 (PRRT_kwDOPxxmWM6sqhpD): length 0 also means turnRequestBuilder could not
      // split the tail off (middleware edited it), so its content may be in the stable part. A
      // row there would claim the frozen sections are gone while they are still present.
      const history = [
        createMuxMessage("u1", "user", "first"),
        answer("a1", "system", warning("A")),
        createMuxMessage("u2", "user", "second"),
        answer("a2", "row", warning("B")),
        createMuxMessage("u3", "user", "third"),
      ];
      const prompt = `${stable}${warning("C")}\nappended by middleware`;
      const payload = await assemble({
        ...opus,
        history,
        systemMessage: prompt,
        volatileSystemSuffixLength: 0,
      });
      expect(payload.messages[0]).toMatchObject({ role: "system", content: prompt });
      expect(payload.messages.filter((message) => message.role === "system")).toHaveLength(1);
      expect(payload.volatileSystemTail).toBeUndefined();
    });

    test("an instructions change and a tail change in one turn keep both rows in place", async () => {
      // D9: the <custom-instructions> block (AGENTS.md) follows the tail's rule. Its row comes
      // first, so the tail row after it still follows the user row on every rebuild.
      const block = (rules: string) => `\n<custom-instructions>\n${rules}\n</custom-instructions>`;
      const send = (
        rules: string,
        tail: string,
        history: MuxMessage[],
        replayedTurn?: {
          record?: VolatileSystemTailRecord;
          customInstructions?: VolatileSystemTailRecord;
        }
      ) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable + block(rules) + tail,
          volatileSystemSuffixLength: tail.length,
          instructionsSection: { prefix: stable, block: block(rules) },
          replayedTurn,
        });
      const turnRow = (id: string, payload: Awaited<ReturnType<typeof send>>) =>
        createMuxMessage(id, "assistant", `answer ${id}`, {
          volatileSystemTail: payload.volatileSystemTail,
          customInstructions: payload.customInstructions,
        });
      const [u1, u2, u3] = ["first", "second", "third"].map((text, index) =>
        createMuxMessage(`u${index + 1}`, "user", text)
      );
      const start = await send("v1", warning("A"), [u1]);
      expect(start.customInstructions).toEqual({ text: block("v1"), placement: "system" });

      const history = [u1, turnRow("a1", start), u2];
      const changed = await send("v2", warning("B"), history);
      // The cached system block keeps v1; v2 and B go after the newest user row, in that order.
      expect(changed.messages[0]).toMatchObject({ role: "system", content: stable + block("v1") });
      expect(changed.messages.slice(-3).map((message) => message.role)).toEqual([
        "user",
        "system",
        "system",
      ]);
      expect(JSON.stringify(changed.messages.at(-2))).toContain("v2");
      expect(JSON.stringify(changed.messages.at(-1))).toContain("[Warning: B]");
      expect(changed.customInstructions).toEqual({ text: block("v2"), placement: "row" });

      // The replay verifier rebuilds the same request from the sent system and the records.
      const replayed = await send("v1", warning("A"), history, {
        record: changed.volatileSystemTail,
        customInstructions: changed.customInstructions,
      });
      expect(withoutMarkers(replayed.messages)).toBe(withoutMarkers(changed.messages));

      // The next turn puts both rows back in place and adds none: it extends the request.
      const next = await send("v2", warning("B"), [...history, turnRow("a2", changed), u3]);
      expect(next.customInstructions).toBeUndefined();
      expect(next.volatileSystemTail).toBeUndefined();
      expect(withoutMarkers(next.messages.slice(0, changed.messages.length))).toBe(
        withoutMarkers(changed.messages)
      );
    });

    test("a removed AGENTS.md keeps the frozen block and sends the removal as a row", async () => {
      // Codex P2 PRRT_kwDOPxxmWM6vffU2: the only instruction file is deleted mid-segment. The
      // system prompt keeps the frozen block (no rewrite), and a row says it is gone.
      const block = "\n<custom-instructions>\nRule v1\n</custom-instructions>";
      const send = (live: string, history: MuxMessage[]) =>
        assemble({
          ...opus,
          history,
          systemMessage:
            stable + live + "\n\n<additional-instructions>\nx\n</additional-instructions>",
          instructionsSection: { prefix: stable, block: live },
        });
      const turnRow = (id: string, payload: Awaited<ReturnType<typeof send>>) =>
        createMuxMessage(id, "assistant", `answer ${id}`, {
          customInstructions: payload.customInstructions,
        });
      const [u1, u2, u3] = ["first", "second", "third"].map((text, index) =>
        createMuxMessage(`u${index + 1}`, "user", text)
      );
      // A segment start (or old data) without blocks sends none and freezes "no blocks".
      const oldData = await send("", [u1]);
      expect(oldData.customInstructions).toEqual({ text: "", placement: "system" });
      expect(JSON.stringify(oldData.messages)).not.toContain("custom instructions were removed");

      const start = await send(block, [u1]);
      const history = [u1, turnRow("a1", start), u2];
      const removed = await send("", history);
      expect(withoutMarkers([removed.messages[0]])).toBe(withoutMarkers([start.messages[0]]));
      expect(JSON.stringify(removed.messages.at(-1))).toContain("custom instructions were removed");
      expect(removed.customInstructions?.placement).toBe("row");
      // The next turn repeats the row in place and adds none.
      const next = await send("", [...history, turnRow("a2", removed), u3]);
      expect(next.customInstructions).toBeUndefined();
      expect(withoutMarkers(next.messages.slice(0, removed.messages.length))).toBe(
        withoutMarkers(removed.messages)
      );
    });

    test("a retry after an assistant row keeps the frozen skill index in the tool block", async () => {
      // F36 (live, 2026-10-26): a stream closed mid-turn, and the retry's history ended with
      // the committed assistant row. The skill list had changed meanwhile, so the retry
      // re-froze it and rewrote the cached tool block 2 s after the failed attempt.
      const index = (skills: string) => `\n\nAvailable skills:\n${skills}`;
      const send = (skills: string, history: MuxMessage[]) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable,
          tools: {
            agent_skill_read: tool({
              description: `Read a skill.${index(skills)}`,
              inputSchema: jsonSchema({ type: "object" }),
            }),
          },
          skillIndexSection: { prefix: "Read a skill.", block: index(skills) },
        });
      const history = [
        createMuxMessage("u1", "user", "first"),
        createMuxMessage("a1", "assistant", "answer", {
          skillIndex: { text: index("- a"), placement: "system" },
        }),
      ];
      const retry = await send("- a\n- b", history);
      expect(retry.tools?.agent_skill_read?.description).toBe(`Read a skill.${index("- a")}`);
      expect(retry.skillIndex).toBeUndefined();
      const next = await send("- a\n- b", [...history, createMuxMessage("u2", "user", "second")]);
      expect(next.tools?.agent_skill_read?.description).toBe(`Read a skill.${index("- a")}`);
      expect(next.skillIndex).toEqual({ text: index("- a\n- b"), placement: "row" });
    });

    test("a skill index change keeps the frozen tool description and replays from the records", async () => {
      const index = (skills: string) => `\n\nAvailable skills:\n${skills}`;
      const send = (
        skills: string,
        history: MuxMessage[],
        replayedTurn?: { skillIndex?: VolatileSystemTailRecord }
      ) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable,
          // Replay rebuilds without tools: the records alone decide its rows.
          ...(replayedTurn == null && {
            tools: {
              agent_skill_read: tool({
                description: `Read a skill.${skills && index(skills)}\n\nTool instructions.`,
                inputSchema: jsonSchema({ type: "object" }),
              }),
            },
            skillIndexSection: { prefix: "Read a skill.", block: skills && index(skills) },
          }),
          replayedTurn,
        });
      const u1 = createMuxMessage("u1", "user", "first");
      const u2 = createMuxMessage("u2", "user", "second");
      const start = await send("- a", [u1]);
      expect(start.skillIndex).toEqual({ text: index("- a"), placement: "system" });
      const history = [
        u1,
        createMuxMessage("a1", "assistant", "answer", { skillIndex: start.skillIndex }),
        u2,
      ];
      const changed = await send("- a\n- b", history);
      // The description keeps "- a" (and what follows it); the new list goes in a row.
      expect(changed.tools?.agent_skill_read?.description).toBe(
        `Read a skill.${index("- a")}\n\nTool instructions.`
      );
      expect(JSON.stringify(changed.messages.at(-1))).toContain("- b");
      expect(changed.skillIndex).toEqual({ text: index("- a\n- b"), placement: "row" });
      const replayed = await send("", history, { skillIndex: changed.skillIndex });
      expect(withoutMarkers(replayed.messages)).toBe(withoutMarkers(changed.messages));
      // No skill listed any more: the description keeps the frozen list, a row says so.
      const removed = await send("", history);
      expect(removed.tools?.agent_skill_read?.description).toBe(
        `Read a skill.${index("- a")}\n\nTool instructions.`
      );
      expect(JSON.stringify(removed.messages.at(-1))).toContain("no skills are listed now");
    });

    test("a first skill added mid-segment is a row, not a tool-block rewrite", async () => {
      // Same gap as PRRT_kwDOPxxmWM6vgBAc for the skill index: the segment starts with no skill
      // listed, then one appears. The cached tool description stays byte-identical.
      const index = "\n\nAvailable skills:\n- a";
      const send = (block: string, history: MuxMessage[]) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable,
          tools: {
            agent_skill_read: tool({
              description: `Read a skill.${block}\n\nTool instructions.`,
              inputSchema: jsonSchema({ type: "object" }),
            }),
          },
          skillIndexSection: { prefix: "Read a skill.", block },
        });
      const turnRow = (id: string, payload: Awaited<ReturnType<typeof send>>) =>
        createMuxMessage(id, "assistant", `answer ${id}`, { skillIndex: payload.skillIndex });
      const [u1, u2, u3] = ["first", "second", "third"].map((text, index) =>
        createMuxMessage(`u${index + 1}`, "user", text)
      );
      const start = await send("", [u1]);
      expect(start.skillIndex).toEqual({ text: "", placement: "system" });
      const history = [u1, turnRow("a1", start), u2];
      const added = await send(index, history);
      expect(added.tools?.agent_skill_read?.description).toBe(
        "Read a skill.\n\nTool instructions."
      );
      expect(JSON.stringify(added.messages.at(-1))).toContain("- a");
      expect(added.skillIndex).toEqual({ text: index, placement: "row" });
      // The next turn repeats the row in place and adds none.
      const next = await send(index, [...history, turnRow("a2", added), u3]);
      expect(next.skillIndex).toBeUndefined();
      expect(withoutMarkers(next.messages.slice(0, added.messages.length))).toBe(
        withoutMarkers(added.messages)
      );
    });

    test("a first AGENTS.md added mid-segment is a row, not a system-prompt rewrite", async () => {
      // Codex P2 PRRT_kwDOPxxmWM6vgBAc: the segment starts with no instruction blocks, then an
      // AGENTS.md (or a first Model:/Mode: section) appears. The cached system block stays.
      const block = "\n<custom-instructions>\nRule v1\n</custom-instructions>";
      const send = (live: string, history: MuxMessage[]) =>
        assemble({
          ...opus,
          history,
          systemMessage:
            stable + live + "\n\n<additional-instructions>\nx\n</additional-instructions>",
          instructionsSection: { prefix: stable, block: live },
        });
      const turnRow = (id: string, payload: Awaited<ReturnType<typeof send>>) =>
        createMuxMessage(id, "assistant", `answer ${id}`, {
          customInstructions: payload.customInstructions,
        });
      const [u1, u2, u3, u4] = ["first", "second", "third", "fourth"].map((text, index) =>
        createMuxMessage(`u${index + 1}`, "user", text)
      );
      const start = await send("", [u1]);
      // Still none on the next turn: no change, so no row and no record (no removal row).
      const same = await send("", [u1, turnRow("a1", start), u2]);
      expect(same.customInstructions).toBeUndefined();
      expect(same.messages.filter((message) => message.role === "system")).toHaveLength(1);

      const history = [u1, turnRow("a1", start), u2, turnRow("a2", same), u3];
      const added = await send(block, history);
      expect(withoutMarkers([added.messages[0]])).toBe(withoutMarkers([start.messages[0]]));
      expect(added.messages.at(-1)?.role).toBe("system");
      expect(JSON.stringify(added.messages.at(-1))).toContain("Rule v1");
      expect(added.customInstructions).toEqual({ text: block, placement: "row" });
      // The next turn repeats the row in place and adds none.
      const next = await send(block, [...history, turnRow("a3", added), u4]);
      expect(next.customInstructions).toBeUndefined();
      expect(withoutMarkers(next.messages.slice(0, added.messages.length))).toBe(
        withoutMarkers(added.messages)
      );
    });

    test("a model or agent switch re-freezes the instruction blocks instead of a row", async () => {
      // F30a: the new model's (or agent's) sections replace the old ones in the system prompt.
      // Each model has its own cache, and an agent switch changes <agent-instructions> before
      // the blocks, so this costs no cache; a same-model, same-agent change is still a row.
      const block = (tag: string) =>
        `\n<custom-instructions>\nRule\n</custom-instructions>\n<${tag}>\nx\n</${tag}>`;
      const send = (live: string, history: MuxMessage[], route: object = {}) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable + live,
          instructionsSection: { prefix: stable, block: live },
          ...route,
        });
      const opusRow = createMuxMessage("a1", "assistant", "answer", {
        model: "anthropic:claude-opus-5-5",
        agentId: "exec",
        routeProvider: "anthropic",
        customInstructions: { text: block("model-opus"), placement: "system" },
      });
      const history = [
        createMuxMessage("u1", "user", "first"),
        opusRow,
        createMuxMessage("u2", "user", "second"),
      ];
      const sonnet = { modelString: "anthropic:claude-sonnet-5-5" };
      // Codex PRRT_kwDOPxxmWM6vjdlK: the same canonical model on another route is a switch too
      // (the model section's tag holds the raw model string).
      const coder = { modelString: "coder:anthropic/claude-opus-5-5", routeProvider: "coder" };
      for (const [live, route] of [
        [block("model-sonnet"), sonnet],
        [block("mode-plan"), { effectiveAgentId: "plan" }],
        [block("model-coder:anthropic/claude-opus-5-5"), coder],
      ] as const) {
        const switched = await send(live, history, route);
        expect(switched.messages[0]).toMatchObject({ role: "system", content: stable + live });
        expect(switched.messages.filter((message) => message.role === "system")).toHaveLength(1);
        expect(switched.customInstructions).toEqual({ text: live, placement: "system" });
        // The replay verifier rebuilds the same request from the turn's record.
        const replayed = await send(live, history, {
          ...route,
          replayedTurn: { customInstructions: switched.customInstructions },
        });
        expect(withoutMarkers(replayed.messages)).toBe(withoutMarkers(switched.messages));
      }
      const sameModel = await send(block("model-opus-v2"), history);
      expect(sameModel.customInstructions?.placement).toBe("row");

      // Codex PRRT_kwDOPxxmWM6vjONA: a switch with no new edit after that row turn still folds
      // the row's blocks into the system prompt instead of keeping the stale frozen ones.
      const rowTurn = [
        ...history,
        createMuxMessage("a2", "assistant", "answer", {
          model: "anthropic:claude-opus-5-5",
          agentId: "exec",
          customInstructions: sameModel.customInstructions,
        }),
        createMuxMessage("u3", "user", "third"),
      ];
      const live = block("model-opus-v2");
      const folded = await send(live, rowTurn, sonnet);
      expect(folded.messages[0]).toMatchObject({ role: "system", content: stable + live });
      expect(folded.messages.filter((message) => message.role === "system")).toHaveLength(1);
      expect(folded.customInstructions).toEqual({ text: live, placement: "system" });
      const replayed = await send(live, rowTurn, {
        ...sonnet,
        replayedTurn: { customInstructions: folded.customInstructions },
      });
      expect(withoutMarkers(replayed.messages)).toBe(withoutMarkers(folded.messages));
      // With nothing to fold, a switch changes nothing and records nothing.
      const unchanged = await send(block("model-opus"), history, sonnet);
      expect(unchanged.customInstructions).toBeUndefined();
    });

    test("an assistant-last request after an agent switch re-freezes every section", async () => {
      // Codex PRRT_kwDOPxxmWM6wf11x: a partial turn resumed under another agent must send that
      // agent's live Tool: instructions, skill index and tail, not the old agent's frozen ones
      // until a later user turn. A same-agent retry still keeps the frozen sections (F36).
      const index = (skills: string) => `\n\nAvailable skills:\n${skills}`;
      const send = (
        live: { bash: string; skills: string; tail: string },
        history: MuxMessage[],
        extra: object = {}
      ) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable + live.tail,
          volatileSystemSuffixLength: live.tail.length,
          tools: {
            bash: tool({
              description: `Run bash.\n\n${live.bash}`,
              inputSchema: jsonSchema({ type: "object" }),
            }),
            agent_skill_read: tool({
              description: `Read a skill.${index(live.skills)}`,
              inputSchema: jsonSchema({ type: "object" }),
            }),
          },
          toolInstructions: { bash: live.bash },
          skillIndexSection: { prefix: "Read a skill.", block: index(live.skills) },
          ...extra,
        });
      const history = [
        createMuxMessage("u1", "user", "first"),
        createMuxMessage("a1", "assistant", "answer", {
          agentId: "exec",
          toolInstructions: { text: JSON.stringify({ bash: "Use rg." }), placement: "system" },
          skillIndex: { text: index("- a"), placement: "system" },
          volatileSystemTail: { text: warning("A"), placement: "system" },
        }),
        createMuxMessage("u2", "user", "second"),
        createMuxMessage("a2", "assistant", "partial", { agentId: "exec", partial: true }),
      ];
      const live = { bash: "Use fd.", skills: "- a\n- b", tail: warning("B") };

      const switched = await send(live, history, { effectiveAgentId: "plan" });
      expect(switched.tools?.bash?.description).toBe("Run bash.\n\nUse fd.");
      expect(switched.tools?.agent_skill_read?.description).toBe(
        `Read a skill.${index("- a\n- b")}`
      );
      expect(switched.messages[1]).toMatchObject({ role: "system", content: warning("B") });
      expect(switched.toolInstructions).toEqual({
        text: JSON.stringify({ bash: "Use fd." }),
        placement: "system",
      });
      expect(switched.skillIndex).toEqual({ text: index("- a\n- b"), placement: "system" });
      expect(switched.volatileSystemTail).toEqual({ text: warning("B"), placement: "system" });
      // The replay verifier rebuilds the same request from the turn's records.
      const replayed = await assemble({
        ...opus,
        history,
        systemMessage: stable + live.tail,
        volatileSystemSuffixLength: live.tail.length,
        effectiveAgentId: "plan",
        replayedTurn: {
          record: switched.volatileSystemTail,
          skillIndex: switched.skillIndex,
          toolInstructions: switched.toolInstructions,
        },
      });
      expect(withoutMarkers(replayed.messages)).toBe(withoutMarkers(switched.messages));

      const retry = await send(live, history, { effectiveAgentId: "exec" });
      expect(retry.tools?.bash?.description).toBe("Run bash.\n\nUse rg.");
      expect(retry.tools?.agent_skill_read?.description).toBe(`Read a skill.${index("- a")}`);
      expect(retry.messages[1]).toMatchObject({ role: "system", content: warning("A") });
      expect(retry.toolInstructions).toBeUndefined();
      expect(retry.skillIndex).toBeUndefined();
      expect(retry.volatileSystemTail).toBeUndefined();
    });

    test("Tool: instructions it cannot place or a corrupt record keep the live descriptions", async () => {
      const send = (description: string, instructions: string, history: MuxMessage[]) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable,
          tools: { bash: tool({ description, inputSchema: jsonSchema({ type: "object" }) }) },
          toolInstructions: { bash: instructions },
        });
      const frozenAt = (text: string) => [
        createMuxMessage("u1", "user", "first"),
        createMuxMessage("a1", "assistant", "answer", {
          toolInstructions: { text, placement: "system" },
        }),
        createMuxMessage("u2", "user", "second"),
      ];
      const systemRows = (payload: Awaited<ReturnType<typeof send>>) =>
        payload.messages.filter((message) => message.role === "system").length;

      // A wrapper rewrote the description after getToolsForModel, so it no longer ends with
      // its instructions: the request sends as before, with no record and no row.
      const rewritten = await send(
        "Run bash (rewritten).",
        "Use fd.",
        frozenAt(JSON.stringify({ bash: "Use rg." }))
      );
      expect(rewritten.tools?.bash?.description).toBe("Run bash (rewritten).");
      expect(rewritten.toolInstructions).toBeUndefined();
      expect(systemRows(rewritten)).toBe(1);

      // A corrupt frozen record: the live description stays, and a row sends the live text.
      const corrupt = await send("Run bash.\n\nUse rg.", "Use rg.", frozenAt("{not json"));
      expect(corrupt.tools?.bash?.description).toBe("Run bash.\n\nUse rg.");
      expect(corrupt.toolInstructions?.placement).toBe("row");
      expect(JSON.stringify(corrupt.messages.at(-1))).toContain("Use rg.");
    });

    test("a Tool: section change keeps the frozen tool descriptions and sends a row", async () => {
      // Codex PRRT_kwDOPxxmWM6vgBAW: getToolsForModel appends each tool's Tool: section to its
      // description, inside the cached tool block. A change is a row; the block stays.
      const send = (
        instructions: Record<string, string>,
        history: MuxMessage[],
        replayedTurn?: { toolInstructions?: VolatileSystemTailRecord }
      ) =>
        assemble({
          ...opus,
          history,
          systemMessage: stable,
          ...(replayedTurn == null && {
            tools: Object.fromEntries(
              ["bash", "first"].map((name) => [
                name,
                tool({
                  description: `Run ${name}.${instructions[name] ? `\n\n${instructions[name]}` : ""}`,
                  inputSchema: jsonSchema({ type: "object" }),
                }),
              ])
            ),
            toolInstructions: instructions,
          }),
          replayedTurn,
        });
      const descriptions = (payload: Awaited<ReturnType<typeof send>>) =>
        Object.values(payload.tools ?? {}).map((entry) => entry.description);
      const turnRow = (id: string, payload: Awaited<ReturnType<typeof send>>) =>
        createMuxMessage(id, "assistant", `answer ${id}`, {
          toolInstructions: payload.toolInstructions,
        });
      const [u1, u2, u3] = ["first", "second", "third"].map((text, index) =>
        createMuxMessage(`u${index + 1}`, "user", text)
      );
      const start = await send({ bash: "Use rg." }, [u1]);
      expect(start.toolInstructions?.placement).toBe("system");
      const history = [u1, turnRow("a1", start), u2];

      // bash's section changes and first gets one: both descriptions keep the frozen text.
      const changed = await send({ bash: "Use fd.", first: "Be brief." }, history);
      expect(descriptions(changed)).toEqual(descriptions(start));
      const row = JSON.stringify(changed.messages.at(-1));
      expect(row).toContain('<tool-instructions tool=\\"bash\\">\\nUse fd.');
      expect(row).toContain('<tool-instructions tool=\\"first\\">\\nBe brief.');
      expect(changed.toolInstructions?.placement).toBe("row");
      const replayed = await send({}, history, { toolInstructions: changed.toolInstructions });
      expect(withoutMarkers(replayed.messages)).toBe(withoutMarkers(changed.messages));

      // The next turn puts the row back in place and adds none.
      const next = await send({ bash: "Use fd.", first: "Be brief." }, [
        ...history,
        turnRow("a2", changed),
        u3,
      ]);
      expect(next.toolInstructions).toBeUndefined();
      expect(descriptions(next)).toEqual(descriptions(start));
      expect(withoutMarkers(next.messages.slice(0, changed.messages.length))).toBe(
        withoutMarkers(changed.messages)
      );

      // No Tool: section any more: the frozen text stays, a row says so.
      const removed = await send({}, history);
      expect(descriptions(removed)).toEqual(descriptions(start));
      expect(JSON.stringify(removed.messages.at(-1))).toContain("no tool has Tool: instructions");
    });

    test("a compaction boundary starts a new segment with the live tail", async () => {
      const boundary = createMuxMessage("boundary", "assistant", "Compacted summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        // A record on the boundary row belongs to the request that compacted, not the segment.
        volatileSystemTail: { text: warning("A"), placement: "system" },
      });
      const payload = await withTail(warning("B"), [
        createMuxMessage("u1", "user", "first"),
        answer("a1", "system", warning("A")),
        createMuxMessage("u2", "user", "second"),
        answer("a2", "row", warning("B")),
        boundary,
        createMuxMessage("u3", "user", "third"),
      ]);
      // Without the reset, B was the last tail sent: the request would keep A and add nothing.
      expect(roles(payload)).toEqual([
        "system:stable",
        `system:${warning("B")}`,
        "assistant",
        "user",
      ]);
      expect(payload.volatileSystemTail).toEqual({ text: warning("B"), placement: "system" });
    });
  });

  test("injects an interrupted sentinel only when a partial assistant remains terminal", async () => {
    const partial = createMuxMessage("partial", "assistant", "working", { partial: true });
    const withoutFollowingUser = await assemble({
      history: [createMuxMessage("user", "user", "hello"), partial],
    });
    const withFollowingUser = await assemble({
      history: [
        createMuxMessage("user", "user", "hello"),
        partial,
        createMuxMessage("follow-up", "user", "continue"),
      ],
    });

    expect(withoutFollowingUser.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(withFollowingUser.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(withoutFollowingUser.messages.at(-1))).not.toContain("continue");
    expect(JSON.stringify(withFollowingUser.messages.at(-1))).toContain("continue");
  });

  test("places plan transition context before the final user request", async () => {
    const payload = await assemble({
      history: [
        createMuxMessage("planned", "assistant", "plan ready", { agentId: "plan" }),
        createMuxMessage("execute", "user", "implement it"),
      ],
      planContentForTransition: "approved plan body",
      planFilePath: "/tmp/plan.md",
    });

    expect(payload.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(JSON.stringify(payload.messages[1])).toContain("approved plan body");
  });

  test("post-compaction attachments leave every row before the newest request unchanged", async () => {
    // F34: the attachments are request-only and come back every few turns for the segment.
    // After the compaction summary they rewrote the cached history on the turn they appeared
    // and again on the next turn, when they were gone.
    const opus = {
      modelString: "anthropic:claude-opus-5-5",
      providerForMessages: "anthropic",
      routeProvider: "anthropic",
    };
    const summary = createMuxMessage("summary", "assistant", "Compacted summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const [u1, a1, u2, a2, u3] = [
      createMuxMessage("u1", "user", "first"),
      createMuxMessage("a1", "assistant", "answer 1"),
      createMuxMessage("u2", "user", "second"),
      createMuxMessage("a2", "assistant", "answer 2"),
      createMuxMessage("u3", "user", "third"),
    ];
    const attachments = [
      {
        type: "plan_file_reference" as const,
        planFilePath: "/tmp/plan.md",
        planContent: "ATTACHED PLAN",
      },
    ];
    const send = (history: MuxMessage[], withAttachments: boolean) =>
      assemble({
        ...opus,
        history,
        systemMessage: "stable instructions",
        postCompactionAttachments: withAttachments ? attachments : null,
      });
    const rows = (payload: Awaited<ReturnType<typeof send>>, count: number) =>
      JSON.stringify(payload.messages.slice(0, count), (key, value: unknown) =>
        key === "providerOptions" ? undefined : value
      );

    const plain = await send([summary, u1, a1, u2], false);
    const attached = await send([summary, u1, a1, u2], true);
    const next = await send([summary, u1, a1, u2, a2, u3], false);
    // The cached system row, the summary, u1 and a1 come before the newest request (u2).
    const before = plain.messages.length - 1;
    expect(JSON.stringify(plain.messages.at(-1))).toContain("second");
    expect(rows(attached, before)).toBe(rows(plain, before));
    expect(rows(next, before)).toBe(rows(attached, before));
    // The newest request carries the attachments, first.
    expect(attached.messages).toHaveLength(plain.messages.length);
    const request = JSON.stringify(attached.messages.at(-1));
    expect(request.indexOf("ATTACHED PLAN")).toBeLessThan(request.indexOf("second"));
  });

  test("post-compaction attachments keep their place when a file-change row is the newest", async () => {
    // F37: AgentSession appends the durable <system-file-update> row before it reads the
    // history, so it is the newest user row. Every rebuild of the turn (a retry after the
    // committed assistant row, a budget warning appended mid-turn) and the plain request
    // keep the rows before the turn's request, and the retry extends the first request.
    const opus = {
      modelString: "anthropic:claude-opus-5-5",
      providerForMessages: "anthropic",
      routeProvider: "anthropic",
    };
    const summary = createMuxMessage("summary", "assistant", "Compacted summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const notification = createFileChangeNotificationMessage([
      { type: "edited_text_file", filename: "src/a.ts", snippet: "@@ -1 +1 @@" },
    ]);
    const turn = [
      summary,
      createMuxMessage("u1", "user", "first"),
      createMuxMessage("a1", "assistant", "answer 1"),
      createMuxMessage("u2", "user", "second"),
      notification,
    ];
    const attachments = [
      { type: "plan_file_reference" as const, planFilePath: "/p.md", planContent: "ATTACHED PLAN" },
    ];
    const send = (history: MuxMessage[], withAttachments = true) =>
      assemble({
        ...opus,
        history,
        systemMessage: "stable instructions",
        postCompactionAttachments: withAttachments ? attachments : null,
      });
    const rows = (payload: Awaited<ReturnType<typeof send>>, count: number) =>
      JSON.stringify(payload.messages.slice(0, count), (key, value: unknown) =>
        key === "providerOptions" ? undefined : value
      );

    const first = await send(turn);
    const before = first.messages.length - 1;
    const request = JSON.stringify(first.messages.at(-1));
    expect(request.indexOf("second")).toBeLessThan(request.indexOf("ATTACHED PLAN"));
    expect(request.indexOf("ATTACHED PLAN")).toBeLessThan(request.indexOf("system-file-update"));

    const retry = await send([...turn, createMuxMessage("a2", "assistant", "partial answer")]);
    expect(rows(retry, first.messages.length)).toBe(rows(first, first.messages.length));
    const warned = await send([
      ...turn,
      createContextBudgetWarning({
        contextTokens: 80_000,
        maxTokens: 128_000,
        budgetTokens: 96_000,
        sessionHistoryAvailable: true,
        handoff: true,
      }),
    ]);
    expect(rows(warned, before)).toBe(rows(first, before));
    expect(JSON.stringify(warned.messages.at(-1))).toContain("ATTACHED PLAN");
    for (const plain of [
      await send(turn, false),
      await send(
        [
          ...turn,
          createMuxMessage("a2", "assistant", "answer 2"),
          createMuxMessage("u3", "user", "third"),
        ],
        false
      ),
    ]) {
      expect(rows(plain, before)).toBe(rows(first, before));
    }
  });

  test("token budget tags persisted user rows with their session_history item ID", async () => {
    const request = createMuxMessage("request", "user", "fix the bug", { historySequence: 7 });
    const reply = createMuxMessage("reply", "assistant", "on it", { historySequence: 8 });
    const advisory = createContextBudgetWarning({
      contextTokens: 80_000,
      maxTokens: 128_000,
      budgetTokens: 96_000,
      sessionHistoryAvailable: true,
      handoff: true,
    });
    advisory.metadata!.historySequence = 9;
    const unsequenced = createMuxMessage("pending", "user", "follow-up");
    const history = [request, reply, advisory, unsequenced];
    const text = (payload: Awaited<ReturnType<typeof assemble>>) =>
      JSON.stringify(payload.messages);

    const tagged = text(await assemble({ history, tagHistoryItemIds: true }));
    expect(tagged).toContain("[id: 7]");
    expect(tagged).not.toContain("[id: 8]");
    // Budget-internal rows and rows without a persisted sequence cannot be read back.
    expect(tagged).not.toContain("[id: 9]");
    expect(tagged).not.toContain("[id: m:");
    expect(text(await assemble({ history }))).not.toContain("[id:");

    // A tag depends only on its own row, so appending history keeps the cached prefix intact.
    const shortPayload = await assemble({ history: [request, reply], tagHistoryItemIds: true });
    const longPayload = await assemble({
      history: [request, reply, createMuxMessage("next", "user", "next", { historySequence: 10 })],
      tagHistoryItemIds: true,
    });
    expect(JSON.stringify(longPayload.messages.slice(0, shortPayload.messages.length))).toBe(
      JSON.stringify(shortPayload.messages)
    );
  });

  test("a hooked row keeps its hook context and still ends with its ID tag, merged or not", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6rNI3m): the tag must stay last on a row with hook context.
    const hooked = createMuxMessage("hooked", "user", "fix the bug", {
      historySequence: 7,
      pluginHookContext: [{ pluginId: "guard", text: "Ask first." }],
    });
    const next = createMuxMessage("next", "user", "now lint", { historySequence: 8 });
    const block = '<plugin-hook-context plugin="guard">\nAsk first.\n</plugin-hook-context>';
    const userText = async (history: MuxMessage[]) => {
      const payload = await assemble({ history, tagHistoryItemIds: true });
      return payload.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => (part.type === "text" ? part.text : "")).join("|")
        );
    };

    expect(await userText([hooked])).toEqual([`fix the bug\n${block}\n[id: 7]`]);
    // Merging keeps one text part per message, so the context must live inside it.
    expect(await userText([hooked, next])).toEqual([
      `fix the bug\n${block}\n[id: 7]\nnow lint\n[id: 8]`,
    ]);
  });

  test("token budget tags survive user-row merging but skip rows session_history hides", async () => {
    const snapshot = createMuxMessage("snapshot", "user", "file snapshot", {
      historySequence: 11,
      synthetic: true,
    });
    const request = createMuxMessage("request", "user", "fix the bug", { historySequence: 12 });
    const payload = await assemble({ history: [snapshot, request], tagHistoryItemIds: true });
    expect(JSON.stringify(payload.messages)).not.toContain("[id: 11]");
    expect(JSON.stringify(payload.messages)).toContain("[id: 12]");
  });
});

describe("measureVolatileSystemSuffix", () => {
  // The function is generic over the section list; "first" stands for any section before the warning.
  const first = "\n\n<first>f</first>";
  const warning = "\n\n[Warning: w]";
  const windowIds = "\n\n<context_window>c</context_window>";

  test("covers the trailing run of known sections, skipping absent ones", () => {
    expect(
      measureVolatileSystemSuffix("base" + first + warning + windowIds, [first, warning, windowIds])
    ).toBe((first + warning + windowIds).length);
    expect(
      measureVolatileSystemSuffix("base" + first + windowIds, [first, undefined, windowIds])
    ).toBe((first + windowIds).length);
    expect(measureVolatileSystemSuffix("base", [undefined, null, undefined])).toBe(0);
  });

  test("keeps sections that middleware moved or stripped in the stable part", () => {
    // Middleware appended text after the warning: nothing trails any more.
    expect(measureVolatileSystemSuffix("base" + first + warning + " extra", [first, warning])).toBe(
      0
    );
    // The first section was stripped (its separator stays): only the warning trails.
    expect(measureVolatileSystemSuffix("base\n\n" + warning, [first, warning])).toBe(
      warning.length
    );
  });

  test("never leaves an empty stable part", () => {
    expect(measureVolatileSystemSuffix(first + warning, [first, warning])).toBe(0);
  });
});

describe("buildPlanInstructions", () => {
  test("fails instead of dropping the plan handoff when the last agent is unreadable", async () => {
    using tempRoot = new DisposableTempDir("turn-context-plan-handoff-transport");
    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    const metadata: WorkspaceMetadata = {
      id: "ws-handoff",
      name: "workspace-handoff",
      projectName: "project-handoff",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };
    const planPath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, "The approved plan.");

    // #4438: an unreachable host while resolving the previous (plan) agent must not
    // silently send exec without the plan.
    class DroppedAgentsRuntime extends TestRuntime {
      override stat(filePath: string, abortSignal?: AbortSignal) {
        if (filePath.includes(`${path.sep}agents${path.sep}`)) {
          return Promise.reject(new RuntimeError("Connection refused", "network"));
        }
        return super.stat(filePath, abortSignal);
      }
    }
    const runtime = new DroppedAgentsRuntime(projectPath, xumHome);

    const outcome = await buildPlanInstructions({
      runtime,
      metadata,
      planLocation: localPlanLocation(runtime, metadata),
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryRuntime: runtime,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages: [
        createMuxMessage("a1", "assistant", "Here is the plan.", { agentId: "plan" }),
        createMuxMessage("u1", "user", "implement it"),
      ],
      runtimeFactory,
    }).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ type: "network" });
  });

  test("prepends runtime plan file guidance ahead of caller additional instructions", async () => {
    using tempRoot = new DisposableTempDir("turn-context-assembler");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });

    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "workspace-1",
      projectName: "project-1",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const runtime = new TestRuntime(projectPath, xumHome);
    const requestPayloadMessages = [createMuxMessage("u1", "user", "plan the fix")];
    const callerInstructions = "Caller-specific plan note";

    const expectedPlanFilePath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);

    const result = await buildPlanInstructions({
      runtime,
      metadata,
      planLocation: localPlanLocation(runtime, metadata),
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "plan",
      effectiveAgentId: "plan",
      agentIsPlanLike: true,
      agentDiscoveryRuntime: runtime,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: callerInstructions,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages,
      runtimeFactory,
    });

    expect(result.effectiveAdditionalInstructions).toContain(
      `Plan file path: ${expectedPlanFilePath}`
    );
    expect(result.effectiveAdditionalInstructions).toContain(callerInstructions);
    expect(result.effectiveAdditionalInstructions).toContain("propose_plan");
    expect(
      result.effectiveAdditionalInstructions?.indexOf(`Plan file path: ${expectedPlanFilePath}`)
    ).toBeLessThan(
      result.effectiveAdditionalInstructions?.indexOf(callerInstructions) ??
        Number.POSITIVE_INFINITY
    );
  });

  test("uses request payload history for Start Here detection", async () => {
    using tempRoot = new DisposableTempDir("turn-context-assembler");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });

    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "workspace-1",
      projectName: "project-1",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const runtime = new TestRuntime(projectPath, xumHome);

    const planFilePath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);
    await fs.mkdir(path.dirname(planFilePath), { recursive: true });
    await fs.writeFile(planFilePath, "# Plan\n\n- Keep implementing", "utf-8");

    const startHereSummary = createMuxMessage(
      "start-here",
      "assistant",
      "# Start Here\n\n- Existing plan context\n\n*Plan file preserved at:* /tmp/plan.md",
      {
        compacted: "user",
        agentId: "plan",
      }
    );

    const compactionBoundary = createMuxMessage("boundary", "assistant", "Compacted summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });

    const latestUserMessage = createMuxMessage("u1", "user", "continue implementation");

    const fullHistory = [startHereSummary, compactionBoundary, latestUserMessage];
    const requestPayloadMessages = sliceMessagesFromLatestCompactionBoundary(fullHistory);

    expect(requestPayloadMessages.map((message) => message.id)).toEqual(["boundary", "u1"]);

    const fromSlicedPayload = await buildPlanInstructions({
      runtime,
      metadata,
      planLocation: localPlanLocation(runtime, metadata),
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryRuntime: runtime,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages,
      runtimeFactory,
    });

    const fromFullHistory = await buildPlanInstructions({
      runtime,
      metadata,
      planLocation: localPlanLocation(runtime, metadata),
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryRuntime: runtime,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages: fullHistory,
      runtimeFactory,
    });

    expect(fromSlicedPayload.effectiveAdditionalInstructions).toContain(
      `A plan file exists at: ${fromSlicedPayload.planFilePath}`
    );
    expect(fromFullHistory.effectiveAdditionalInstructions).toBeUndefined();
  });
});

class RestrictedTestRuntime extends TestRuntime {
  constructor(
    projectPath: string,
    xumHomePath: string,
    private readonly readableRoot: string
  ) {
    super(projectPath, xumHomePath);
  }

  override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    const root = path.resolve(this.readableRoot);
    const target = path.resolve(filePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`RestrictedTestRuntime cannot read outside ${root}: ${target}`);
    }
    return super.readFile(filePath, abortSignal);
  }
}

describe("buildStreamSystemContext", () => {
  test("shares one instruction snapshot between the prompt, tool instructions, and rebuilds", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context-instruction-snapshot");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "xum-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });
    const agentsPath = path.join(projectPath, "AGENTS.md");
    const writeAgents = (version: string) =>
      fs.writeFile(
        agentsPath,
        [`Prompt guidance ${version}.`, "", "## Tool: bash", `Bash guidance ${version}.`, ""].join(
          "\n"
        )
      );
    await writeAgents("v1");

    const metadata = createWorkspaceMetadata({
      id: "instruction-snapshot-ws",
      name: "instruction-snapshot-workspace",
      projectName: "project",
      projectPath,
    });
    const buildArgs = {
      runtime: new TestRuntime(projectPath, xumHome),
      metadata,
      workspacePath: projectPath,
      cfg: createProjectsConfig({
        projectPath,
        workspaces: [{ id: metadata.id, name: metadata.name }],
      }),
      isSubagentWorkspace: false,
    };

    const first = await buildSystemContextForTest(buildArgs);
    expect(first.systemMessage).toContain("Prompt guidance v1.");
    const toolInstructions = extractToolInstructionsFromSources(
      first.instructionSources,
      "openai:gpt-5.2",
      metadata,
      first.agentSystemPromptSections
    );
    expect(toolInstructions.bash).toContain("Bash guidance v1.");

    // A rebuild within the same turn reuses the snapshot even if the file
    // changed meanwhile, so the prompt cannot disagree with tool descriptions.
    await writeAgents("v2");
    const rebuilt = await buildSystemContextForTest({
      ...buildArgs,
      instructionSources: first.instructionSources,
    });
    expect(rebuilt.instructionSources).toBe(first.instructionSources);
    expect(rebuilt.systemMessage).toContain("Prompt guidance v1.");
    expect(rebuilt.systemMessage).not.toContain("Prompt guidance v2.");

    // A new turn (no snapshot) reads the files again: nothing is cached across turns.
    const nextTurn = await buildSystemContextForTest(buildArgs);
    expect(nextTurn.systemMessage).toContain("Prompt guidance v2.");
  });

  test("fails instead of dropping the skills index when skill discovery fails in transport", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context-skills-transport");
    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "xum-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });

    // #4438: an unreachable host must fail the turn, not silently list no skills.
    class DroppedSkillsRuntime extends TestRuntime {
      override resolvePath(filePath: string): Promise<string> {
        if (path.basename(filePath) === "skills") {
          return Promise.reject(new RuntimeError("Connection refused", "network"));
        }
        return super.resolvePath(filePath);
      }
    }

    const metadata = createWorkspaceMetadata({
      id: "skills-transport-ws",
      name: "skills-transport-workspace",
      projectName: "project",
      projectPath,
    });
    const outcome = await buildSystemContextForTest({
      runtime: new DroppedSkillsRuntime(projectPath, xumHome),
      metadata,
      workspacePath: projectPath,
      cfg: createProjectsConfig({
        projectPath,
        workspaces: [{ id: metadata.id, name: metadata.name }],
      }),
      isSubagentWorkspace: false,
    }).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ type: "network" });
  });

  test("lists a plugin skill shadowed by a global skill under <plugin>:<skill> in the skills index", async () => {
    // Plugin skill namespaces: the model index must offer `pstack:tdd`, or the model
    // never learns the shadowed plugin skill exists.
    using tempRoot = new DisposableTempDir("stream-system-context-plugin-skill-namespace");
    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "xum-home");
    await fs.mkdir(projectPath, { recursive: true });
    const writeSkill = async (skillsRoot: string, description: string) => {
      await fs.mkdir(path.join(skillsRoot, "tdd"), { recursive: true });
      await fs.writeFile(
        path.join(skillsRoot, "tdd", "SKILL.md"),
        `---\nname: tdd\ndescription: ${description}\n---\nBody\n`
      );
    };
    await writeSkill(path.join(xumHome, "skills"), "global tdd");
    const pluginDir = path.join(xumHome, "plugins", "pstack");
    await writeSkill(path.join(pluginDir, "skills"), "pstack tdd");
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "pstack",
      })
    );

    const metadata = createWorkspaceMetadata({
      id: "plugin-skill-namespace-ws",
      name: "plugin-skill-namespace-workspace",
      projectName: "project",
      projectPath,
    });
    const { availableSkills } = await buildSystemContextForTest({
      runtime: new TestRuntime(projectPath, xumHome),
      metadata,
      workspacePath: projectPath,
      cfg: createProjectsConfig({
        projectPath,
        workspaces: [{ id: metadata.id, name: metadata.name }],
      }),
      isSubagentWorkspace: false,
    });

    const byName = new Map(availableSkills?.map((skill) => [skill.name, skill.description]));
    expect(byName.get("tdd")).toBe("global tdd");
    expect(byName.get("pstack:tdd")).toBe("pstack tdd");
  });

  test("reads instruction files while agent discovery is still in flight", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context-parallel-reads");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "xum-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });
    await fs.writeFile(path.join(projectPath, "AGENTS.md"), "Project guidance.\n");

    const events: string[] = [];
    let markInstructionRead!: () => void;
    const instructionRead = new Promise<void>((resolve) => {
      markInstructionRead = resolve;
    });
    // Agent-root resolution waits (bounded) for an AGENTS.md read. Sequential
    // assembly only reads instructions after discovery finishes, so it hits
    // the fallback and records the read after the release.
    class OrderingRuntime extends TestRuntime {
      override async resolvePath(filePath: string): Promise<string> {
        if (path.basename(filePath) === "agents") {
          events.push("agent-scan");
          await Promise.race([instructionRead, new Promise((resolve) => setTimeout(resolve, 250))]);
          events.push("agent-scan-released");
        }
        return super.resolvePath(filePath);
      }

      override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
        if (filePath === path.join(projectPath, "AGENTS.md")) {
          events.push("instruction-read");
          markInstructionRead();
        }
        return super.readFile(filePath, abortSignal);
      }
    }

    const metadata = createWorkspaceMetadata({
      id: "parallel-reads-ws",
      name: "parallel-reads-workspace",
      projectName: "project",
      projectPath,
    });
    const result = await buildSystemContextForTest({
      runtime: new OrderingRuntime(projectPath, xumHome),
      metadata,
      workspacePath: projectPath,
      cfg: createProjectsConfig({
        projectPath,
        workspaces: [{ id: metadata.id, name: metadata.name }],
      }),
      isSubagentWorkspace: false,
    });

    expect(result.systemMessage).toContain("Project guidance.");
    expect(events).toContain("agent-scan");
    expect(events.indexOf("instruction-read")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("instruction-read")).toBeLessThan(events.indexOf("agent-scan-released"));
  });

  test("includes proactive memory guidance only when the memory tool is available", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context-memory-guidance");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "memory-guidance-ws",
      name: "memory-guidance-workspace",
      projectName: "project",
      projectPath,
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [{ id: metadata.id, name: metadata.name }],
    });
    const buildArgs = {
      runtime: new TestRuntime(projectPath, xumHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: false,
    };

    const withMemory = await buildSystemContextForTest({
      ...buildArgs,
      memoryToolAvailable: true,
    });
    expect(withMemory.systemMessage).toContain("<memory-tool-guidance>");
    const memorySection = (text: string) =>
      text.split("<memory-tool-guidance>")[1].split("</memory-tool-guidance>")[0].split("\n");
    const pluginContext = "\nPlugin-specific context to preserve.";
    // Late middleware that keeps the memory tool leaves the prompt untouched.
    expect(removeMemoryGuidance(withMemory.systemMessage + pluginContext, true)).toBe(
      withMemory.systemMessage + pluginContext
    );
    const lateMemoryDenied = removeMemoryGuidance(withMemory.systemMessage + pluginContext, false);
    expect(lateMemoryDenied).not.toContain("<memory-tool-guidance>");
    expect(lateMemoryDenied).toContain(pluginContext);

    // Guidance must stay in lockstep with tool availability: a prompt must
    // not steer the agent toward a tool the toolset does not have.
    const withoutMemory = await buildSystemContextForTest(buildArgs);
    expect(withoutMemory.systemMessage).not.toContain("<memory-tool-guidance>");
    const writable = await buildSystemContextForTest({
      ...buildArgs,
      memoryToolAvailable: true,
      tokenBudgetEnabled: true,
      workspaceMemoryWritable: true,
    });
    const readOnly = await buildSystemContextForTest({
      ...buildArgs,
      memoryToolAvailable: true,
      tokenBudgetEnabled: true,
      workspaceMemoryWritable: false,
    });
    const noMemory = await buildSystemContextForTest({
      ...buildArgs,
      memoryToolAvailable: false,
      tokenBudgetEnabled: true,
      workspaceMemoryWritable: true,
    });
    const guidanceSection = (text: string) =>
      text.split("<context-window-guidance>")[1]?.split("</context-window-guidance>")[0];
    const guidance = guidanceSection(writable.systemMessage);
    expect(guidance).toBeDefined();
    // Every agent may write its session checkpoint, so read-only agents get the same guidance.
    expect(guidanceSection(readOnly.systemMessage)).toBe(guidance);
    // The checkpoint lives in memory, so the guidance leaves with the memory tool.
    expect(guidanceSection(noMemory.systemMessage)).toBeUndefined();
    expect(guidanceSection(withMemory.systemMessage)).toBeUndefined();
    expect(memorySection(readOnly.systemMessage)).not.toEqual(
      memorySection(writable.systemMessage)
    );
    for (const systemMessage of [readOnly.systemMessage, writable.systemMessage]) {
      const filtered = removeMemoryGuidance(systemMessage + pluginContext, false);
      expect(filtered).not.toContain("<memory-tool-guidance>");
      expect(guidanceSection(filtered)).toBeUndefined();
      expect(filtered).toContain(pluginContext);
    }
  });

  test("uses the resolved agent discovery runtime for parent-only subagent prompts", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context-parent-runtime");

    const projectPath = path.join(tempRoot.path, "project");
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    const xumHome = path.join(tempRoot.path, "mux-home");
    const customAgentId = "parent-only-reviewer";
    await fs.mkdir(path.join(parentPath, ".mux", "agents"), { recursive: true });
    await fs.mkdir(childPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });
    await fs.writeFile(
      path.join(parentPath, ".mux", "agents", `${customAgentId}.md`),
      [
        "---",
        "name: Parent Only Reviewer",
        "subagent:",
        "  runnable: true",
        "---",
        "Parent-only reviewer prompt body.",
        "",
      ].join("\n")
    );

    const metadata = createWorkspaceMetadata({
      id: "child-ws",
      name: "child-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "parent-ws",
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [
        { id: "parent-ws", name: "parent-workspace" },
        { id: metadata.id, name: metadata.name, parentWorkspaceId: metadata.parentWorkspaceId },
      ],
    });

    const result = await buildStreamSystemContext({
      runtime: new RestrictedTestRuntime(childPath, xumHome, childPath),
      metadata,
      workspacePath: childPath,
      workspaceId: metadata.id,
      agentDefinition: { id: customAgentId, scope: "project" },
      effectiveMode: "exec",
      agentDiscoveryRuntime: new RestrictedTestRuntime(parentPath, xumHome, parentPath),
      agentDiscoveryPath: parentPath,
      isSubagentWorkspace: true,
      effectiveAdditionalInstructions: undefined,
      modelString: "openai:gpt-5.2",
      cfg,
      providersConfig: null,
      runtimeFactory,
    });

    expect(result.agentSystemPromptSections.join("\n\n")).toContain(
      "Parent-only reviewer prompt body."
    );
  });

  const ancestorPlanCases: Array<{
    name: string;
    parentWorkspaceId?: string;
    otherWorkspaces: Array<{ id: string; name: string; parentWorkspaceId?: string }>;
    isSubagentWorkspace?: boolean;
    note?: string;
    activePlanFrom?: string;
    expectedAncestors: string[];
  }> = [
    {
      name: "includes the direct parent plan path ahead of caller instructions",
      parentWorkspaceId: "parent-ws",
      otherWorkspaces: [{ id: "parent-ws", name: "parent-workspace" }],
      note: "Caller-specific note",
      expectedAncestors: ["parent-workspace"],
    },
    {
      name: "lists nested ancestor plan paths in nearest-parent-first order",
      parentWorkspaceId: "child-ws",
      otherWorkspaces: [
        { id: "parent-ws", name: "parent-workspace" },
        { id: "child-ws", name: "child-workspace", parentWorkspaceId: "parent-ws" },
      ],
      expectedAncestors: ["child-workspace", "parent-workspace"],
    },
    {
      name: "omits ancestor plan paths for top-level workspaces",
      otherWorkspaces: [],
      isSubagentWorkspace: false,
      note: "Top-level note",
      expectedAncestors: [],
    },
    {
      name: "omits the ancestor section when the parent metadata is missing",
      parentWorkspaceId: "missing-parent-ws",
      otherWorkspaces: [],
      note: "Existing note",
      expectedAncestors: [],
    },
    {
      name: "dedupes ancestor plan paths that are already covered by the active plan file",
      parentWorkspaceId: "parent-ws",
      otherWorkspaces: [{ id: "parent-ws", name: "parent-workspace" }],
      activePlanFrom: "parent-workspace",
      expectedAncestors: [],
    },
    {
      name: "truncates cyclic ancestry without crashing",
      parentWorkspaceId: "parent-ws",
      otherWorkspaces: [
        { id: "parent-ws", name: "parent-workspace", parentWorkspaceId: "self-ws" },
      ],
      expectedAncestors: ["parent-workspace"],
    },
  ];

  for (const testCase of ancestorPlanCases) {
    test(testCase.name, async () => {
      using tempRoot = new DisposableTempDir("stream-system-context");

      const projectPath = path.join(tempRoot.path, "project");
      const xumHome = path.join(tempRoot.path, "mux-home");
      await fs.mkdir(projectPath, { recursive: true });
      await fs.mkdir(xumHome, { recursive: true });

      const metadata = createWorkspaceMetadata({
        id: "self-ws",
        name: "self-workspace",
        projectName: "project",
        projectPath,
        ...(testCase.parentWorkspaceId != null
          ? { parentWorkspaceId: testCase.parentWorkspaceId }
          : {}),
      });
      const cfg = createProjectsConfig({
        projectPath,
        workspaces: [
          ...testCase.otherWorkspaces,
          {
            id: metadata.id,
            name: metadata.name,
            ...(testCase.parentWorkspaceId != null
              ? { parentWorkspaceId: testCase.parentWorkspaceId }
              : {}),
          },
        ],
      });

      const activePlanPath =
        testCase.activePlanFrom != null
          ? getPlanFilePath(testCase.activePlanFrom, "project", xumHome)
          : undefined;
      const result = await buildSystemContextForTest({
        runtime: new TestRuntime(projectPath, xumHome),
        metadata,
        workspacePath: projectPath,
        cfg,
        isSubagentWorkspace: testCase.isSubagentWorkspace ?? true,
        ...(testCase.note != null ? { effectiveAdditionalInstructions: testCase.note } : {}),
        ...(activePlanPath != null ? { planFilePath: activePlanPath } : {}),
      });

      const expectedPaths = testCase.expectedAncestors.map((name) =>
        getPlanFilePath(name, "project", xumHome)
      );
      expect(result.ancestorPlanFilePaths).toEqual(expectedPaths);
      // The workspace's own plan must never list as its ancestor (covers cycles).
      expect(result.systemMessage).not.toContain(`- ${metadata.name}:`);
      if (expectedPaths.length === 0) {
        expect(result.systemMessage).not.toContain(
          "Ancestor plan file paths (nearest parent first):"
        );
        if (activePlanPath != null) {
          expect(result.systemMessage).not.toContain(activePlanPath);
        }
      } else {
        expect(result.systemMessage).toContain("Ancestor plan file paths (nearest parent first):");
        expect(result.systemMessage).toContain(
          "If useful for broader context, you may read these ancestor/parent plan files:"
        );
        const indices = testCase.expectedAncestors.map((name, i) => {
          const line = `- ${name}: ${expectedPaths[i]}`;
          expect(result.systemMessage).toContain(line);
          return result.systemMessage.indexOf(line);
        });
        expect([...indices].sort((a, b) => a - b)).toEqual(indices);
      }
      if (testCase.note != null) {
        expect(result.systemMessage).toContain(testCase.note);
        if (expectedPaths.length > 0) {
          expect(result.systemMessage.indexOf(expectedPaths[0])).toBeLessThan(
            result.systemMessage.indexOf(testCase.note)
          );
        }
      }
    });
  }

  // #5174: SSH ancestors are listed by their installation-scoped path only. One from an older build
  // that has not migrated yet is left out (its plan is not at that path yet), and a turn never
  // points the agent at a legacy plan file.
  test("lists migrated SSH ancestors by their installation-scoped path, and no legacy path", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context");
    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    const ssh = { type: "ssh", host: "box", srcBaseDir: "~/xum" } as const;
    const metadata = createWorkspaceMetadata({
      id: "self-ws",
      name: "self-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "child-ws",
    });
    const row = (id: string, name: string, extra: Record<string, unknown>) => ({
      path: path.join(projectPath, name),
      id,
      name,
      runtimeConfig: ssh,
      ...extra,
    });
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              row("parent-ws", "parent-workspace", {}),
              row("child-ws", "child-workspace", {
                parentWorkspaceId: "parent-ws",
                remotePlanMigrated: true,
              }),
            ],
          },
        ],
      ]),
    };
    const installationId = "00000000-0000-4000-8000-000000000001";
    const scoped = (name: string) =>
      `${xumHome}/plans/installation-${installationId}/${createRemoteProjectId(projectPath)}/${name}.md`;

    const result = await buildStreamSystemContext({
      runtime: new TestRuntime(projectPath, xumHome),
      metadata: { ...metadata, runtimeConfig: ssh },
      workspacePath: projectPath,
      workspaceId: metadata.id,
      agentDefinition: { id: "exec", scope: "built-in" },
      effectiveMode: "exec",
      agentDiscoveryRuntime: new TestRuntime(projectPath, xumHome),
      agentDiscoveryPath: projectPath,
      isSubagentWorkspace: true,
      effectiveAdditionalInstructions: undefined,
      installationId,
      modelString: "openai:gpt-5.2",
      cfg,
      providersConfig: null,
      runtimeFactory,
    });

    expect(result.ancestorPlanFilePaths).toEqual([scoped("child-workspace")]);
  });
});
