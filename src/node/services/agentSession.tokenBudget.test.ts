import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import * as budgetCounting from "./contextBudgetCounting";
import type { MCPServerManager } from "./mcpServerManager";
import { eventSpine } from "./events/eventSpine";
import { restoreContextBudgetRejectedMessageForDisplay } from "@/common/utils/messages/contextBudgetRejection";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Err, Ok, type Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type { SessionContextController } from "./contextManagement/sessionContextController";
import { prepareProviderRequestMessages } from "./turnContextAssembler";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { applyToolPolicyToNames } from "@/common/utils/tools/toolPolicy";
import {
  CONTEXT_CONTINUE_DEDUPE_KEY,
  CONTEXT_WARNING_DEDUPE_KEY,
  FLUSH_MAX_OUTPUT_TOKENS,
} from "@/common/constants/contextBudget";
import type { AgentSessionAIService } from "./agentSession";
import { CompactionCancellation } from "./compactionCancellation";
import { HistoryService } from "./historyService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import {
  createAgentSessionHarness,
  seedAutoCompactionThreshold,
  type AgentSessionHarness,
} from "./agentSession.testHarness";
import { createTurnCompletionController, type SettledStepBudget } from "./streamManager";
import {
  createContextBudgetWarning,
  createRolloverPrefix,
  type ContextWindowRollover,
} from "./contextWindowRollover";
import * as rolloverMessages from "./contextWindowRollover";
import * as contextLimits from "@/common/utils/compaction/contextLimit";
import { CompactionPendingState } from "./compactionPendingState";
import { POST_COMPACTION_STATE_FILENAME } from "@/constants/compaction";
import { log } from "./log";

const workspaceId = "token-budget-session";
const model = "openai:gpt-4o";
/** Persist the slider value (percent) for the test model, as the UI would. */
const seedThreshold = (h: AgentSessionHarness, fraction: number) =>
  seedAutoCompactionThreshold(h.config, model, Math.round(fraction * 100));
const options: SendMessageOptions = {
  model,
  agentId: "exec",
  experiments: { tokenBudget: true },
};
// Dispatch and resume re-validate memory writability from the caller's options; the harness has
// no backend experiment service, so these paths state the Memory experiment explicitly.
const resumeOptions: SendMessageOptions = {
  ...options,
  experiments: { tokenBudget: true, memory: true },
};
const correlation = {
  type: "workspace-turn-task",
  taskHandleId: "wst_budget",
  ownerWorkspaceId: "parent",
  turnId: "delegated-turn",
} as const;
type Request = Parameters<AgentSessionAIService["streamMessage"]>[0];

function trackedFilePaths(h: AgentSessionHarness): string[] {
  return (h.session as unknown as { fileChangeTracker: { paths: string[] } }).fileChangeTracker
    .paths;
}

/** Budget state lives on the controller-private token-budget strategy, not the session. */
function budgetOf(h: AgentSessionHarness) {
  return Reflect.get(Reflect.get(h.session, "contextController") as object, "tokenBudget") as {
    contextBudgetGeneration: number;
    contextBudgetWarningClaimed: boolean;
    contextBudgetHandoffClaimed: boolean;
    contextBudgetFlushClaimed: boolean;
    contextBudgetHistoryAvailable: boolean;
  };
}

function text(row: MuxMessage): string {
  return row.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function step(inputTokens: number, overrides?: Partial<SettledStepBudget>): SettledStepBudget {
  return {
    model,
    usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
    toolResultChars: 0,
    imageParts: 0,
    sessionHistoryAvailable: true,
    memoryWritable: true,
    ...overrides,
  };
}

function rolloverRows(rows: MuxMessage[]): MuxMessage[] {
  return rows.filter((row) => row.metadata?.muxMetadata?.type === "context-window-rollover");
}

function warningRows(rows: MuxMessage[]): MuxMessage[] {
  return rows.filter((row) => row.metadata?.muxMetadata?.type === "context-budget-warning");
}

function isFinalFlushRow(row: MuxMessage): boolean {
  const meta = row.metadata?.muxMetadata;
  return meta?.type === "context-budget-warning" && meta.final === true;
}

function isHandoffRow(row: MuxMessage): boolean {
  const meta = row.metadata?.muxMetadata;
  return meta?.type === "context-budget-warning" && meta.handoff === true;
}

/** Per-window advisory claims; set only once a row is durable, never by pending intent. */
function budgetClaims(h: AgentSessionHarness): { warning: boolean; handoff: boolean } {
  const budget = budgetOf(h);
  return {
    warning: budget.contextBudgetWarningClaimed,
    handoff: budget.contextBudgetHandoffClaimed,
  };
}

async function emitUsageDelta(h: AgentSessionHarness & { requests: unknown[] }) {
  h.aiEmitter.emit("usage-delta", {
    type: "usage-delta",
    workspaceId,
    messageId: `assistant-${h.requests.length}`,
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
  });
  // The forwarded handler awaits usage bookkeeping before previewing.
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function allRows(h: AgentSessionHarness): Promise<MuxMessage[]> {
  const rows: MuxMessage[] = [];
  const result = await h.historyService.iterateFullHistory(workspaceId, "forward", (batch) => {
    rows.push(...batch);
  });
  if (!result.success) throw new Error(result.error);
  return rows;
}

async function seedHistory(h: AgentSessionHarness, inputTokens: number, toolResultChars = 0) {
  const last = createMuxMessage("old-answer", "assistant", "Completed old work", {
    model,
    contextUsage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
    stepStartPartIndices: [0, 1],
  });
  if (toolResultChars > 0) {
    last.parts.push({
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "completed-side-effect",
      state: "output-available",
      input: { script: "produce-result" },
      output: "x".repeat(toolResultChars),
    });
  }
  // A low first-request floor separates growing history from an oversized system prompt.
  const result = await h.historyService.appendManyToHistory(workspaceId, [
    createMuxMessage("old-user", "user", "Previous user request"),
    createMuxMessage("first-answer", "assistant", "First answer", {
      model,
      contextUsage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
    }),
    last,
  ]);
  expect(result.success).toBe(true);
}

const LEGACY_FLUSH_TRIGGER = "Flush context notes now.";

/**
 * Rows an older build left behind after offering its final pre-rollover flush: the durable final
 * warning plus the hidden trigger it dispatched (old context precedes them). New windows never
 * write these; recovery must still finish them as one bounded step that seals the window.
 */
async function seedLegacyFlushTurn(
  h: AgentSessionHarness,
  metadata?: Pick<MuxMetadata, "muxMetadata" | "kind" | "goalId">
) {
  await seedHistory(h, 110_000);
  const result = await h.historyService.appendManyToHistory(workspaceId, [
    createContextBudgetWarning({
      contextTokens: 110_010,
      maxTokens: 128_000,
      // Older builds budgeted the slider's force band, not the usable ceiling.
      budgetTokens: 96_000,
      memoryWritable: true,
      sessionHistoryAvailable: true,
      final: true,
    }),
    createMuxMessage("legacy-flush-trigger", "user", LEGACY_FLUSH_TRIGGER, {
      synthetic: true,
      uiVisible: false,
      retrySendOptions: { model, agentId: "exec", agentInitiated: true },
      ...metadata,
      muxMetadata: {
        ...(metadata?.muxMetadata ?? { type: "normal" }),
        contextBudgetContinuation: true,
        contextBudgetFlush: true,
      },
    }),
  ]);
  expect(result.success).toBe(true);
}

describe("AgentSession token-budget lifecycle", () => {
  const harnesses: AgentSessionHarness[] = [];
  const storageCleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const h of harnesses.reverse()) {
      await h.session.dispose();
      await h.cleanup();
    }
    harnesses.length = 0;
    for (const cleanup of storageCleanups.splice(0)) await cleanup();
    mock.restore();
  });

  async function setup(args?: {
    previous?: AgentSessionHarness;
    mcpServerManager?: MCPServerManager;
    failure?: (
      attempt: number
    ) => SendMessageError | undefined | Promise<SendMessageError | undefined>;
    /** Inject a real goal service (no goal set) whose stream accounting the test observes. */
    goals?: boolean;
  }) {
    let storage: Pick<AgentSessionHarness, "historyService" | "config"> | undefined =
      args?.previous;
    if (!storage && args?.goals) {
      const owned = await createTestHistoryService();
      storageCleanups.push(owned.cleanup);
      storage = owned;
    }
    const workspaceGoalService =
      args?.goals && storage
        ? new WorkspaceGoalService(
            storage.config,
            storage.historyService,
            new ExtensionMetadataService(
              path.join(storage.config.rootDir, "extension-metadata.json")
            )
          )
        : undefined;
    const goalAccounting = workspaceGoalService && {
      recordStreamAccounting: spyOn(workspaceGoalService, "recordStreamAccounting"),
      previewStreamAccounting: spyOn(workspaceGoalService, "previewStreamAccounting"),
    };
    const requests: Request[] = [];
    const secondRequest = Promise.withResolvers<Request>();
    const requestWaiters = new Map<number, ReturnType<typeof Promise.withResolvers<Request>>>();
    const waitForRequest = (count: number) => {
      let waiter = requestWaiters.get(count);
      if (!waiter) {
        waiter = Promise.withResolvers<Request>();
        requestWaiters.set(count, waiter);
        if (requests.length >= count) waiter.resolve(requests[count - 1]);
      }
      return waiter.promise;
    };
    const completions: Array<ReturnType<typeof createTurnCompletionController>> = [];
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(async (request) => {
      requests.push(request);
      if (requests.length === 2) secondRequest.resolve(request);
      const error = await args?.failure?.(requests.length);
      if (error) return Err(error);
      h.aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: `assistant-${requests.length}`,
        model: request.modelString,
        startTime: Date.now(),
      });
      const completion = createTurnCompletionController();
      completions.push(completion);
      requestWaiters.get(requests.length)?.resolve(request);
      // This controlled provider has no engine supervisor; shutdown still retires its handle.
      const close = () => completion.settle({ status: "aborted", abortReason: "system" });
      const signal = h.session.closingSignal;
      if (signal.aborted) close();
      else signal.addEventListener("abort", close, { once: true });
      return Ok({
        messageId: `assistant-${requests.length}`,
        completion: completion.promise.finally(() => signal.removeEventListener("abort", close)),
      });
    });
    const h = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      historyService: storage?.historyService,
      config: storage?.config,
      mcpServerManager: args?.mcpServerManager,
      workspaceGoalService,
      aiServiceOverrides: {
        streamMessage,
        buildMemorySessionContext: mock(() => Promise.resolve(null)),
      },
    });
    harnesses.push(h);
    spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Ok({
        id: workspaceId,
        name: "budget",
        projectName: "project",
        projectPath: h.config.rootDir,
        namedWorkspacePath: h.config.rootDir,
        runtimeConfig: { type: "local" },
      } as FrontendWorkspaceMetadata)
    );
    await seedThreshold(h, 0.7);
    const settleStream = (
      index: number,
      metadata?: { finishReason?: string; contextUsage?: { inputTokens: number } }
    ) => {
      const contextUsage = metadata?.contextUsage
        ? {
            ...metadata.contextUsage,
            outputTokens: 10,
            totalTokens: metadata.contextUsage.inputTokens + 10,
          }
        : undefined;
      completions[index].settle({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: {
            model,
            agentId: "exec",
            finishReason: metadata?.finishReason ?? "tool-calls",
            ...(contextUsage ? { contextUsage } : {}),
          },
          parts: [],
        },
      });
    };
    const finishAndDispatch = async () => {
      settleStream(0);
      await secondRequest.promise;
    };
    return {
      ...h,
      goalAccounting,
      requests,
      completions,
      streamMessage,
      secondRequest,
      finishAndDispatch,
      settleStream,
      waitForRequest,
    };
  }

  test("manual compaction publishes a summary and clears globally enabled token-budget state", async () => {
    const h = await setup();
    spyOn(h.aiService, "isExperimentEnabled").mockImplementation(
      (id) => id === EXPERIMENT_IDS.TOKEN_BUDGET
    );
    await seedHistory(h, 20_000);
    const state = budgetOf(h);
    state.contextBudgetWarningClaimed = true;
    state.contextBudgetFlushClaimed = true;
    const generation = state.contextBudgetGeneration;
    expect(
      (
        await h.session.sendMessage("Summarize the conversation", {
          model,
          agentId: "compact",
          muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
        })
      ).success
    ).toBe(true);
    expect(state.contextBudgetGeneration).toBeGreaterThan(generation);
    expect(state.contextBudgetWarningClaimed).toBe(false);
    expect(state.contextBudgetFlushClaimed).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].onStepSettled).toBeUndefined();
    h.completions[0].settle({
      status: "completed",
      streamEnd: {
        type: "stream-end",
        workspaceId,
        parts: [{ type: "text", text: "The earlier task is complete; preserve its decisions." }],
        metadata: { model, agentId: "compact", finishReason: "stop" },
      },
    });
    await h.session.waitForIdle();
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success);
    expect(history.data.filter((row) => row.metadata?.compactionBoundary)).toHaveLength(1);
    expect(history.data[0].metadata?.compacted).toBe("user");
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
    expect(h.requests).toHaveLength(1);
  });

  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationInputTokens",
  ]) {
    test.each(["invalid", "1000", -1, {}, [10], true, 1e100])(
      `invalid persisted ${field}=%j does not block subsequent sends`,
      async (invalid) => {
        const h = await setup();
        expect(
          (
            await h.historyService.appendToHistory(
              workspaceId,
              createMuxMessage("user", "user", "Previous request")
            )
          ).success
        ).toBe(true);
        const damaged = {
          ...createMuxMessage("damaged-usage", "assistant", "Preserved answer"),
          metadata: {
            model,
            historySequence: 1,
            ...(field === "cacheCreationInputTokens"
              ? { contextProviderMetadata: { anthropic: { cacheCreationInputTokens: invalid } } }
              : {}),
            contextUsage: {
              inputTokens: 1000,
              outputTokens: 10,
              totalTokens: 1010,
              [field]: invalid,
            },
          },
        };
        await fs.appendFile(
          path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"),
          JSON.stringify(damaged) + "\n"
        );
        expect((await h.session.sendMessage("Short follow-up", options)).success).toBe(true);
        expect(h.requests).toHaveLength(1);
        expect(rolloverRows(await allRows(h))).toHaveLength(0);
        expect(h.requests[0].messages.some((row) => text(row) === "Preserved answer")).toBe(true);
      }
    );
  }

  test.each([undefined, null, {}, "invalid", 42])(
    "a persisted assistant with unreadable parts=%j cannot brick the next send",
    async (parts) => {
      const h = await setup();
      await seedHistory(h, 20_000);
      const damaged = {
        id: "damaged-parts",
        role: "assistant",
        parts,
        metadata: {
          model,
          historySequence: 3,
          contextUsage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
        },
      };
      const historyPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
      const raw = JSON.stringify(damaged) + "\n";
      await fs.appendFile(historyPath, raw);
      expect((await h.session.sendMessage("Continue past the damaged row", options)).success).toBe(
        true
      );
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].messages.some((row) => row.id === damaged.id)).toBe(false);
      expect(h.requests[0].messages.some((row) => row.id === "old-answer")).toBe(true);
      expect(await fs.readFile(historyPath, "utf8")).toContain(raw);
    }
  );

  test.each(["large-first-prompt", "compaction-summary"] as const)(
    "historical input usage is not a system floor for the next request (%s)",
    async (kind) => {
      const h = await setup();
      await seedThreshold(h, 1);
      const previous = createMuxMessage("high-input-answer", "assistant", "Small useful response", {
        model,
        contextUsage: { inputTokens: 125_000, outputTokens: 20, totalTokens: 125_020 },
        stepStartPartIndices: [0],
        ...(kind === "compaction-summary"
          ? {
              compacted: "user" as const,
              compactionEpoch: 1,
              muxMetadata: { type: "compaction-summary" as const },
            }
          : {}),
      });
      expect(
        (
          await h.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("old-user", "user", "Prior request"),
            previous,
          ])
        ).success
      ).toBe(true);
      expect((await h.session.sendMessage("Small fitting follow-up", options)).success).toBe(true);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].messages.some((row) => row.id === previous.id)).toBe(true);
      h.completions[0].settle({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model, agentId: "exec", finishReason: "stop" },
          parts: [],
        },
      });
      await h.session.waitForIdle();
      expect(await h.session.sendMessage("oversized ".repeat(60_000), options)).toMatchObject({
        success: false,
        error: { type: "context_budget_blocked" },
      });
      expect(h.requests).toHaveLength(1);
    }
  );

  test("queued context-budget rejection persists once without restoring a duplicate draft", async () => {
    const h = await setup();
    const failed = Promise.withResolvers<void>();
    h.session.queueMessage("oversized ".repeat(60_000), options, {
      onAcceptedPreStreamFailure: () => failed.resolve(),
    });
    h.session.sendQueuedMessages();
    await failed.promise;
    await h.session.waitForIdle();
    const rows = await allRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata?.contextBudgetRejected).toBe(true);
    expect(h.events.filter((event) => event.type === "restore-to-input")).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  test.each([false, true])(
    "a rejected tail never retries the older completed turn after restart (legacy=%s)",
    async (legacy) => {
      const first = await setup();
      await seedHistory(first, 20_000);
      const previous = await allRows(first);
      expect((await first.session.sendMessage("oversized ".repeat(60_000), options)).success).toBe(
        false
      );
      const rejected = (await allRows(first)).at(-1)!;
      expect(rejected.metadata?.contextBudgetRejected).toBe(true);
      expect(rejected.role).toBe("assistant");
      expect(rejected.parts).toEqual([]);
      expect(rejected.metadata?.partial).not.toBe(true);
      if (legacy) {
        // Seed the preceding flag-only representation to retain upgrade compatibility.
        expect(
          (
            await first.historyService.updateHistory(
              workspaceId,
              createMuxMessage(rejected.id, "user", "Legacy rejected request", {
                historySequence: rejected.metadata?.historySequence,
                timestamp: rejected.metadata?.timestamp,
                contextBudgetRejected: true,
              })
            )
          ).success
        ).toBe(true);
      }
      await first.session.dispose();
      const h = await setup({ previous: first });
      await h.session.ensureStartupAutoRetryCheck();
      expect(h.events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
      expect((await h.session.resumeStream(options)).success).toBe(false);
      expect(h.requests).toHaveLength(0);
      expect((await allRows(h)).filter((row) => previous.some((old) => old.id === row.id))).toEqual(
        previous
      );
      expect((await h.session.sendMessage("A genuinely new request", options)).success).toBe(true);
      expect(h.requests).toHaveLength(1);
    }
  );

  test("single-user token-budget sends use append-only storage even when automatic compaction is off", async () => {
    const h = await setup();
    await seedThreshold(h, 1);
    await seedHistory(h, 20_000);
    const before = await allRows(h);
    const append = spyOn(h.historyService, "acceptCompactionReplacement");
    const batch = spyOn(h.historyService, "appendManyToHistory");
    expect((await h.session.sendMessage("Ordinary next request", options)).success).toBe(true);
    expect(batch).not.toHaveBeenCalled();
    expect(
      append.mock.calls.some(
        ([, , operation]) =>
          operation.kind === "append" &&
          operation.messages.some((row) => text(row) === "Ordinary next request")
      )
    ).toBe(true);
    expect((await allRows(h)).slice(0, before.length)).toEqual(before);
    expect(h.requests).toHaveLength(1);
  });

  test("a failed single-user append preserves old history and does not dispatch", async () => {
    const h = await setup();
    const before = await allRows(h);
    spyOn(h.historyService, "acceptCompactionReplacement").mockResolvedValueOnce(Err("disk full"));
    expect((await h.session.sendMessage("Not durably accepted", options)).success).toBe(false);
    expect(await allRows(h)).toEqual(before);
    expect(h.requests).toHaveLength(0);
  });

  test("cancellation after a single-user append rolls back only that request", async () => {
    const h = await setup();
    await seedHistory(h, 20_000);
    const before = await allRows(h);
    const controller = new AbortController();
    const cancelState = { canceledBeforeAcceptance: false };
    const append = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
      async (...args) => {
        const result = await append(...args);
        controller.abort();
        return result;
      }
    );
    expect(
      (
        await h.session.sendMessage("Cancel after persistence", options, {
          acceptanceOrigin: "automatic",
          cancelSignal: controller.signal,
          cancelState,
        })
      ).success
    ).toBe(true);
    expect(cancelState.canceledBeforeAcceptance).toBe(true);
    expect(await allRows(h)).toEqual(before);
    expect(h.requests).toHaveLength(0);
  });

  test.each(["global", "workspace", "benign"] as const)(
    "uncertified %s middleware blocks rollover before cleanup or provider dispatch",
    async (scope) => {
      const h = await setup();
      await seedHistory(h, 120_000);
      const cleanup = spyOn(h.session, "applyContextResetSideEffects");
      const unregister = eventSpine.useBefore(
        "request.assemble",
        (ctx) => {
          if (scope !== "benign") delete ctx.tools.session_history;
        },
        scope === "global" ? undefined : { workspaceId }
      );
      try {
        expect(await h.session.sendMessage("Keep history reachable", options)).toMatchObject({
          success: false,
          error: { type: "context_budget_blocked" },
        });
        expect(cleanup).not.toHaveBeenCalled();
        expect(rolloverRows(await allRows(h))).toHaveLength(0);
        expect(h.requests).toHaveLength(0);
      } finally {
        unregister();
      }
    }
  );

  test.each(["empty", "internal-only"] as const)(
    "uncertified middleware does not block an already fresh %s window",
    async (contents) => {
      const h = await setup();
      await seedRolloverEligibilityState(h, contents);
      const unregister = eventSpine.useBefore("request.assemble", () => undefined);
      try {
        expect((await h.session.sendMessage("x".repeat(350_000), options)).success).toBe(true);
        expect(h.requests[0].requestAssemblySnapshot).toBeUndefined();
      } finally {
        unregister();
      }
    }
  );

  test("middleware explicitly scoped to another workspace does not block rollover", async () => {
    const h = await setup();
    await seedHistory(h, 120_000);
    const unregister = eventSpine.useBefore(
      "request.assemble",
      (ctx) => {
        delete ctx.tools.session_history;
      },
      { workspaceId: "other-workspace" }
    );
    try {
      expect((await h.session.sendMessage("Continue safely", options)).success).toBe(true);
      expect(h.requests[0].requestAssemblySnapshot?.preservesToolset).toBe(true);
      expect(rolloverRows(await allRows(h))).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  test.each(["cleanup", "append"] as const)(
    "admitted request snapshot survives registry changes during %s",
    async (phase) => {
      const h = await setup();
      await seedHistory(h, 120_000);
      const unregisters: Array<() => void> = [];
      const admitted = eventSpine.useRequestContext(
        (ctx) => {
          ctx.systemMessage += " admitted";
        },
        { workspaceId }
      );
      unregisters.push(admitted);
      const replaceRegistration = () => {
        admitted();
        unregisters.push(
          eventSpine.useBefore(
            "request.assemble",
            (ctx) => {
              delete ctx.tools.session_history;
            },
            { workspaceId }
          )
        );
      };
      if (phase === "cleanup") {
        const cleanup = h.session.applyContextResetSideEffects.bind(h.session);
        spyOn(h.session, "applyContextResetSideEffects").mockImplementationOnce(async () => {
          replaceRegistration();
          await cleanup();
        });
      } else {
        const append = h.historyService.acceptCompactionReplacement.bind(h.historyService);
        spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
          async (...args) => {
            replaceRegistration();
            return append(...args);
          }
        );
      }
      try {
        expect((await h.session.sendMessage("Admitted turn", options)).success).toBe(true);
        const snapshot = h.requests[0].requestAssemblySnapshot!;
        const ctx = { workspaceId, modelString: model, systemMessage: "base", tools: {} };
        await snapshot.run(ctx);
        expect(ctx.systemMessage).toBe("base admitted");
        await h.session.dispose();
        const next = await setup({ previous: h });
        await seedHistory(next, 120_000);
        expect(await next.session.sendMessage("Next admission", options)).toMatchObject({
          success: false,
          error: { type: "context_budget_blocked" },
        });
        expect(next.requests).toHaveLength(0);
      } finally {
        for (const unregister of unregisters) unregister();
      }
    }
  );

  test("delayed automatic retry retains the admitted snapshot instead of the live registry", async () => {
    const h = await setup({
      failure: (attempt) =>
        attempt === 1 ? { type: "runtime_start_failed", message: "retry startup" } : undefined,
    });
    await seedHistory(h, 120_000);
    const admitted = eventSpine.useRequestContext(
      (ctx) => {
        ctx.systemMessage += " admitted";
      },
      { workspaceId }
    );
    let removeLive: (() => void) | undefined;
    // Kept private: the real backoff retry fires ~2 s later on the global clock (these fakes
    // carry no effectRunner), so the test cancels it and runs the same retry step directly.
    const session = h.session as unknown as {
      retryManager: { cancel(): void };
      retryActiveStream(): Promise<void>;
    };
    try {
      expect((await h.session.sendMessage("Retry this same turn", options)).success).toBe(false);
      session.retryManager.cancel();
      const captured = h.requests[0].requestAssemblySnapshot;
      expect(captured).toBeDefined();
      admitted();
      removeLive = eventSpine.useBefore("request.assemble", () => undefined, { workspaceId });
      await session.retryActiveStream();
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1].requestAssemblySnapshot).toBe(captured);
      expect(rolloverRows(await allRows(h))).toHaveLength(1);
    } finally {
      admitted();
      removeLive?.();
    }
  });

  test.each([false, true])(
    "emergency rollover checks and pins the applicable chain (blocked=%s)",
    async (blocked) => {
      const h = await setup({ failure: (attempt) => (attempt === 1 ? exceeded : undefined) });
      await seedHistory(h, 20_000);
      const cleanup = spyOn(h.session, "applyContextResetSideEffects");
      const unregister = blocked
        ? eventSpine.useBefore("request.assemble", () => undefined, { workspaceId })
        : eventSpine.useRequestContext(
            (ctx) => {
              ctx.systemMessage += " emergency";
            },
            { workspaceId }
          );
      try {
        expect((await h.session.sendMessage("Retry if safe", options)).success).toBe(!blocked);
        expect(cleanup).toHaveBeenCalledTimes(blocked ? 0 : 1);
        expect(h.requests).toHaveLength(blocked ? 1 : 2);
        expect(rolloverRows(await allRows(h))).toHaveLength(blocked ? 0 : 1);
        if (!blocked) {
          const ctx = { workspaceId, modelString: model, systemMessage: "base", tools: {} };
          await h.requests[1].requestAssemblySnapshot!.run(ctx);
          expect(ctx.systemMessage).toBe("base emergency");
        }
      } finally {
        unregister();
      }
    }
  );

  test.each(
    (["file", "skill", "mcp", "family"] as const).flatMap((kind) =>
      [false, true].map((oldContext) => ({ kind, oldContext }))
    )
  )(
    "oversized materialized $kind preludes are rejected before cleanup/publication (oldContext=$oldContext)",
    async ({ kind, oldContext }) => {
      const large = ("漢".repeat(100) + "\n").repeat(40);
      const getPrompt = mock(() => Promise.resolve({ text: large }));
      const h = await setup({ mcpServerManager: { getPrompt } as unknown as MCPServerManager });
      if (oldContext) await seedHistory(h, 120_000);
      const original = await allRows(h);
      const contextLimit = spyOn(contextLimits, "getEffectiveContextLimit").mockReturnValue(10000);
      const cleanup = spyOn(h.session, "applyContextResetSideEffects");
      let message = "Use the requested input";
      let sendOptions = options;
      if (kind === "file") {
        await fs.writeFile(path.join(h.config.rootDir, "large.txt"), large);
        message = "Read @large.txt";
      } else if (kind === "skill") {
        spyOn(h.aiService, "isExperimentEnabled").mockImplementation(
          (id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT
        );
        const skillDir = path.join(h.config.rootDir, ".xum", "skills", "large-prelude");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          "---\nname: large-prelude\ndescription: Large test input\n---\n" +
            "!`printf x >> materializations.marker`\n" +
            large
        );
        sendOptions = {
          ...options,
          muxMetadata: {
            type: "agent-skill",
            rawCommand: "/large-prelude",
            skillName: "large-prelude",
            scope: "project",
          },
        };
      } else if (kind === "mcp") {
        sendOptions = {
          ...options,
          muxMetadata: {
            type: "normal",
            mcpPromptRefs: [
              {
                serverName: "test",
                promptName: "large",
                commandKey: "mcp__test__large",
                source: "slash",
              },
            ],
          },
        };
      }
      const payload = createMuxMessage("large-family", "assistant", large, {
        synthetic: true,
        muxMetadata: { type: "family-message" },
      });
      const result = await h.session.sendMessage(
        message,
        sendOptions,
        kind === "family"
          ? { synthetic: true, agentInitiated: true, preTurnMessages: [payload] }
          : undefined
      );
      expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
      expect(cleanup).not.toHaveBeenCalled();
      expect(h.requests).toHaveLength(0);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(rows.filter((row) => original.some((old) => old.id === row.id))).toEqual(original);
      expect(rows.some((row) => text(row).includes(large))).toBe(false);
      if (kind !== "family") {
        expect(rows.at(-1)?.metadata?.contextBudgetRejected).toBe(true);
        expect(rows.at(-1)?.role).toBe("assistant");
        expect(rows.at(-1)?.parts).toEqual([]);
      }
      expect(trackedFilePaths(h)).toEqual([]);
      if (kind === "mcp") expect(getPrompt).toHaveBeenCalledTimes(1);
      if (kind === "skill")
        expect(
          await fs.readFile(path.join(h.config.rootDir, "materializations.marker"), "utf8")
        ).toBe("x");

      // Unpublished snapshots must remain eligible for a later fitting send.
      contextLimit.mockReturnValue(128000);
      const retry = await h.session.sendMessage(
        message,
        sendOptions,
        kind === "family"
          ? { synthetic: true, agentInitiated: true, preTurnMessages: [payload] }
          : undefined
      );
      expect(retry.success).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(oldContext ? 1 : 0);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].messages.some((row) => text(row).includes("漢".repeat(100)))).toBe(true);
      expect(rolloverRows(await allRows(h))).toHaveLength(oldContext ? 1 : 0);
      if (kind === "mcp") expect(getPrompt).toHaveBeenCalledTimes(2);
      if (kind === "skill")
        expect(
          await fs.readFile(path.join(h.config.rootDir, "materializations.marker"), "utf8")
        ).toBe("xx");
      if (kind === "file")
        expect(trackedFilePaths(h)).toContain(path.join(h.config.rootDir, "large.txt"));
    }
  );

  test.each(["file", "mcp", "both"] as const)(
    "fresh admission counts the sum of materialized preludes: %s",
    async (sources) => {
      const content = ("漢".repeat(100) + "\n").repeat(16);
      const getPrompt = mock(() => Promise.resolve({ text: content }));
      const h = await setup({ mcpServerManager: { getPrompt } as unknown as MCPServerManager });
      await seedHistory(h, 120_000);
      spyOn(contextLimits, "getEffectiveContextLimit").mockReturnValue(10000);
      await fs.writeFile(path.join(h.config.rootDir, "combined.txt"), content);
      const result = await h.session.sendMessage(
        sources === "mcp" ? "Use the prompt" : "Use @combined.txt",
        {
          ...options,
          ...(sources !== "file"
            ? {
                muxMetadata: {
                  type: "normal",
                  mcpPromptRefs: [
                    {
                      serverName: "test",
                      promptName: "small",
                      commandKey: "mcp__test__small",
                      source: "slash",
                    },
                  ],
                },
              }
            : {}),
        }
      );
      expect(result.success).toBe(sources !== "both");
      expect(h.requests).toHaveLength(sources === "both" ? 0 : 1);
      expect(rolloverRows(await allRows(h))).toHaveLength(sources === "both" ? 0 : 1);
    }
  );

  test.each(["cancel", "shutdown"] as const)(
    "%s during materialized preflight leaves old history and context untouched",
    async (action) => {
      const h = await setup();
      await seedHistory(h, 120_000);
      const before = await allRows(h);
      const cleanup = spyOn(h.session, "applyContextResetSideEffects");
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const count = budgetCounting.estimateFreshRequestTokensForModel;
      spyOn(budgetCounting, "estimateFreshRequestTokensForModel").mockImplementation(
        async (input, model) => {
          const estimate = await count(input, model);
          if ((input.prelude?.length ?? 0) > 2) {
            entered.resolve();
            await release.promise;
          }
          return estimate;
        }
      );
      const send = h.session.sendMessage("Handle peer payload", options, {
        synthetic: true,
        preTurnMessages: [
          createMuxMessage("pending-family", "assistant", "Peer content", { synthetic: true }),
        ],
        cancelSignal: controller.signal,
        cancelState,
      });
      await entered.promise;
      if (action === "cancel") controller.abort();
      else h.session.beginShutdown();
      release.resolve();
      expect((await send).success).toBe(action === "cancel");
      expect(cancelState.canceledBeforeAcceptance).toBe(action === "cancel");
      expect(cleanup).not.toHaveBeenCalled();
      expect(await allRows(h)).toEqual(before);
      expect(h.requests).toHaveLength(0);
    }
  );

  test.each([
    { inputTokens: 120_000, automatic: true },
    { inputTokens: 1_000, automatic: true },
    { inputTokens: 120_000, automatic: false },
  ])(
    "token-budget send preserves scoped Stop recovery (tokens=$inputTokens, automatic=$automatic)",
    async ({ inputTokens, automatic }) => {
      const h = await setup();
      await h.session.cancelCompaction();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("canceled-summary", "assistant", "Canceled summary", {
          model,
          compactionBoundary: true,
          compacted: "user",
          contextUsage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "old continuation", model, agentId: "exec" },
          },
        })
      );
      expect(await h.session.isAutomaticSendBlocked()).toBe(false);
      const storage = h.historyService.getCompactionCancellationStorage(workspaceId);
      const stopped = await storage.read();
      expect(stopped?.scope.kind).toBe("summary");
      const result = await h.session.sendMessage("Fresh input", options, {
        acceptanceOrigin: automatic ? "automatic" : "manual",
        synthetic: automatic,
      });
      const latest = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(latest.success);
      const activeSummary = latest.data.some((row) => row.id === "canceled-summary");
      expect(await storage.read()).toEqual(automatic ? stopped : null);
      await h.session.dispose();
      const restarted = await createAgentSessionHarness({
        workspaceId,
        config: h.config,
        historyService: new HistoryService(h.config),
      });
      harnesses.push(restarted);
      expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
      // Recovery after restart must still find and clean the canceled handoff in its epoch.
      expect({
        accepted: result.success,
        providerStarts: h.requests.length,
        resets: rolloverRows(latest.data).length,
        activeSummary,
        remainingStop: await storage.read(),
      }).toEqual({
        accepted: !automatic || inputTokens === 1_000,
        providerStarts: !automatic || inputTokens === 1_000 ? 1 : 0,
        resets: automatic ? 0 : 1,
        activeSummary: automatic,
        remainingStop: null,
      });
    }
  );

  test("fresh automatic rollover replaces fully settled Stop without scoped debt", async () => {
    const h = await setup();
    await seedHistory(h, 120_000);
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    const storage = h.historyService.getCompactionCancellationStorage(workspaceId);
    const stopped = await storage.read();
    assert(stopped?.version === 2);
    expect(stopped.scope.kind).toBe("unresolved");
    expect(
      await h.session.sendMessage("Fresh automatic input", options, {
        acceptanceOrigin: "automatic",
        synthetic: true,
      })
    ).toEqual(Ok(undefined));
    const latest = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(latest.success);
    expect(rolloverRows(latest.data)).toHaveLength(1);
    expect(latest.data.some((row) => row.id === "old-answer")).toBe(false);
    expect(latest.data.at(-1)?.metadata?.compactionReplacementNonce).toBe(stopped.nonce);
    expect(await storage.read()).toBeNull();
    expect(h.requests).toHaveLength(1);
  });

  test("on-send rollover appends reset, hidden lead-in, skill snapshot and the original user together", async () => {
    const h = await setup();
    await seedHistory(h, 120_000);
    const skillDir = path.join(h.config.rootDir, ".xum", "skills", "budget-test");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: budget-test\ndescription: Test skill\n---\n\nPreserve this instruction.\n"
    );
    spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Ok({
        id: workspaceId,
        name: "budget",
        projectName: "project",
        projectPath: h.config.rootDir,
        namedWorkspacePath: h.config.rootDir,
        runtimeConfig: { type: "local" },
      } as FrontendWorkspaceMetadata)
    );
    const append = spyOn(h.historyService, "acceptCompactionReplacement");
    const result = await h.session.sendMessage("Do the requested work", {
      ...options,
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/budget-test Do the requested work",
        skillName: "budget-test",
        scope: "project",
      },
    });
    expect(result.success).toBe(true);
    const rows = await allRows(h);
    expect(rows.slice(0, 3).map((row) => row.id)).toEqual([
      "old-user",
      "first-answer",
      "old-answer",
    ]);
    const boundaryIndex = rows.findIndex((row) => rolloverRows([row]).length > 0);
    expect(boundaryIndex).toBe(3);
    const [boundary, leadIn, snapshot, user] = rows.slice(boundaryIndex);
    expect(boundary.metadata?.contextBoundaryKind).toBe("reset");
    expect(leadIn.metadata).toMatchObject({ synthetic: true, uiVisible: false });
    expect(snapshot.metadata?.agentSkillSnapshot?.skillName).toBe("budget-test");
    expect(text(user)).toBe("Do the requested work");
    expect(user.metadata?.muxMetadata?.type).toBe("agent-skill");
    expect(append.mock.calls).toHaveLength(1);
    const operation = append.mock.calls[0][2];
    assert(operation.kind === "append");
    expect(operation.messages.map((row) => row.id)).toEqual(
      rows.slice(boundaryIndex).map((row) => row.id)
    );
    expect(h.requests).toHaveLength(1);
    const providerRows = sliceMessagesForProviderFromLatestContextBoundary(h.requests[0].messages);
    expect(providerRows.map((row) => row.id)).toEqual([leadIn.id, snapshot.id, user.id]);
    expect(rows.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")).toBe(
      false
    );
  });

  test("on-send usage in the handoff band preserves history and publishes the handoff", async () => {
    const h = await setup();
    // Past the handoff target but below the usable ceiling: nothing is forced; the advisory
    // rides the send itself, with capabilities resolved from the dispatching permissions.
    await seedHistory(h, 95_000);
    expect(
      (await h.session.sendMessage("Keep working below the usable ceiling", options)).success
    ).toBe(true);
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(0);
    expect(warningRows(rows).map(isHandoffRow)).toEqual([true]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].messages.some((row) => row.id === "old-answer")).toBe(true);
  });

  test.each([false, true])(
    "rollover retains a deduped skill snapshot (emergency=%s)",
    async (emergency) => {
      const h = await setup();
      const skillDir = path.join(h.config.rootDir, ".xum", "skills", "repeat-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: repeat-skill\ndescription: Repeated skill\n---\nKeep these instructions.\n"
      );
      const skillOptions: SendMessageOptions = {
        ...options,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/repeat-skill",
          skillName: "repeat-skill",
          scope: "project",
        },
      };
      expect((await h.session.sendMessage("Use the skill", skillOptions)).success).toBe(true);
      await h.session.dispose();
      const resumed = await setup({
        previous: h,
        failure: emergency ? (attempt) => (attempt === 1 ? exceeded : undefined) : undefined,
      });
      await seedHistory(resumed, emergency ? 20_000 : 120_000);
      expect((await resumed.session.sendMessage("Use it again", skillOptions)).success).toBe(true);
      const rows = await allRows(resumed);
      const snapshots = rows.filter((row) => row.metadata?.agentSkillSnapshot);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].metadata?.agentSkillSnapshot?.sha256).toBe(
        snapshots[0].metadata?.agentSkillSnapshot?.sha256
      );
      const active = sliceMessagesForProviderFromLatestContextBoundary(rows);
      expect(active.some((row) => row.id === snapshots[1].id)).toBe(true);
      expect(active.some((row) => row.id === snapshots[0].id)).toBe(false);
    }
  );

  test("a rejected emergency retry quarantines its copied deduplicated skill snapshot", async () => {
    const first = await setup();
    const skillName = "owned-retry-skill";
    const skillDir = path.join(first.config.rootDir, ".xum", "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Skill ownership regression\n---\nAccepted skill instructions.\n`
    );
    const skillOptions: SendMessageOptions = {
      ...options,
      muxMetadata: {
        type: "agent-skill",
        rawCommand: `/${skillName}`,
        skillName,
        scope: "project",
      },
    };
    expect((await first.session.sendMessage("Use the skill", skillOptions)).success).toBe(true);
    await first.session.dispose();
    const h = await setup({
      previous: first,
      failure: (attempt) => (attempt <= 2 ? exceeded : undefined),
    });
    await seedHistory(h, 20_000);
    expect(
      await h.session.sendMessage("Use the unchanged skill again", skillOptions)
    ).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
    expect(h.requests).toHaveLength(2);
    const rows = await allRows(h);
    const displayed = rows.map(restoreContextBudgetRejectedMessageForDisplay);
    const snapshots = displayed.filter(
      (row) => row.metadata?.agentSkillSnapshot?.skillName === skillName
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].metadata?.agentSkillSnapshot?.sha256).toBe(
      snapshots[0].metadata?.agentSkillSnapshot?.sha256
    );
    const rejected = displayed.findLast(
      (row) => row.metadata?.contextBudgetRejected && text(row) === "Use the unchanged skill again"
    )!;
    expect(rejected.metadata?.requestPreludeMessageIds).toContain(snapshots[1].id);
    expect(rows.find((row) => row.id === snapshots[1].id)).toMatchObject({
      role: "assistant",
      parts: [],
      metadata: { contextBudgetRejected: true },
    });
    expect((await h.session.sendMessage("A new unrelated request", options)).success).toBe(true);
    const next = prepareProviderRequestMessages(
      h.requests[2].messages,
      "openai",
      "off"
    ).providerRequestMessages;
    expect(next.some((row) => row.metadata?.agentSkillSnapshot?.skillName === skillName)).toBe(
      false
    );
  });

  test.each([
    { name: "input only", usage: { inputTokens: 120_000 }, cacheWrite: 0, rollover: true },
    {
      name: "cached floor",
      usage: { inputTokens: 1000, cachedInputTokens: 75_000 },
      cacheWrite: 45_000,
      rollover: true,
    },
    {
      name: "inclusive input",
      usage: { inputTokens: 80_000, cachedInputTokens: 60_000 },
      cacheWrite: 15_000,
      rollover: false,
    },
    {
      name: "invalid cache",
      usage: { inputTokens: 120_000, cachedInputTokens: "bad" },
      cacheWrite: {},
      rollover: true,
    },
    {
      name: "invalid input",
      usage: { inputTokens: "bad", cachedInputTokens: 120_000 },
      cacheWrite: 0,
      rollover: true,
    },
    {
      name: "invalid counters",
      usage: { inputTokens: {}, cachedInputTokens: -1 },
      cacheWrite: 1e100,
      rollover: false,
    },
  ])(
    "restart budget fallback preserves valid persisted counters: $name",
    async ({ usage, cacheWrite, rollover }) => {
      const first = await setup();
      expect(
        (
          await first.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("old-user", "user", "Previous request"),
            createMuxMessage("first-answer", "assistant", "First response", {
              contextUsage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
            }),
          ])
        ).success
      ).toBe(true);
      // Model metadata is optional: the best-effort usage seeder cannot initialize
      // these rows, but their validated counters still describe the active window.
      const latest = createMuxMessage("persisted-answer", "assistant", "Preserved response", {
        historySequence: 2,
      });
      await fs.appendFile(
        path.join(first.config.sessionsDir, workspaceId, "chat.jsonl"),
        JSON.stringify({
          ...latest,
          metadata: {
            ...latest.metadata,
            contextUsage: usage,
            contextProviderMetadata: { anthropic: { cacheCreationInputTokens: cacheWrite } },
          },
        }) + "\n"
      );
      await first.session.dispose();
      const h = await setup({ previous: first });
      expect(
        (h.session as unknown as { getUsageState(): unknown }).getUsageState()
      ).toBeUndefined();
      expect((await h.session.sendMessage("Continue after restart", options)).success).toBe(true);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(rollover ? 1 : 0);
      expect(rows.find((row) => row.id === latest.id)?.parts).toEqual(latest.parts);
      const sent = sliceMessagesForProviderFromLatestContextBoundary(h.requests[0].messages);
      expect(sent.some((row) => row.id === latest.id)).toBe(!rollover);
    }
  );

  test.each([0, 20_000, 120_000])(
    "valid in-memory usage takes precedence over persisted usage (%d tokens)",
    async (inputTokens) => {
      const h = await setup();
      await seedHistory(h, inputTokens === 120_000 ? 20_000 : 120_000);
      const session = h.session as unknown as {
        updateUsageStateFromModelUsage(
          input: Pick<SettledStepBudget, "model" | "usage"> & { live: boolean }
        ): void;
      };
      session.updateUsageStateFromModelUsage({
        model,
        usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
        live: false,
      });
      expect((await h.session.sendMessage("Use current counters", options)).success).toBe(true);
      expect(rolloverRows(await allRows(h))).toHaveLength(inputTokens === 120_000 ? 1 : 0);
    }
  );

  test("a settled new_context request seals the window once after its siblings, with no flush", async () => {
    const h = await setup();
    expect((await h.session.sendMessage("Work", options)).success).toBe(true);
    // Far below the budget: only the explicit request drives the rollover.
    expect(
      (await h.requests[0].onStepSettled?.(step(20_000, { newContextRequested: true })))?.decision
    ).toBe("rollover");
    expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
    // A duplicate request in the same step batch/window coalesces into the pending intent.
    expect(
      (await h.requests[0].onStepSettled?.(step(20_500, { newContextRequested: true })))?.decision
    ).toBe("rollover");
    await h.finishAndDispatch();
    const rows = await allRows(h);
    const resets = rolloverRows(rows);
    expect(resets).toHaveLength(1);
    // Attribution rides in an optional field so a downgraded release still parses the row as an
    // ordinary rollover instead of a manual privacy reset.
    expect(resets[0].metadata?.muxMetadata).toMatchObject({
      reason: "mid-stream",
      requestedBy: "model",
    });
    expect(text(rows.at(-1)!)).toBe("Continue");
    expect(
      sliceMessagesForProviderFromLatestContextBoundary(h.requests[1].messages).some((row) =>
        text(row).includes("new_context")
      )
    ).toBe(true);
    // The fresh window has no outstanding request: an ordinary settled step continues.
    expect((await h.requests[1].onStepSettled?.(step(5_000)))?.decision).toBe("continue");
  });

  test("a new_context request is ignored while automatic rollover is disabled or history is unavailable", async () => {
    const h = await setup();
    await seedThreshold(h, 1);
    expect((await h.session.sendMessage("Work", options)).success).toBe(true);
    expect(
      (await h.requests[0].onStepSettled?.(step(20_000, { newContextRequested: true })))?.decision
    ).toBe("continue");
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(false);
    await seedThreshold(h, 0.7);
    expect(
      (
        await h.requests[0].onStepSettled?.(
          step(20_000, { newContextRequested: true, sessionHistoryAvailable: false })
        )
      )?.decision
    ).toBe("continue");
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(false);
  });

  test("a new_context request is honored even when the model's context limit is unknown", async () => {
    const h = await setup();
    expect(
      (await h.session.sendMessage("Work", { ...options, model: "custom:unknown-limit-model" }))
        .success
    ).toBe(true);
    expect(
      (
        await h.requests[0].onStepSettled?.(
          step(20_000, { model: "custom:unknown-limit-model", newContextRequested: true })
        )
      )?.decision
    ).toBe("rollover");
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
    // Budget evaluation alone still cannot run without a limit: no advisory at any usage.
    expect(
      (await h.requests[0].onStepSettled?.(step(90_000, { model: "custom:unknown-limit-model" })))
        ?.decision
    ).toBe("continue");
    expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
    // The queued continuation seals the window even though no limit is known.
    await h.finishAndDispatch();
    const [reset] = rolloverRows(await allRows(h));
    expect(reset?.metadata?.muxMetadata).toMatchObject({ requestedBy: "model" });
    expect(h.requests[1].messages.some((row) => row.id === reset.id)).toBe(true);
  });

  test("an explicit request wins over the handoff advisory and over a hard block", async () => {
    const h = await setup();
    expect((await h.session.sendMessage("Work", options)).success).toBe(true);
    // Handoff target crossed AND requested: seal directly (no advisory), attributed to the model.
    expect(
      (await h.requests[0].onStepSettled?.(step(110_000, { newContextRequested: true })))?.decision
    ).toBe("rollover");
    expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
    await h.finishAndDispatch();
    expect(rolloverRows(await allRows(h))[0]?.metadata?.muxMetadata).toMatchObject({
      reason: "mid-stream",
      requestedBy: "model",
    });
    // A hard block (only possible with automatic rollover disabled) stays authoritative: the
    // tool is not offered there, and a stray request cannot bypass it.
    const blocked = await setup();
    await seedThreshold(blocked, 1);
    expect((await blocked.session.sendMessage("Work", options)).success).toBe(true);
    expect(
      (
        await blocked.requests[0].onStepSettled?.(
          step(120_000, { toolResultChars: 2_000_000, newContextRequested: true })
        )
      )?.decision
    ).toBe("block");
  });

  test("a persisted receipt is not honored while the policy disables session_history", async () => {
    const h = await setup();
    const request = createMuxMessage("requester", "assistant", "", {
      model,
      contextUsage: { inputTokens: 20_000, outputTokens: 10, totalTokens: 20_010 },
    });
    request.parts.push({
      type: "dynamic-tool",
      toolName: "new_context",
      toolCallId: "nc",
      state: "output-available",
      input: {},
      output: { success: true, status: "scheduled", message: "scheduled" },
    });
    expect(
      (
        await h.historyService.appendManyToHistory(workspaceId, [
          createMuxMessage("old-user", "user", "Previous request"),
          request,
        ])
      ).success
    ).toBe(true);
    const denied = {
      ...options,
      toolPolicy: [{ regex_match: "session_history", action: "disable" as const }],
    };
    // The send is admitted as an ordinary turn (not rejected on every retry), without a reset.
    expect((await h.session.sendMessage("Keep going without history", denied)).success).toBe(true);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
  });

  test("restart recovers an unconsumed new_context receipt but not an interrupted one", async () => {
    for (const partial of [false, true]) {
      const first = await setup();
      const request = createMuxMessage("requester", "assistant", "Saving notes, then resetting", {
        model,
        ...(partial ? { partial: true } : {}),
        contextUsage: { inputTokens: 20_000, outputTokens: 10, totalTokens: 20_010 },
        stepStartPartIndices: [0, 1],
      });
      request.parts.push({
        type: "dynamic-tool",
        toolName: "new_context",
        toolCallId: "nc",
        state: "output-available",
        input: {},
        output: { success: true, status: "scheduled", message: "scheduled" },
      });
      expect(
        (
          await first.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("old-user", "user", "Previous request"),
            request,
          ])
        ).success
      ).toBe(true);
      // The in-memory intent and its queued continuation are gone after a restart.
      await first.session.dispose();
      const h = await setup({ previous: first });
      expect((await h.session.sendMessage("Resume after restart", options)).success).toBe(true);
      const rows = await allRows(h);
      const resets = rolloverRows(rows);
      if (partial) {
        expect(resets).toHaveLength(0);
      } else {
        expect(resets).toHaveLength(1);
        expect(resets[0].metadata?.muxMetadata).toMatchObject({
          reason: "on-send",
          requestedBy: "model",
        });
        // Consumed once: the next send in the fresh window does not reset again.
        h.settleStream(0);
        expect((await h.session.sendMessage("Keep going", options)).success).toBe(true);
        expect(rolloverRows(await allRows(h))).toHaveLength(1);
      }
      await h.session.dispose();
      await h.cleanup();
      await first.cleanup();
      harnesses.length = 0;
    }
  });

  test("restart recomputes pending rollover including a giant final tool result", async () => {
    const first = await setup();
    await seedHistory(first, 30_000, 400_000);
    await first.session.dispose();
    const h = await setup({ previous: first });
    expect((await h.session.sendMessage("Resume after restart", options)).success).toBe(true);
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(1);
    expect(rows.find((row) => row.id === "old-answer")?.parts.at(-1)).toMatchObject({
      toolCallId: "completed-side-effect",
      state: "output-available",
    });
    expect(
      sliceMessagesForProviderFromLatestContextBoundary(h.requests[0].messages).some(
        (row) => row.id === "old-answer"
      )
    ).toBe(false);
  });

  test("restart seals a stopped partial and its completed tool output before the reset", async () => {
    const first = await setup();
    await seedHistory(first, 20_000);
    const partial = createMuxMessage("stopped-partial", "assistant", "", {
      model,
      partial: true,
      stepStartPartIndices: [0],
      contextUsage: { inputTokens: 30_000, outputTokens: 10, totalTokens: 30_010 },
    });
    // StreamManager first persists an assistant placeholder to reserve its history sequence.
    expect((await first.historyService.appendToHistory(workspaceId, partial)).success).toBe(true);
    partial.parts = [
      {
        type: "dynamic-tool",
        toolCallId: "settled-side-effect",
        toolName: "bash",
        state: "output-available",
        input: {},
        output: "x".repeat(400_000),
      },
    ];
    expect((await first.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    await first.session.dispose();
    const h = await setup({ previous: first });
    expect(await h.session.sendMessage("Resume safely", options)).toMatchObject({ success: true });
    const rows = await allRows(h);
    const persistedPartial = rows.find((row) => row.id === partial.id)!;
    expect(persistedPartial.parts).toEqual(partial.parts);
    const boundary = rolloverRows(rows)[0];
    expect(boundary).toBeDefined();
    expect(persistedPartial.metadata!.historySequence!).toBeLessThan(
      boundary.metadata!.historySequence!
    );
    expect(await h.historyService.readPartial(workspaceId)).toBeNull();
    expect(
      sliceMessagesForProviderFromLatestContextBoundary(h.requests[0].messages).some(
        (row) => row.id === partial.id
      )
    ).toBe(false);
  });

  test.each([1, 2])(
    "restart after %i prefix rows never writes another boundary",
    async (prefixLength) => {
      const first = await setup();
      await seedHistory(first, 120_000);
      const rollover: ContextWindowRollover = {
        type: "context-window-rollover",
        rolloverId: "crash-rollover",
        reason: "mid-stream",
        previousWindowId: "w:0",
        flushOpportunity: false,
        contextTokens: 95_000,
        maxTokens: 128_000,
      };
      expect(
        (
          await first.historyService.appendManyToHistory(
            workspaceId,
            createRolloverPrefix(rollover).slice(0, prefixLength)
          )
        ).success
      ).toBe(true);
      await first.session.dispose();
      const h = await setup({ previous: first });
      expect((await h.session.sendMessage("Recover accepted work", options)).success).toBe(true);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(1);
      expect(text(rows.at(-1)!)).toBe("Recover accepted work");
      expect(h.requests).toHaveLength(1);
    }
  );

  test.each(
    (["on-send", "emergency"] as const).flatMap((mode) =>
      (
        [
          "committed",
          "append-failed",
          "ack-failed",
          "successor",
          "cleanup-failed",
          "ack-and-cleanup-failed",
        ] as const
      ).map((outcome) => ({ mode, outcome }))
    )
  )(
    "rollover pending cleanup follows durable history ($mode, $outcome)",
    async ({ mode, outcome }) => {
      const h = await setup({
        failure:
          mode === "emergency" ? (attempt) => (attempt === 1 ? exceeded : undefined) : undefined,
      });
      await seedHistory(h, mode === "emergency" ? 20_000 : 120_000);
      const sessionDir = path.join(h.config.sessionsDir, workspaceId);
      const pendingPath = path.join(sessionDir, POST_COMPACTION_STATE_FILENAME);
      const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
      let before = "";
      let successor = "";
      const acknowledgmentFailure = "injected post-commit failure";
      const cleanupFails = outcome === "cleanup-failed" || outcome === "ack-and-cleanup-failed";
      const reportedErrors = spyOn(log, "error");
      const cleanup = h.session.applyContextResetSideEffects.bind(h.session);
      spyOn(h.session, "applyContextResetSideEffects").mockImplementationOnce(async (...args) => {
        // A foreign pending publication can arrive after preparation, including after the
        // emergency path rejected an earlier attachment. The reset must retire this owner too.
        before = JSON.stringify({
          version: 1,
          createdAt: 1,
          publicationGeneration: (await journal.captureGeneration()) ?? null,
          diffs: [{ path: "/before.ts", diff: "+before", truncated: false }],
          loadedSkills: [{ name: "before", scope: "project", body: "Pre-reset instructions" }],
          readFiles: ["/before.ts"],
        });
        await fs.writeFile(pendingPath, before);
        await cleanup(...args);
      });
      const afterPublication = async () => {
        if (outcome === "successor") {
          const pending = new CompactionPendingState(
            pendingPath,
            h.historyService.getCompactionPendingHistory(workspaceId)
          );
          expect(
            (
              await pending.publishBoundary({
                summaryMessage: createMuxMessage("successor", "assistant", "New context", {
                  compacted: "user",
                  compactionBoundary: true,
                  compactionEpoch: 1,
                }),
                tailCopies: [],
                updateExisting: false,
                attachments: { diffs: [], loadedSkills: [], readFiles: ["/after.ts"] },
                publication: { generation: await journal.captureGeneration() },
                isCurrent: () => true,
                shouldPersist: () => true,
                onCommitted: () => undefined,
              })
            ).success
          ).toBe(true);
          successor = await fs.readFile(pendingPath, "utf8");
        }
        if (cleanupFails) {
          const unlink = fs.unlink;
          spyOn(fs, "unlink").mockImplementation((file) =>
            file === pendingPath
              ? Promise.reject(
                  Object.assign(new Error("pending unlink failed"), { code: "EACCES" })
                )
              : unlink(file)
          );
        }
        if (outcome === "ack-failed" || outcome === "ack-and-cleanup-failed") {
          throw new Error(acknowledgmentFailure);
        }
      };
      // Both paths use the guarded history receipt; retain real disk publication.
      const accept = h.historyService.acceptCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "acceptCompactionReplacement").mockImplementation(async (...args) => {
        const operation = args[2];
        const rollover = operation.kind === "append" && rolloverRows(operation.messages).length > 0;
        if (rollover && outcome === "append-failed") return Err("injected rollover append failure");
        const result = await accept(...args);
        if (rollover && result.success && result.data.kind === "accepted") await afterPublication();
        return result;
      });
      const sent = await h.session.sendMessage("Roll over this window", options);
      if (cleanupFails) {
        const causes = reportedErrors.mock.calls.flatMap((args) =>
          args.filter((value): value is Error => value instanceof Error).map((error) => error.cause)
        );
        expect(causes).toContainEqual(expect.objectContaining({ code: "EACCES" }));
      }
      expect(sent.success).toBe(
        outcome === "committed" || outcome === "successor" || outcome === "cleanup-failed"
      );
      expect(rolloverRows(await allRows(h))).toHaveLength(outcome === "append-failed" ? 0 : 1);
      const persistedPending = await fs.readFile(pendingPath, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      // Generation fences protect the current reader only. Removing the compatible bytes is
      // what prevents a preceding version from reloading them immediately after a downgrade.
      expect(persistedPending).toBe(
        outcome === "successor"
          ? successor
          : outcome === "append-failed" || cleanupFails
            ? before
            : undefined
      );
      if (!sent.success) {
        expect(h.requests).toHaveLength(mode === "emergency" ? 1 : 0);
        if (outcome === "ack-and-cleanup-failed") {
          expect(sent.error).toMatchObject({ type: "unknown", raw: acknowledgmentFailure });
        }
      }
      if (outcome === "cleanup-failed") {
        expect(h.requests).toHaveLength(mode === "emergency" ? 2 : 1);
        h.settleStream(0);
        await h.session.waitForIdle();
        expect((await h.session.sendMessage("Continue accepted work", options)).success).toBe(true);
        const rows = await allRows(h);
        expect(rolloverRows(rows)).toHaveLength(1);
        const active = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(active.success).toBe(true);
        if (active.success)
          expect(active.data.filter((row) => text(row) === "Roll over this window")).toHaveLength(
            1
          );
      }
    }
  );

  test("failed atomic append preserves history and retry after fail-closed cleanup", async () => {
    const h = await setup();
    await seedHistory(h, 120_000);
    const cleanup = spyOn(h.session, "applyContextResetSideEffects");
    const append = spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
      async () => {
        expect(cleanup).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        throw new Error("disk unavailable");
      }
    );
    expect((await h.session.sendMessage("Retry me", options)).success).toBe(false);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    const failedOperation = append.mock.calls[0][2];
    assert(failedOperation.kind === "append");
    const failedRollover = failedOperation.messages[0].metadata?.muxMetadata;
    expect((await h.session.sendMessage("Retry me", options)).success).toBe(true);
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(1);
    expect(rolloverRows(rows)[0].metadata?.muxMetadata).toEqual(failedRollover);
    expect(rows.filter((row) => text(row) === "Retry me")).toHaveLength(1);
  });

  test("a published rollover is not repeated when its append acknowledgment fails", async () => {
    const h = await setup();
    await seedHistory(h, 120_000);
    const append = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
      async (...args) => {
        const result = await append(...args);
        if (!result.success) throw new Error(result.error);
        throw new Error("directory sync failed after publication");
      }
    );
    expect((await h.session.sendMessage("Published input", options)).success).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
    expect((await h.session.sendMessage("Resume safely", options)).success).toBe(true);
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(1);
    expect(rows.filter((row) => text(row) === "Published input")).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
  });

  test.each(["tool-end", "turn-end"] as const)(
    "%s queued real input receives the settled rollover without a duplicate Continue",
    async (queueDispatchMode) => {
      const h = await setup();
      expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
      h.session.queueMessage("Real queued instruction", { ...options, queueDispatchMode });
      expect((await h.requests[0].onStepSettled?.(step(120_000)))?.decision).toBe("rollover");
      expect(rolloverRows(await allRows(h))).toHaveLength(0);
      await h.finishAndDispatch();
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(1);
      expect(rows.filter((row) => text(row) === "Real queued instruction")).toHaveLength(1);
      expect(rows.filter((row) => text(row) === "Continue")).toHaveLength(0);
      expect(h.requests).toHaveLength(2);
    }
  );

  test.each([
    {
      label: "warning with full capabilities",
      usage: 85_000,
      sendOptions: resumeOptions,
      expected: {
        handoff: false,
        memoryWritable: true,
        sessionHistoryAvailable: true,
        newContextAvailable: true,
      },
    },
    {
      label: "handoff with degraded capabilities",
      usage: 90_000,
      sendOptions: {
        ...resumeOptions,
        toolPolicy: [{ regex_match: "memory|session_.*", action: "disable" }],
      } satisfies SendMessageOptions,
      expected: {
        handoff: true,
        memoryWritable: false,
        sessionHistoryAvailable: false,
        newContextAvailable: true,
      },
    },
  ])(
    "the first send after a restart publishes the $label through the dispatching permissions",
    async ({ usage, sendOptions, expected }) => {
      const first = await setup();
      await seedHistory(first, usage);
      await first.session.dispose();
      // No step has settled in this process, so nothing cached says what the agent can do; the
      // dispatching agent, policy and experiments are the capability source.
      const h = await setup({ previous: first });
      const warning = spyOn(rolloverMessages, "createContextBudgetWarning");
      expect((await h.session.sendMessage("Resume work", sendOptions)).success).toBe(true);
      const rows = await allRows(h);
      expect(warningRows(rows)).toHaveLength(1);
      expect(isHandoffRow(warningRows(rows)[0])).toBe(expected.handoff);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 128_000, budgetTokens: 119_808, ...expected })
      );
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(h.requests[0].messages.some((row) => row.id === "old-answer")).toBe(true);
      expect(budgetClaims(h)).toEqual({ warning: !expected.handoff, handoff: expected.handoff });
      // A text-only reply never runs the settled-step callback; the next send repeats nothing.
      h.settleStream(0, { finishReason: "stop", contextUsage: { inputTokens: usage } });
      await h.session.waitForIdle();
      expect((await h.session.sendMessage("Keep going", sendOptions)).success).toBe(true);
      expect(warningRows(await allRows(h))).toHaveLength(1);
      expect(h.requests).toHaveLength(2);
    }
  );

  test.each([0.7, 0.9, 1])(
    "a pending handoff is reclassified at dispatch with threshold %s",
    async (threshold) => {
      const h = await setup();
      expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
      expect((await h.requests[0].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
      expect(warningRows(await allRows(h))).toHaveLength(0);
      expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(true);
      const state = budgetOf(h);
      expect(state.contextBudgetHandoffClaimed).toBe(false);
      await seedThreshold(h, threshold);
      h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
      await h.waitForRequest(2);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(warningRows(rows)).toHaveLength(threshold === 0.7 ? 1 : 0);
      expect(state.contextBudgetHandoffClaimed).toBe(threshold === 0.7);
      if (threshold !== 0.7) return;
      expect(warningRows(rows)[0].metadata?.muxMetadata).toMatchObject({
        handoff: true,
        budgetTokens: 119_808,
        handoffTokens: 89_600,
      });
      for (const usage of [95_000, 105_000, 115_000]) {
        expect((await h.requests[1].onStepSettled?.(step(usage)))?.decision).toBe("continue");
      }
      expect((await h.requests[1].onStepSettled?.(step(120_000)))?.decision).toBe("rollover");
      expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
      h.settleStream(1, { contextUsage: { inputTokens: 120_000 } });
      await h.waitForRequest(3);
      const sealed = await allRows(h);
      expect(rolloverRows(sealed)).toHaveLength(1);
      expect(warningRows(sealed).some(isFinalFlushRow)).toBe(false);
    }
  );

  test.each([85_000, 90_000])(
    "a settled advisory at %d tokens is durable once per window and retains delegated continuation attribution",
    async (usage) => {
      const h = await setup();
      expect(
        (
          await h.session.sendMessage(
            "Start delegated work",
            {
              ...options,
              muxMetadata: correlation,
            },
            {
              synthetic: true,
              agentInitiated: true,
              goalKind: GOAL_CONTINUATION_KIND,
              goalId: "goal-budget",
            }
          )
        ).success
      ).toBe(true);
      expect((await h.requests[0].onStepSettled?.(step(usage)))?.decision).toBe("warn");
      expect(warningRows(await allRows(h))).toHaveLength(0);
      expect(h.session.hasPendingWorkspaceTurnContinuation(correlation)).toBe(true);
      h.settleStream(0, { contextUsage: { inputTokens: usage } });
      await h.waitForRequest(2);
      const rows = await allRows(h);
      const warnings = warningRows(rows);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].metadata!.muxMetadata).toMatchObject({
        budgetTokens: 119_808,
        handoffTokens: 89_600,
      });
      expect(isHandoffRow(warnings[0])).toBe(usage >= 89_600);
      const continuation = rows.at(-1)!;
      expect(continuation.metadata).toMatchObject({
        synthetic: true,
        uiVisible: false,
        retrySendOptions: { agentInitiated: true },
        kind: GOAL_CONTINUATION_KIND,
        goalId: "goal-budget",
        muxMetadata: correlation,
      });
      expect(warnings[0].metadata!.historySequence!).toBeLessThan(
        continuation.metadata!.historySequence!
      );
      expect((await h.requests[1].onStepSettled?.(step(usage)))?.decision).toBe("continue");
      expect(rolloverRows(rows)).toHaveLength(0);
    }
  );

  test.each([
    ["at the hard ceiling", step(127_000), false],
    ["with read-only memory", step(120_000, { memoryWritable: false }), false],
    ["without session_history", step(120_000, { sessionHistoryAvailable: false }), false],
  ])(
    "settled rollover %s seals without a flush and preserves continuation correlation",
    async (_label, settled, flushOpportunity) => {
      const h = await setup();
      expect(
        (await h.session.sendMessage("Work", { ...options, muxMetadata: correlation })).success
      ).toBe(true);
      expect((await h.requests[0].onStepSettled?.(settled))?.decision).toBe("rollover");
      expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
      await h.finishAndDispatch();
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(1);
      expect(rolloverRows(rows)[0].metadata?.muxMetadata).toMatchObject({ flushOpportunity });
      expect(warningRows(rows)).toHaveLength(0);
      expect(rows.at(-1)?.metadata).toMatchObject({
        synthetic: true,
        retrySendOptions: { agentInitiated: true },
        muxMetadata: correlation,
      });
    }
  );

  test.each([false, true])(
    "separate queued inputs survive their own replacement retirement (reset=%s)",
    async (reset) => {
      const h = await setup();
      await seedHistory(h, reset ? 120_000 : 20_000);
      const foreign = new CompactionCancellation(
        new HistoryService(h.config).getCompactionCancellationStorage(workspaceId)
      );
      await foreign.cancel({ retainUntilReplacement: true });
      for (const message of ["First after Stop", "Second after Stop"])
        h.session.queueMessage(message, options, { onAccepted: () => undefined });
      h.session.sendQueuedMessages();
      await h.waitForRequest(1);
      h.settleStream(0, { finishReason: "stop" });
      await h.waitForRequest(2);
      const rows = await allRows(h);
      expect(
        rows.filter((row) => ["First after Stop", "Second after Stop"].includes(text(row)))
      ).toHaveLength(2);
      expect(rolloverRows(rows)).toHaveLength(reset ? 1 : 0);
    }
  );

  test.each([false, true])(
    "separate automatic inputs survive settled Stop retirement (reset=%s)",
    async (reset) => {
      const h = await setup();
      await seedHistory(h, reset ? 120_000 : 20_000);
      const foreign = new CompactionCancellation(
        new HistoryService(h.config).getCompactionCancellationStorage(workspaceId)
      );
      await foreign.cancel({ settled: Promise.resolve(true) });
      for (const message of ["First after Stop", "Second after Stop"])
        h.session.queueMessage(message, options, {
          acceptanceOrigin: "automatic",
          synthetic: true,
          onAccepted: () => undefined,
        });
      h.session.sendQueuedMessages();
      await h.waitForRequest(1);
      h.settleStream(0, { finishReason: "stop" });
      await h.waitForRequest(2);
      const rows = await allRows(h);
      expect(
        rows.filter((row) => ["First after Stop", "Second after Stop"].includes(text(row)))
      ).toHaveLength(2);
      expect(rolloverRows(rows)).toHaveLength(reset ? 1 : 0);
    }
  );

  test("cancellation before an owned reset receipt releases its automatic caller without publication", async () => {
    const h = await setup();
    await seedHistory(h, 120_000);
    const controller = new AbortController();
    const canceled = mock(() => undefined);
    const failed = mock(() => undefined);
    const accept = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementation(async (...args) => {
      if (args[2].kind === "append" && rolloverRows(args[2].messages).length > 0)
        controller.abort();
      return accept(...args);
    });
    expect(
      (
        await h.session.sendMessage("Automatic reset", options, {
          acceptanceOrigin: "automatic",
          synthetic: true,
          cancelSignal: controller.signal,
          onCanceled: canceled,
          onAcceptedPreStreamFailure: failed,
        })
      ).success
    ).toBe(true);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
  });

  test.each(["before", "after"] as const)(
    "owned rollover cannot reauthorize queued input across a foreign Stop %s its receipt",
    async (phase) => {
      const h = await setup();
      await seedHistory(h, 120_000);
      h.session.queueMessage("Queued before foreign Stop", options);
      const foreign = new CompactionCancellation(
        new HistoryService(h.config).getCompactionCancellationStorage(workspaceId)
      );
      let stopped: Awaited<ReturnType<typeof foreign.read>> = null;
      const stop = async () => {
        await foreign.cancel({ retainUntilReplacement: true });
        stopped = await foreign.read();
      };
      const accept = h.historyService.acceptCompactionReplacement.bind(h.historyService);
      let intercepted = false;
      spyOn(h.historyService, "acceptCompactionReplacement").mockImplementation(async (...args) => {
        const reset = args[2].kind === "append" && rolloverRows(args[2].messages).length > 0;
        if (reset && phase === "before") await stop();
        const result = await accept(...args);
        if (reset) {
          intercepted = true;
          if (phase === "after") await stop();
        }
        return result;
      });
      const result = await h.session.sendMessage("Reset this window", options);
      expect(result.success).toBe(false);
      // A reset receipt retains accepted input, but cannot authorize provider startup
      // after another backend's Stop supersedes the original request frontier.
      expect(h.requests).toHaveLength(0);
      await h.session.waitForIdle();
      expect(intercepted).toBe(true);
      const rows = await allRows(h);
      expect(rows.some((row) => text(row) === "Queued before foreign Stop")).toBe(false);
      expect(rolloverRows(rows)).toHaveLength(phase === "before" ? 0 : 1);
      expect(rows.filter((row) => text(row) === "Reset this window")).toHaveLength(
        phase === "before" ? 0 : 1
      );
      expect(stopped).not.toBeNull();
      expect(await foreign.read()).toEqual(stopped);
    }
  );

  test.each([
    { label: "after an advance warning", first: 85_000, warnings: 2 },
    { label: "on a direct jump into the handoff band", first: 90_000, warnings: 1 },
  ])(
    "the handoff is published once $label and suppresses later warnings",
    async ({ first, warnings }) => {
      const h = await setup();
      expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
      // The external stop type stays "warn"; the published row tells the advisories apart.
      expect((await h.requests[0].onStepSettled?.(step(first)))?.decision).toBe("warn");
      h.settleStream(0, { contextUsage: { inputTokens: first } });
      await h.waitForRequest(2);
      let rows = await allRows(h);
      expect(warningRows(rows)).toHaveLength(1);
      expect(warningRows(rows)[0].metadata?.muxMetadata).toMatchObject({
        budgetTokens: 119_808,
        handoffTokens: 89_600,
      });
      expect(isHandoffRow(warningRows(rows)[0])).toBe(first >= 89_600);
      expect(budgetClaims(h)).toEqual({ warning: first < 89_600, handoff: first >= 89_600 });
      if (first < 89_600) {
        // A delivered warning does not consume the handoff that follows it.
        expect((await h.requests[1].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
        h.settleStream(1, { contextUsage: { inputTokens: 90_000 } });
        await h.waitForRequest(3);
        rows = await allRows(h);
      }
      expect(warningRows(rows)).toHaveLength(warnings);
      expect(warningRows(rows).filter(isHandoffRow)).toHaveLength(1);
      expect(budgetClaims(h)).toEqual({ warning: first < 89_600, handoff: true });
      // Nothing else is advertised in this window until the usable ceiling forces a rollover;
      // near the ceiling the advisory row itself would no longer fit.
      const active = h.requests.at(-1)!;
      for (const usage of [85_000, 95_000, 118_000])
        expect((await active.onStepSettled?.(step(usage)))?.decision).toBe("continue");
      expect(h.session.hasQueuedMessages()).toBe(false);
      expect(rolloverRows(rows)).toHaveLength(0);
    }
  );

  test("a pending warning is upgraded by the queued user input that dispatches it", async () => {
    const h = await setup();
    expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
    expect(h.session.queueMessage("Later question", options)).not.toBeNull();
    expect((await h.requests[0].onStepSettled?.(step(85_000)))?.decision).toBe("warn");
    // Real queued input owns the dispatch: no Continue is added behind it.
    expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(false);
    // Usage reported at stream end crossed the handoff target: the pending intent never pins
    // the advisory to the level it was computed at.
    h.settleStream(0, { contextUsage: { inputTokens: 92_000 } });
    await h.waitForRequest(2);
    const rows = await allRows(h);
    expect(warningRows(rows).map(isHandoffRow)).toEqual([true]);
    expect(text(rows.at(-1)!)).toBe("Later question");
    expect(rows.filter((row) => text(row) === "Continue")).toHaveLength(0);
    expect(warningRows(rows)[0].metadata!.historySequence!).toBeLessThan(
      rows.at(-1)!.metadata!.historySequence!
    );
    expect(budgetClaims(h)).toEqual({ warning: false, handoff: true });
  });

  test.each([
    {
      label: "caller disables tools",
      previousEnabled: true,
      next: {
        toolPolicy: [{ regex_match: "memory|session_history|new_context", action: "disable" }],
      },
      expected: {
        memoryWritable: false,
        sessionHistoryAvailable: false,
        newContextAvailable: false,
      },
    },
    {
      label: "caller restores tools",
      previousEnabled: false,
      next: {},
      expected: { memoryWritable: true, sessionHistoryAvailable: true, newContextAvailable: true },
    },
    {
      label: "agent removes tools",
      previousEnabled: true,
      next: { agentId: "restricted" },
      expected: {
        memoryWritable: false,
        sessionHistoryAvailable: false,
        newContextAvailable: false,
      },
    },
    {
      label: "read-only agent",
      previousEnabled: true,
      next: { agentId: "observer" },
      expected: { memoryWritable: false, sessionHistoryAvailable: true, newContextAvailable: true },
    },
    {
      label: "Memory experiment disabled",
      previousEnabled: true,
      next: { experiments: { tokenBudget: true, memory: false } },
      expected: { memoryWritable: false, sessionHistoryAvailable: true, newContextAvailable: true },
    },
    {
      label: "memory tool disabled",
      previousEnabled: true,
      next: { toolPolicy: [{ regex_match: "memory", action: "disable" }] },
      expected: { memoryWritable: false, sessionHistoryAvailable: true, newContextAvailable: true },
    },
  ] satisfies Array<{
    label: string;
    previousEnabled: boolean;
    next: Partial<SendMessageOptions>;
    expected: {
      memoryWritable: boolean;
      sessionHistoryAvailable: boolean;
      newContextAvailable: boolean;
    };
  }>)(
    "queued advisories use dispatch permissions: $label",
    async ({ previousEnabled, next, expected }) => {
      const h = await setup();
      const dispatchOptions: SendMessageOptions = { ...resumeOptions, ...next };
      if (dispatchOptions.agentId === "restricted" || dispatchOptions.agentId === "observer") {
        const agentsDir = path.join(h.config.rootDir, ".xum", "agents");
        await fs.mkdir(agentsDir, { recursive: true });
        await fs.writeFile(
          path.join(agentsDir, `${dispatchOptions.agentId}.md`),
          dispatchOptions.agentId === "restricted"
            ? '---\nname: Restricted\nbase: exec\ntools:\n  remove: ["memory", "session_history", "new_context"]\n---\nRestricted agent.\n'
            : '---\nname: Observer\ntools:\n  add: ["file_read", "memory", "session_history", "new_context"]\n---\nRead-only agent.\n'
        );
      }
      const previousOptions: SendMessageOptions = {
        ...resumeOptions,
        ...(!previousEnabled
          ? {
              toolPolicy: [
                { regex_match: "memory|session_history|new_context", action: "disable" as const },
              ],
            }
          : {}),
      };
      const warning = spyOn(rolloverMessages, "createContextBudgetWarning");
      expect((await h.session.sendMessage("Start work", previousOptions)).success).toBe(true);
      expect(h.session.queueMessage("Next request", dispatchOptions)).not.toBeNull();
      expect(
        (
          await h.requests[0].onStepSettled?.(
            step(90_000, {
              memoryWritable: previousEnabled,
              sessionHistoryAvailable: previousEnabled,
            })
          )
        )?.decision
      ).toBe("warn");
      h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
      await h.waitForRequest(2);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.objectContaining({ handoff: true, ...expected }));
      const rows = await allRows(h);
      expect(warningRows(rows).map(isHandoffRow)).toEqual([true]);
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(budgetClaims(h)).toEqual({ warning: false, handoff: true });
      expect(text(rows.at(-1)!)).toBe("Next request");
    }
  );

  test("unresolved dispatch permissions omit the advisory without consuming its claim", async () => {
    const h = await setup();
    expect((await h.session.sendMessage("Start work", resumeOptions)).success).toBe(true);
    expect((await h.requests[0].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
    // Fail only the optional advisory lookup, not unrelated stream preparation or rollover admission.
    spyOn(
      budgetOf(h) as unknown as { resolveAgentForBudgetChecks: () => Promise<unknown> },
      "resolveAgentForBudgetChecks"
    ).mockResolvedValueOnce(Err(exceeded));
    h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
    await h.waitForRequest(2);
    expect(warningRows(await allRows(h))).toHaveLength(0);
    expect(budgetClaims(h)).toEqual({ warning: false, handoff: false });
    expect(text(h.requests[1].messages.at(-1)!)).toBe("Continue");

    expect((await h.requests[1].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
    h.settleStream(1, { contextUsage: { inputTokens: 90_000 } });
    await h.waitForRequest(3);
    const rows = await allRows(h);
    expect(warningRows(rows).map(isHandoffRow)).toEqual([true]);
    expect(budgetClaims(h)).toEqual({ warning: false, handoff: true });
    expect(rolloverRows(rows)).toHaveLength(0);
  });

  test.each(["larger-model", "mode-inactive"] as const)(
    "a pending handoff is omitted when the dispatching send uses a %s",
    async (change) => {
      const h = await setup();
      expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
      const nextOptions: SendMessageOptions =
        change === "larger-model"
          ? { ...options, model: "openai:gpt-4.1" }
          : { ...options, experiments: { tokenBudget: false } };
      expect(h.session.queueMessage("Next request", nextOptions)).not.toBeNull();
      expect((await h.requests[0].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
      h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
      await h.waitForRequest(2);
      const rows = await allRows(h);
      expect(warningRows(rows)).toHaveLength(0);
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(budgetClaims(h)).toEqual({ warning: false, handoff: false });
      if (change === "mode-inactive") {
        // The ordinary auto-compaction path owns that send; no budget callback is installed.
        expect(h.requests[1].onStepSettled).toBeUndefined();
      } else {
        expect(text(rows.at(-1)!)).toBe("Next request");
        expect(h.requests[1].modelString).toBe("openai:gpt-4.1");
      }
    }
  );

  test("removing the queued advisory Continue does not lose the advisory itself", async () => {
    const h = await setup();
    expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
    expect((await h.requests[0].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
    expect(
      h.session.removeQueuedMessagesByDedupeKeyPrefix(CONTEXT_WARNING_DEDUPE_KEY, "removed")
    ).toBe(1);
    h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
    await h.session.waitForIdle();
    expect(h.requests).toHaveLength(1);
    expect(warningRows(await allRows(h))).toHaveLength(0);
    // The next real send derives the advisory from usage, not from the dropped intent.
    expect((await h.session.sendMessage("Follow-up", options)).success).toBe(true);
    const rows = await allRows(h);
    expect(warningRows(rows).map(isHandoffRow)).toEqual([true]);
    expect(text(rows.at(-1)!)).toBe("Follow-up");
    expect(budgetClaims(h)).toEqual({ warning: false, handoff: true });
  });

  test.each(["stop", "failed-publication", "restart-before", "restart-after"] as const)(
    "the handoff is published exactly once across a %s",
    async (interruption) => {
      let h = await setup();
      expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
      expect((await h.requests[0].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
      expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(true);
      // Intent alone claims nothing; only a durable row does.
      expect(budgetClaims(h)).toEqual({ warning: false, handoff: false });
      // The committed partial keeps the usage the interrupted stream reached.
      const persistUsage = () =>
        h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("stopped-answer", "assistant", "Partial work", {
            model,
            contextUsage: { inputTokens: 90_000, outputTokens: 10, totalTokens: 90_010 },
          })
        );
      switch (interruption) {
        case "stop": {
          spyOn(h.aiService, "stopStream").mockImplementation(() => {
            h.aiEmitter.emit("stream-abort", {
              type: "stream-abort",
              workspaceId,
              messageId: "assistant-1",
              abortReason: "user",
              metadata: { duration: 1 },
            });
            h.completions[0].settle({
              status: "aborted",
              abortReason: "user",
              streamAbort: { type: "stream-abort", workspaceId, metadata: { duration: 1 } },
            });
            return Promise.resolve(Ok(undefined));
          });
          expect((await h.session.interruptStream()).success).toBe(true);
          await h.session.waitForIdle();
          expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
          expect((await persistUsage()).success).toBe(true);
          break;
        }
        case "failed-publication": {
          spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
            (...args) => {
              const operation = args[2];
              expect(operation.kind === "append" && warningRows(operation.messages)).toHaveLength(
                1
              );
              return Promise.resolve(Err("disk full"));
            }
          );
          h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
          await h.session.waitForIdle();
          expect(h.requests).toHaveLength(1);
          break;
        }
        case "restart-before": {
          expect((await persistUsage()).success).toBe(true);
          await h.session.dispose();
          h = await setup({ previous: h });
          break;
        }
        case "restart-after": {
          h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
          await h.waitForRequest(2);
          expect(warningRows(await allRows(h)).filter(isHandoffRow)).toHaveLength(1);
          await h.session.dispose();
          h = await setup({ previous: h });
          break;
        }
      }
      if (interruption !== "restart-after") expect(warningRows(await allRows(h))).toHaveLength(0);
      // Without a durable row the next send publishes the handoff from persisted usage and the
      // dispatching permissions; with one, it publishes nothing more.
      expect((await h.session.sendMessage("Resume the work", options)).success).toBe(true);
      const rows = await allRows(h);
      expect(warningRows(rows).map(isHandoffRow)).toEqual([true]);
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(budgetClaims(h)).toEqual({ warning: false, handoff: true });
      const latest = h.requests.at(-1)!;
      for (const usage of [85_000, 95_000])
        expect((await latest.onStepSettled?.(step(usage)))?.decision).toBe("continue");
      expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
    }
  );

  test.each([
    // The real-encoding count leaves no room for an advisory row where the heuristic alone would.
    { toolResultTokens: 18_500, advisory: false },
    { toolResultTokens: 1_000, advisory: true },
  ])(
    "dispatch screens the pending handoff against the encoded last-step outputs (advisory=$advisory)",
    async ({ toolResultTokens, advisory }) => {
      const h = await setup();
      const stale = "s".repeat(400_000);
      const settled = "d".repeat(4_000);
      const toolPart = (toolCallId: string, output: string): MuxMessage["parts"][number] => ({
        type: "dynamic-tool",
        toolName: "bash",
        toolCallId,
        state: "output-available",
        input: {},
        output,
      });
      const last = createMuxMessage("old-answer", "assistant", "Ran tools", {
        model,
        contextUsage: { inputTokens: 100_000, outputTokens: 10, totalTokens: 100_010 },
        // Only the last step's outputs are still unaccounted for by the reported usage.
        stepStartPartIndices: [0, 2],
      });
      last.parts.push(toolPart("earlier-step", stale), toolPart("last-step", settled));
      expect(
        (
          await h.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("old-user", "user", "Previous request"),
            last,
          ])
        ).success
      ).toBe(true);
      const counted = spyOn(budgetCounting, "estimateToolResultTokensForModel").mockResolvedValue(
        toolResultTokens
      );
      // The send itself is screened against the persisted outputs first.
      expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
      expect(counted).toHaveBeenCalledWith([settled], expect.anything());
      expect(
        counted.mock.calls.some(([outputs]) => Array.isArray(outputs) && outputs.includes(stale))
      ).toBe(false);
      let rows = await allRows(h);
      expect(warningRows(rows)).toHaveLength(advisory ? 1 : 0);
      if (!advisory) {
        // Settlement sees no persisted outputs and asks for the handoff; dispatch screens again.
        expect((await h.requests[0].onStepSettled?.(step(100_000)))?.decision).toBe("warn");
        h.settleStream(0, { contextUsage: { inputTokens: 100_000 } });
        await h.waitForRequest(2);
        rows = await allRows(h);
        expect(warningRows(rows)).toHaveLength(0);
        expect(text(rows.at(-1)!)).toBe("Continue");
      }
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(budgetClaims(h).handoff).toBe(advisory);
    }
  );

  test("a text-only completion queues nothing; the next real send carries the advisory once", async () => {
    const h = await setup();
    expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
    expect((await h.requests[0].onStepSettled?.(step(50_000)))?.decision).toBe("continue");
    // The reply finished without another tool step while usage grew into the handoff band.
    h.settleStream(0, { finishReason: "stop", contextUsage: { inputTokens: 92_000 } });
    await h.session.waitForIdle();
    expect(h.session.hasQueuedMessages()).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(warningRows(await allRows(h))).toHaveLength(0);
    expect((await h.session.sendMessage("Next real request", options)).success).toBe(true);
    let rows = await allRows(h);
    expect(warningRows(rows).map(isHandoffRow)).toEqual([true]);
    expect(rows.filter((row) => text(row) === "Continue")).toHaveLength(0);
    h.settleStream(1, { finishReason: "stop", contextUsage: { inputTokens: 93_000 } });
    await h.session.waitForIdle();
    expect((await h.session.sendMessage("And another", options)).success).toBe(true);
    rows = await allRows(h);
    expect(warningRows(rows)).toHaveLength(1);
    expect(rolloverRows(rows)).toHaveLength(0);
    expect(h.requests).toHaveLength(3);
  });

  test("an advisory that overflows at assembly takes the emergency path without a stale claim", async () => {
    const h = await setup({ failure: (attempt) => (attempt === 2 ? exceeded : undefined) });
    expect((await h.session.sendMessage("Start work", options)).success).toBe(true);
    expect((await h.requests[0].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
    h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
    await h.waitForRequest(3);
    const rows = await allRows(h);
    const [reset] = rolloverRows(rows);
    expect(reset.metadata?.muxMetadata).toMatchObject({ reason: "context-exceeded" });
    const handoff = warningRows(rows);
    expect(handoff.map(isHandoffRow)).toEqual([true]);
    expect(handoff[0].metadata!.historySequence!).toBeLessThan(reset.metadata!.historySequence!);
    // The sealed advisory neither travels into the fresh window nor claims it.
    const fresh = sliceMessagesForProviderFromLatestContextBoundary(h.requests[2].messages);
    expect(warningRows(fresh)).toHaveLength(0);
    expect(text(fresh.findLast((row) => row.role === "user")!)).toBe("Continue");
    expect(budgetClaims(h)).toEqual({ warning: false, handoff: false });
    expect((await h.requests[2].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
    expect(h.requests).toHaveLength(3);
  });

  test("a handoff continuation stays ordinary goal work", async () => {
    const h = await setup({ goals: true });
    assert(h.goalAccounting, "Expected an injected goal service");
    const { recordStreamAccounting, previewStreamAccounting } = h.goalAccounting;
    expect(
      (
        await h.session.sendMessage("Goal work", options, {
          synthetic: true,
          agentInitiated: true,
          goalKind: GOAL_CONTINUATION_KIND,
          goalId: "goal-budget",
        })
      ).success
    ).toBe(true);
    await emitUsageDelta(h);
    expect(previewStreamAccounting).toHaveBeenCalledTimes(1);
    expect((await h.requests[0].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
    h.settleStream(0, { contextUsage: { inputTokens: 90_000 } });
    await h.waitForRequest(2);
    expect(recordStreamAccounting).toHaveBeenCalledTimes(1);
    const rows = await allRows(h);
    expect(isHandoffRow(rows.at(-2)!)).toBe(true);
    expect(rows.at(-1)?.metadata).toMatchObject({
      kind: GOAL_CONTINUATION_KIND,
      goalId: "goal-budget",
    });
    // Unlike the retired hidden flush turn, the continuation's usage is goal usage.
    await emitUsageDelta(h);
    expect(previewStreamAccounting).toHaveBeenCalledTimes(2);
    h.settleStream(1, { finishReason: "stop" });
    await h.session.waitForIdle();
    expect(recordStreamAccounting).toHaveBeenCalledTimes(2);
    expect(recordStreamAccounting.mock.calls.map(([input]) => input.streamOriginKind)).toEqual([
      "goal_continuation",
      "goal_continuation",
    ]);
  });

  // Older builds offered a hidden notes-flush step before sealing a window. New windows never
  // write those rows; the durable ones already on disk must still finish as one bounded step.
  test("a resumed legacy flush stays one bounded step, then seals the window", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first, { muxMetadata: correlation });
    await first.session.dispose();
    const h = await setup({ previous: first });
    const sendOptions = { ...resumeOptions, maxOutputTokens: 300, thinkingLevel: "high" as const };
    expect((await h.session.resumeStream(sendOptions)).success).toBe(true);
    // The sealing intent is restored up front; the flush itself runs memory-only at the lowest
    // thinking with the bounded cap, whatever the caller configured.
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
    expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
    expect(h.requests[0].muxMetadata).toMatchObject({ contextBudgetFlush: true });
    expect(h.requests[0].requestAssemblySnapshot?.preservesToolset).toBe(true);
    expect(h.requests[0].thinkingLevel).toBe("off");
    expect(h.requests[0].maxOutputTokens).toBe(FLUSH_MAX_OUTPUT_TOKENS);
    expect(FLUSH_MAX_OUTPUT_TOKENS).toBeGreaterThan(300);
    // Bounded to one step although the resumed step crosses nothing; its memory-only toolset
    // reports session_history as unavailable, which must not queue a second flush either.
    const outcome = await h.requests[0].onStepSettled!(
      step(50_000, { sessionHistoryAvailable: false })
    );
    expect(outcome.decision).toBe("rollover");
    expect(outcome.continuationEntryId).toBeDefined();
    // Legacy flush recovery must still identify the paired rollover as its exact successor.
    expect(h.session.getQueueCutReceipt(outcome.continuationEntryId!)?.successor).toBe("pending");
    expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
    h.settleStream(0);
    await h.waitForRequest(2);
    expect(h.session.getQueueCutReceipt(outcome.continuationEntryId!)?.successor).toBe("streaming");
    const rows = await allRows(h);
    expect(warningRows(rows).filter(isFinalFlushRow)).toHaveLength(1);
    expect(warningRows(rows)).toHaveLength(1);
    const [reset] = rolloverRows(rows);
    // The reset keeps the budget the legacy row promised, not the current ceiling.
    expect(reset.metadata?.muxMetadata).toMatchObject({
      reason: "mid-stream",
      flushOpportunity: true,
      budgetTokens: 96_000,
    });
    expect(rows.at(-1)?.metadata).toMatchObject({
      synthetic: true,
      retrySendOptions: { agentInitiated: true },
      muxMetadata: { ...correlation, contextBudgetContinuation: true },
    });
    expect(text(rows.at(-1)!)).toBe("Continue");
    expect(h.requests[1].muxMetadata).not.toHaveProperty("contextBudgetFlush");
    expect(h.requests[1].thinkingLevel).toBe("high");
    expect(h.requests[1].maxOutputTokens).toBe(300);
    // Neither the trigger text nor its flag reaches the fresh window, and the legacy claim does
    // not suppress the fresh window's own advisories.
    expect(
      sliceMessagesForProviderFromLatestContextBoundary(h.requests[1].messages).some(
        (row) =>
          text(row) === LEGACY_FLUSH_TRIGGER ||
          row.metadata?.muxMetadata?.contextBudgetFlush === true
      )
    ).toBe(false);
    expect((await h.requests[1].onStepSettled?.(step(90_000)))?.decision).toBe("warn");
  });

  test("a persisted legacy flush resumed with token-budget mode disabled stays bounded to one step", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    await first.session.dispose();
    const h = await setup({ previous: first });
    const disabled = { ...options, experiments: { tokenBudget: false } };
    expect((await h.session.resumeStream(disabled)).success).toBe(true);
    // The hidden trigger keeps its memory-only ceiling and a pinned middleware chain, but nothing
    // restores the promised reset.
    expect(h.requests[0].muxMetadata).toMatchObject({ contextBudgetFlush: true });
    expect(h.requests[0].requestAssemblySnapshot?.preservesToolset).toBe(true);
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(false);
    // The settled-step callback still ends the turn after its single step.
    expect((await h.requests[0].onStepSettled?.(step(50_000)))?.decision).toBe("rollover");
    h.settleStream(0, { finishReason: "stop" });
    await h.session.waitForIdle();
    expect(h.requests).toHaveLength(1);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
    // Re-enabling the mode later cannot seal the window with the stale legacy intent.
    expect((await h.session.sendMessage("Follow-up", options)).success).toBe(true);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
  });

  test("a persisted legacy flush resumed with the mode disabled runs tool-less when no chain can be pinned", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    await first.session.dispose();
    const h = await setup({ previous: first });
    const unregister = eventSpine.useBefore(
      "request.assemble",
      (ctx) => {
        delete ctx.tools.session_history;
      },
      { workspaceId }
    );
    try {
      expect(
        (await h.session.resumeStream({ ...options, experiments: { tokenBudget: false } })).success
      ).toBe(true);
      expect(h.requests[0].muxMetadata).toMatchObject({ contextBudgetFlush: true });
      expect(h.requests[0].requestAssemblySnapshot).toBeUndefined();
      expect(applyToolPolicyToNames(["memory"], h.requests[0].toolPolicy)).toEqual([]);
    } finally {
      unregister();
    }
  });

  test("resuming a persisted legacy flush re-validates rollover admission first", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    await first.session.dispose();
    const h = await setup({ previous: first });
    const unregister = eventSpine.useBefore(
      "request.assemble",
      (ctx) => {
        delete ctx.tools.session_history;
      },
      { workspaceId }
    );
    try {
      expect(await h.session.resumeStream(options)).toMatchObject({
        success: false,
        error: { type: "context_budget_blocked" },
      });
      expect(h.requests).toHaveLength(0);
      expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(false);
    } finally {
      unregister();
    }
  });

  test("resuming a legacy flush without a writable memory tool degrades it to a tool-less step", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    await first.session.dispose();
    const h = await setup({ previous: first });
    // The Memory experiment was turned off before the restart resume.
    expect(
      (
        await h.session.resumeStream({
          ...options,
          experiments: { tokenBudget: true, memory: false },
        })
      ).success
    ).toBe(true);
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
    expect(applyToolPolicyToNames(["memory", "bash"], h.requests[0].toolPolicy)).toEqual([]);
    h.settleStream(0, { finishReason: "stop" });
    await h.waitForRequest(2);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
  });

  test("middleware registered during a resumed legacy flush cannot block the promised reset", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    await first.session.dispose();
    const h = await setup({ previous: first });
    expect((await h.session.resumeStream(resumeOptions)).success).toBe(true);
    expect(h.requests[0].requestAssemblySnapshot?.preservesToolset).toBe(true);
    const unregister = eventSpine.useBefore(
      "request.assemble",
      (ctx) => {
        delete ctx.tools.session_history;
      },
      { workspaceId }
    );
    try {
      expect((await h.requests[0].onStepSettled?.(step(112_000)))?.decision).toBe("rollover");
      h.settleStream(0);
      await h.waitForRequest(2);
      expect(rolloverRows(await allRows(h))).toHaveLength(1);
      // The reset is pinned to the snapshot admitted with the resume, not the changed registry.
      expect(h.requests[1].requestAssemblySnapshot?.preservesToolset).toBe(true);
    } finally {
      unregister();
    }
  });

  test.each(["settled-step", "text-only"] as const)(
    "disabling rollover while a resumed legacy flush runs drops the reset but keeps the Continue (%s)",
    async (ending) => {
      const first = await setup();
      await seedLegacyFlushTurn(first, { muxMetadata: correlation });
      await first.session.dispose();
      const h = await setup({ previous: first });
      expect((await h.session.resumeStream(resumeOptions)).success).toBe(true);
      expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
      await seedThreshold(h, 1);
      if (ending === "settled-step")
        expect((await h.requests[0].onStepSettled?.(step(112_000)))?.decision).toBe("rollover");
      // The paired continuation survives as an ordinary same-turn continuation: the delegated
      // turn's outcome is the resumed work, never the notes-only flush finish.
      expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
      h.settleStream(0, { finishReason: "stop" });
      await h.waitForRequest(2);
      let rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(text(rows.at(-1)!)).toBe("Continue");
      expect(rows.at(-1)?.metadata?.muxMetadata).toMatchObject(correlation);
      expect(h.requests[1].muxMetadata).not.toHaveProperty("contextBudgetFlush");
      h.settleStream(1, { finishReason: "stop" });
      await h.session.waitForIdle();
      await seedThreshold(h, 0.7);
      expect((await h.session.sendMessage("Follow-up", options)).success).toBe(true);
      rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(0);
      // The window's handoff advisory may still ride this send; no second legacy flush does.
      expect(warningRows(rows).filter(isFinalFlushRow)).toHaveLength(1);
    }
  );

  test("a crash after only the legacy flush placeholder keeps the notes-writing step", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    // The builder appends an empty assistant placeholder before any output exists.
    const placeholder = createMuxMessage("flush-placeholder", "assistant", "", {
      model,
      partial: true,
    });
    expect((await first.historyService.appendToHistory(workspaceId, placeholder)).success).toBe(
      true
    );
    await first.session.dispose();
    const h = await setup({ previous: first });
    expect((await h.session.resumeStream(resumeOptions)).success).toBe(true);
    expect(h.requests[0].muxMetadata).toMatchObject({ contextBudgetFlush: true });
    expect(applyToolPolicyToNames(["memory", "bash"], h.requests[0].toolPolicy)).toEqual([
      "memory",
      "bash",
    ]);
  });

  test("an emergency rollover during a resumed legacy flush sanitizes the flush trigger", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    await first.session.dispose();
    const h = await setup({ previous: first });
    expect((await h.session.resumeStream(resumeOptions)).success).toBe(true);
    expect(h.requests[0].muxMetadata).toMatchObject({ contextBudgetFlush: true });
    const streamError = {
      workspaceId,
      messageId: "assistant-1",
      error: "context limit",
      errorType: "context_exceeded" as const,
      contextBudgetExceeded: {
        type: "context_budget_exceeded" as const,
        model,
        estimate: 127_000,
        hardCeiling: 119_808,
      },
    };
    h.aiEmitter.emit("error", streamError);
    h.completions[0].settle({ status: "failed", streamError });
    expect(await h.session.waitForPendingStreamErrorRecoveryDecision("assistant-1")).toBe(
      "retry-started"
    );
    await h.waitForRequest(2);
    const rows = await allRows(h);
    const [reset] = rolloverRows(rows);
    expect(reset.metadata?.muxMetadata).toMatchObject({ reason: "context-exceeded" });
    const fresh = sliceMessagesForProviderFromLatestContextBoundary(rows);
    const trigger = fresh.findLast((row) => row.role === "user")!;
    expect(text(trigger)).toBe("Continue");
    expect(trigger.metadata?.muxMetadata).not.toHaveProperty("contextBudgetFlush");
    // The sanitized retry carries neither the internal trigger text nor its flag, so the request
    // builder applies the ordinary toolset again.
    const leaked = (row: MuxMessage) =>
      text(row) === LEGACY_FLUSH_TRIGGER || row.metadata?.muxMetadata?.contextBudgetFlush === true;
    expect(fresh.some(leaked)).toBe(false);
    expect(h.requests[1].messages.some(leaked)).toBe(false);
    expect(h.requests[1].muxMetadata).not.toHaveProperty("contextBudgetFlush");
  });

  test("a legacy flush whose step already completed before a crash gets no second memory call", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    // The flush step's memory call settled into the partial before the crash. StreamManager
    // first persists an assistant placeholder to reserve its history sequence.
    const partial = createMuxMessage("flush-partial", "assistant", "", {
      model,
      partial: true,
      stepStartPartIndices: [0],
    });
    expect((await first.historyService.appendToHistory(workspaceId, partial)).success).toBe(true);
    partial.parts = [
      {
        type: "dynamic-tool",
        toolName: "memory",
        toolCallId: "flush-write",
        state: "output-available",
        input: { command: "create", path: "/memories/workspace/context-notes.md", file_text: "x" },
        output: { success: true },
      },
    ];
    expect((await first.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    await first.session.dispose();
    const h = await setup({ previous: first });
    expect((await h.session.resumeStream(resumeOptions)).success).toBe(true);
    expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
    expect(h.requests[0].muxMetadata).toMatchObject({ contextBudgetFlush: true });
    // No tools at all: the resumed turn can only end, then the queued rollover seals the window.
    expect(applyToolPolicyToNames(["memory", "session_history"], h.requests[0].toolPolicy)).toEqual(
      []
    );
    h.settleStream(0, { finishReason: "stop" });
    await h.waitForRequest(2);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
  });

  test("a resumed legacy flush stream is exempt from goal accounting; its continuation is not", async () => {
    const first = await setup();
    await seedLegacyFlushTurn(first);
    await first.session.dispose();
    const h = await setup({ previous: first, goals: true });
    assert(h.goalAccounting, "Expected an injected goal service");
    const { recordStreamAccounting, previewStreamAccounting } = h.goalAccounting;
    expect((await h.session.resumeStream(resumeOptions)).success).toBe(true);
    expect(h.requests[0].muxMetadata).toMatchObject({ contextBudgetFlush: true });
    // Neither the live preview nor the final accounting sees the housekeeping stream's usage.
    await emitUsageDelta(h);
    expect(previewStreamAccounting).not.toHaveBeenCalled();
    h.settleStream(0, { finishReason: "stop" });
    await h.waitForRequest(2);
    expect(recordStreamAccounting).not.toHaveBeenCalled();
    // The paired continuation is an ordinary stream again.
    expect(h.requests[1].muxMetadata).not.toHaveProperty("contextBudgetFlush");
    await emitUsageDelta(h);
    expect(previewStreamAccounting).toHaveBeenCalledTimes(1);
    h.settleStream(1, { finishReason: "stop" });
    await h.session.waitForIdle();
    expect(recordStreamAccounting).toHaveBeenCalledTimes(1);
  });

  const exceeded: SendMessageError = {
    type: "context_budget_exceeded",
    model,
    estimate: 127_000,
    hardCeiling: 119_808,
  };
  test("an edited request can recover its own pre-handle budget overflow", async () => {
    const h = await setup({ failure: (attempt) => (attempt === 1 ? exceeded : undefined) });
    await seedHistory(h, 20_000);
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("edit-target", "user", "Original request")
    );

    expect(
      (
        await h.session.sendMessage("Edited request", {
          ...options,
          editMessageId: "edit-target",
        })
      ).success
    ).toBe(true);
    const retry = await h.secondRequest.promise;
    expect(h.requests).toHaveLength(2);
    const active = sliceMessagesForProviderFromLatestContextBoundary(retry.messages);
    expect(
      active.filter((row) => row.role === "user" && !row.metadata?.synthetic).map(text)
    ).toEqual(["Edited request"]);
    expect(active.some((row) => row.id === "old-answer")).toBe(false);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
  });

  test.each(
    (["file", "skill", "deduped-skill", "family"] as const).flatMap((kind) =>
      [false, true].flatMap((asyncFailure) =>
        [false, true].map((fits) => ({ kind, asyncFailure, fits }))
      )
    )
  )(
    "emergency admission uses failing model for $kind (async=$asyncFailure, fits=$fits)",
    async ({ kind, asyncFailure, fits }) => {
      const fallbackModel = "openai:gpt-4o-mini";
      const fallbackExceeded = {
        type: "context_budget_exceeded" as const,
        model: fallbackModel,
        estimate: 11000,
        hardCeiling: 7500,
      };
      const failure = (attempt: number) =>
        !asyncFailure && attempt === 1 ? fallbackExceeded : undefined;
      let h = await setup(kind === "deduped-skill" ? undefined : { failure });
      const content = ("漢".repeat(100) + "\n").repeat(fits ? 1 : 40);
      let message = "Use the accepted input";
      let sendOptions = options;
      const usesSkill = kind === "skill" || kind === "deduped-skill";
      if (kind === "file") {
        await fs.writeFile(path.join(h.config.rootDir, "fallback.txt"), content);
        message = "Read @fallback.txt";
      } else if (usesSkill) {
        const skillDir = path.join(h.config.rootDir, ".xum", "skills", "fallback-skill");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          "---\nname: fallback-skill\ndescription: Fallback admission\n---\n" +
            "!`printf x >> fallback-materializations.marker`\n" +
            content
        );
        sendOptions = {
          ...options,
          muxMetadata: {
            type: "agent-skill",
            rawCommand: "/fallback-skill",
            skillName: "fallback-skill",
            scope: "project",
          },
        };
        spyOn(h.aiService, "isExperimentEnabled").mockImplementation(
          (id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT
        );
        if (kind === "deduped-skill") {
          expect(
            (await h.session.sendMessage("Earlier skill invocation", sendOptions)).success
          ).toBe(true);
          await h.session.dispose();
          h = await setup({ previous: h, failure });
          spyOn(h.aiService, "isExperimentEnabled").mockImplementation(
            (id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT
          );
        }
      }
      await seedHistory(h, 20000);
      const original = await allRows(h);
      spyOn(contextLimits, "getEffectiveContextLimit").mockImplementation((requestedModel) =>
        requestedModel === fallbackModel ? 10000 : 128000
      );
      const cleanup = spyOn(h.session, "applyContextResetSideEffects");
      const payload = createMuxMessage("fallback-family", "assistant", content, {
        synthetic: true,
        muxMetadata: { type: "family-message" },
      });
      const sent = await h.session.sendMessage(
        message,
        sendOptions,
        kind === "family"
          ? { synthetic: true, agentInitiated: true, preTurnMessages: [payload] }
          : undefined
      );
      if (asyncFailure) {
        expect(sent.success).toBe(true);
        expect(cleanup).not.toHaveBeenCalled();
        const streamError = {
          workspaceId,
          messageId: "assistant-1",
          error: "Fallback request is too large",
          errorType: "context_exceeded" as const,
          contextBudgetExceeded: fallbackExceeded,
        };
        h.aiEmitter.emit("error", streamError);
        h.completions[0].settle({ status: "failed", streamError });
        expect(await h.session.waitForPendingStreamErrorRecoveryDecision("assistant-1")).toBe(
          fits ? "retry-started" : "terminal"
        );
        if (!fits) await h.session.waitForIdle();
      } else {
        expect(sent.success).toBe(fits);
        if (!fits) expect(sent).toMatchObject({ error: { type: "context_budget_blocked" } });
      }
      expect(cleanup).toHaveBeenCalledTimes(fits ? 1 : 0);
      expect(h.requests).toHaveLength(fits ? 2 : 1);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(fits ? 1 : 0);
      expect(rows.filter((row) => original.some((old) => old.id === row.id))).toEqual(original);
      if (fits) {
        expect(h.requests[1].modelString).toBe(fallbackModel);
        const active = sliceMessagesForProviderFromLatestContextBoundary(h.requests[1].messages);
        expect(active.some((row) => text(row).includes(content.trim()))).toBe(true);
        expect(active.some((row) => row.id === "old-answer")).toBe(false);
      } else {
        const rejected = rows.filter((row) => row.metadata?.contextBudgetRejected);
        expect(rejected).toHaveLength(kind === "deduped-skill" ? 1 : 2);
        expect(rejected.every((row) => row.role === "assistant" && row.parts.length === 0)).toBe(
          true
        );
        expect(
          rejected
            .map(restoreContextBudgetRejectedMessageForDisplay)
            .some((row) => text(row) === message)
        ).toBe(true);
        if (kind !== "deduped-skill")
          expect(
            rejected
              .map(restoreContextBudgetRejectedMessageForDisplay)
              .some((row) => text(row).includes(content.trim()))
          ).toBe(true);
      }
      if (usesSkill)
        expect(
          await fs.readFile(path.join(h.config.rootDir, "fallback-materializations.marker"), "utf8")
        ).toBe(kind === "deduped-skill" ? "xx" : "x");
    }
  );

  test.each(["interrupt", "shutdown", "dispose"] as const)(
    "%s while admitting an emergency retry cannot clear or publish a new window",
    async (action) => {
      const fallbackModel = "openai:gpt-4o-mini";
      const h = await setup({
        failure: (attempt) => (attempt === 1 ? { ...exceeded, model: fallbackModel } : undefined),
      });
      await seedHistory(h, 20000);
      const cleanup = spyOn(h.session, "applyContextResetSideEffects");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const count = budgetCounting.estimateFreshRequestTokensForModel;
      spyOn(budgetCounting, "estimateFreshRequestTokensForModel").mockImplementation(
        async (input, model) => {
          const estimate = await count(input, model);
          if (model.model === fallbackModel) {
            entered.resolve();
            await release.promise;
          }
          return estimate;
        }
      );
      const send = h.session.sendMessage("Accepted trigger", options, {
        synthetic: true,
        preTurnMessages: [
          createMuxMessage("cancel-family", "assistant", "Accepted payload", { synthetic: true }),
        ],
      });
      await entered.promise;
      const before = await allRows(h);
      if (action === "interrupt") expect((await h.session.interruptStream()).success).toBe(true);
      else if (action === "shutdown") h.session.beginShutdown();
      const disposal = action === "dispose" ? h.session.dispose() : undefined;
      release.resolve();
      await send;
      await disposal;
      expect(cleanup).not.toHaveBeenCalled();
      expect(h.requests).toHaveLength(1);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(0);
      expect(
        rows
          .map(restoreContextBudgetRejectedMessageForDisplay)
          .map((row) => ({ id: row.id, text: text(row) }))
      ).toEqual(before.map((row) => ({ id: row.id, text: text(row) })));
    }
  );

  test.each([false, true])(
    "accepted budget failure settles its preparation callback before terminal policy (rollover=%s)",
    async (rollover) => {
      const h = await setup({ failure: () => exceeded });
      if (rollover) await seedHistory(h, 20_000);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let busyDuringCallback = false;
      let terminalBeforeCallback = false;
      const onFailure = mock(async (_error: SendMessageError) => {
        busyDuringCallback = h.session.isBusy();
        terminalBeforeCallback = h.events.some((event) => event.type === "stream-error");
        entered.resolve();
        await release.promise;
      });
      const sending = h.session.sendMessage("Accepted budget request", options, {
        onAcceptedPreStreamFailure: onFailure,
      });
      try {
        await entered.promise;
        expect(busyDuringCallback).toBe(true);
        expect(terminalBeforeCallback).toBe(false);
        expect(h.requests).toHaveLength(rollover ? 2 : 1);
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledWith(
          expect.objectContaining({ type: "context_budget_blocked" })
        );
        release.resolve();
        expect(await sending).toMatchObject({
          success: false,
          error: { type: "context_budget_blocked" },
        });
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(rolloverRows(await allRows(h))).toHaveLength(rollover ? 1 : 0);
      } finally {
        release.resolve();
        await sending;
      }
    }
  );

  test.each([false, true])(
    "preflight retries once; fresh overflow blocked=%s",
    async (alwaysFail) => {
      const h = await setup({
        failure: (attempt) => (alwaysFail || attempt === 1 ? exceeded : undefined),
      });
      await seedHistory(h, 20_000);
      const result = await h.session.sendMessage("Accepted user request", options);
      expect(result.success).toBe(!alwaysFail);
      if (alwaysFail) expect(result).toMatchObject({ error: { type: "context_budget_blocked" } });
      expect(h.requests).toHaveLength(2);
      expect(rolloverRows(await allRows(h))).toHaveLength(1);
      const providerRows = sliceMessagesForProviderFromLatestContextBoundary(
        h.requests[1].messages
      );
      expect(providerRows.some((row) => row.id === "old-answer")).toBe(false);
      expect(text(providerRows.at(-1)!)).toBe("Accepted user request");
    }
  );

  test("a primary on-send rollover followed by fresh preflight overflow is blocked without a second reset", async () => {
    const h = await setup({ failure: () => exceeded });
    await seedHistory(h, 120_000);
    const result = await h.session.sendMessage("Still too big after assembly", options);
    expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
    expect(h.requests).toHaveLength(1);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
  });

  test("restart does not treat a fresh continuation's owned assistant payload as older context", async () => {
    const original = await setup();
    const rollover: ContextWindowRollover = {
      type: "context-window-rollover",
      rolloverId: "crashed-fresh-retry",
      reason: "context-exceeded",
      previousWindowId: "w:0",
      flushOpportunity: false,
      contextTokens: 127000,
      maxTokens: 128000,
    };
    const payload = createMuxMessage(
      "copied-family-payload",
      "assistant",
      "Accepted family payload",
      { synthetic: true, uiVisible: false, muxMetadata: { type: "family-message" } }
    );
    const continuation = createMuxMessage(
      "accepted-continuation",
      "user",
      "Continue the same request",
      {
        requestPreludeMessageIds: [payload.id],
        muxMetadata: { type: "context-window-continuation", rolloverId: rollover.rolloverId },
      }
    );
    expect(
      (
        await original.historyService.appendManyToHistory(workspaceId, [
          ...createRolloverPrefix(rollover),
          payload,
          continuation,
        ])
      ).success
    ).toBe(true);
    await original.session.dispose();
    const resumed = await setup({ previous: original, failure: () => exceeded });
    expect(await resumed.session.resumeStream(options)).toMatchObject({
      success: false,
      error: { type: "context_budget_blocked" },
    });
    expect(resumed.requests).toHaveLength(1);
    expect(rolloverRows(await allRows(resumed))).toHaveLength(1);
  });

  test("damaged prelude ownership cannot hide real older conversation from emergency eligibility", async () => {
    const h = await setup({
      failure: async (attempt) => {
        if (attempt !== 1) return undefined;
        const rows = await allRows(h);
        const user = rows.at(-1)!;
        expect(
          (
            await h.historyService.updateHistory(workspaceId, {
              ...user,
              metadata: {
                ...user.metadata,
                requestPreludeMessageIds: rows.slice(0, -1).map((row) => row.id),
              },
            })
          ).success
        ).toBe(true);
        return exceeded;
      },
    });
    await seedHistory(h, 20_000);
    expect((await h.session.sendMessage("Retry with real prior context", options)).success).toBe(
      true
    );
    expect(h.requests).toHaveLength(2);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
  });

  test("preflight failure in an already fresh window does not reset or rebuild", async () => {
    const h = await setup({ failure: () => exceeded });
    const result = await h.session.sendMessage("Too large after assembly", options);
    expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
    expect(h.requests).toHaveLength(1);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
  });

  test.each([false, true])(
    "provider context_exceeded only retries without prior deltas (delta=%s)",
    async (hadDelta) => {
      const h = await setup();
      await seedHistory(h, 20_000);
      expect((await h.session.sendMessage("Continue my task", options)).success).toBe(true);
      if (hadDelta) {
        h.aiEmitter.emit("stream-delta", {
          type: "stream-delta",
          workspaceId,
          messageId: "assistant-1",
          delta: "Already answered",
        });
      }
      async function fail(attempt: number) {
        const streamError = {
          workspaceId,
          messageId: `assistant-${attempt}`,
          error: "context limit",
          errorType: "context_exceeded" as const,
        };
        h.aiEmitter.emit("error", streamError);
        h.completions[attempt - 1].settle({ status: "failed", streamError });
        return h.session.waitForPendingStreamErrorRecoveryDecision(streamError.messageId);
      }
      expect(await fail(1)).toBe(hadDelta ? "terminal" : "retry-started");
      expect(h.requests).toHaveLength(hadDelta ? 1 : 2);
      expect(rolloverRows(await allRows(h))).toHaveLength(hadDelta ? 0 : 1);
      if (!hadDelta) {
        expect(await fail(2)).toBe("terminal");
        expect(h.requests).toHaveLength(2);
        expect(rolloverRows(await allRows(h))).toHaveLength(1);
      }
    }
  );

  /**
   * Records the recovery path's preparation fence and the protected calls it guards. Each
   * valid fence check queues a microtask; protected work that starts before that microtask
   * runs proves the session did not yield between the check and the call.
   *
   * The marker is a real promise reaction, not `queueMicrotask`: another suite in the shared
   * Bun process replaces the global with a synchronous stub, which would record the marker
   * inside the fence check itself and fail this witness for the wrong reason.
   */
  function armRecoveryFenceWitness(h: Awaited<ReturnType<typeof setup>>) {
    const controller = Reflect.get(h.session, "contextController") as SessionContextController;
    const session = h.session as unknown as {
      applyContextResetSideEffects(...args: unknown[]): Promise<void>;
      appendContextRolloverRows(...args: unknown[]): Promise<Result<void>>;
    };
    const order: string[] = [];
    let validated = 0;
    const validate = controller.validatePreparation.bind(controller);
    const validateSpy = spyOn(controller, "validatePreparation").mockImplementation((receipt) => {
      const valid = validate(receipt);
      if (valid) {
        const tag = ++validated;
        order.push(`validate:${tag}`);
        void Promise.resolve().then(() => order.push(`microtask:${tag}`));
      }
      return valid;
    });
    const apply = session.applyContextResetSideEffects.bind(session);
    const applySpy = spyOn(session, "applyContextResetSideEffects").mockImplementation(
      (...args) => {
        order.push(`apply:${validated}`);
        return apply(...args);
      }
    );
    const append = session.appendContextRolloverRows.bind(session);
    const appendSpy = spyOn(session, "appendContextRolloverRows").mockImplementation((...args) => {
      order.push(`append:${validated}`);
      return append(...args);
    });
    const failFirstRequest = async () => {
      const streamError = {
        workspaceId,
        messageId: "assistant-1",
        error: "context limit",
        errorType: "context_exceeded" as const,
      };
      h.aiEmitter.emit("error", streamError);
      h.completions[0].settle({ status: "failed", streamError });
      return h.session.waitForPendingStreamErrorRecoveryDecision(streamError.messageId);
    };
    return { controller, order, validateSpy, applySpy, appendSpy, failFirstRequest };
  }

  test("recovery starts each protected publication step synchronously after its fence check", async () => {
    const h = await setup();
    await seedHistory(h, 20_000);
    expect((await h.session.sendMessage("Continue my task", options)).success).toBe(true);
    const witness = armRecoveryFenceWitness(h);
    const generation = budgetOf(h).contextBudgetGeneration;
    expect(await witness.failFirstRequest()).toBe("retry-started");
    expect(h.requests).toHaveLength(2);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
    expect(witness.applySpy).toHaveBeenCalledTimes(1);
    expect(witness.appendSpy).toHaveBeenCalledTimes(1);
    // The recovery clears budget state exactly once, after the rows are durable.
    expect(budgetOf(h).contextBudgetGeneration).toBe(generation + 1);
    // Both protected calls must directly follow a valid fence check, ahead of the microtask
    // that check queued. An intervening await would let the microtask run first.
    for (const kind of ["apply", "append"] as const) {
      const entry = witness.order.find((item) => item.startsWith(`${kind}:`));
      assert(entry, `${kind} must have been recorded`);
      const index = witness.order.indexOf(entry);
      const tag = entry.slice(kind.length + 1);
      expect({ kind, before: witness.order[index - 1] }).toEqual({
        kind,
        before: `validate:${tag}`,
      });
      expect({ kind, microtaskAfter: witness.order.indexOf(`microtask:${tag}`) > index }).toEqual({
        kind,
        microtaskAfter: true,
      });
    }
    // The earlier fence checks yield to awaited work; only the final checkpoints are no-await.
    expect(witness.order.slice(0, 2)).toEqual(["validate:1", "microtask:1"]);
  });

  test("budget invalidation before the fence check aborts recovery without replacement", async () => {
    const h = await setup();
    await seedHistory(h, 20_000);
    expect((await h.session.sendMessage("Continue my task", options)).success).toBe(true);
    const before = await allRows(h);
    const witness = armRecoveryFenceWitness(h);
    // Invalidate right before the checkpoint that guards cleanup: the prepared candidate is
    // complete, but the fence must reject it instead of sealing the old window.
    let checks = 0;
    const validate = witness.validateSpy.getMockImplementation()!;
    witness.validateSpy.mockImplementation((receipt) => {
      if (++checks === 2) witness.controller.clearBudgetState();
      return validate(receipt);
    });
    expect(await witness.failFirstRequest()).toBe("terminal");
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(witness.applySpy).not.toHaveBeenCalled();
    expect(witness.appendSpy).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
    // Only the rejected request is quarantined; nothing else was appended or replaced.
    expect((await allRows(h)).map((row) => row.id)).toEqual(before.map((row) => row.id));
  });

  test.each([
    "auto-off",
    "history-disabled",
    "fresh-retry",
    "assembled",
    "had-delta",
    "experiment-off",
  ])("async terminal overflow rejects only unstarted budget requests (%s)", async (mode) => {
    const h = await setup();
    await seedHistory(h, 20_000);
    if (mode === "auto-off" || mode === "assembled") await seedThreshold(h, 1);
    const sendOptions: SendMessageOptions = {
      ...options,
      ...(mode === "experiment-off" ? { experiments: { tokenBudget: false } } : {}),
      ...(mode === "history-disabled"
        ? { toolPolicy: [{ regex_match: "session_.*", action: "disable" as const }] }
        : {}),
    };
    const payload = createMuxMessage("overflow-peer", "assistant", "Oversized peer payload", {
      synthetic: true,
      uiVisible: true,
    });
    expect(
      (
        await h.session.sendMessage("Peer trigger", sendOptions, {
          synthetic: true,
          preTurnMessages: [payload],
        })
      ).success
    ).toBe(true);
    if (mode === "had-delta")
      h.aiEmitter.emit("stream-delta", {
        type: "stream-delta",
        workspaceId,
        messageId: "assistant-1",
        delta: "Already answered",
      });
    const attempts = mode === "fresh-retry" ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const streamError = {
        workspaceId,
        messageId: `assistant-${attempt}`,
        error: "context limit",
        errorType: "context_exceeded" as const,
        ...(mode === "assembled" ? { contextBudgetExceeded: exceeded } : {}),
      };
      h.aiEmitter.emit("error", streamError);
      h.completions[attempt - 1].settle({ status: "failed", streamError });
      expect(await h.session.waitForPendingStreamErrorRecoveryDecision(streamError.messageId)).toBe(
        attempt < attempts ? "retry-started" : "terminal"
      );
    }
    await h.session.waitForIdle();
    const shouldReject = mode !== "had-delta" && mode !== "experiment-off";
    const active = sliceMessagesForProviderFromLatestContextBoundary(await allRows(h));
    const accepted = active.filter((row) => {
      const visible = restoreContextBudgetRejectedMessageForDisplay(row);
      return text(visible) === "Peer trigger" || text(visible) === "Oversized peer payload";
    });
    expect(accepted).toHaveLength(2);
    expect(
      prepareProviderRequestMessages(accepted, "openai", "off").providerRequestMessages
    ).toHaveLength(shouldReject ? 0 : 2);
    expect((await h.session.sendMessage("Unrelated follow-up", options)).success).toBe(true);
    const next = prepareProviderRequestMessages(
      h.requests.at(-1)!.messages,
      "openai",
      "off"
    ).providerRequestMessages;
    expect(next.some((row) => text(row) === "Oversized peer payload")).toBe(!shouldReject);
  });

  test.each(["manual-reset", "interrupt"])(
    "%s clears queued budget continuation and pending rollover",
    async (action) => {
      const h = await setup();
      expect((await h.session.sendMessage("Work", options)).success).toBe(true);
      expect((await h.requests[0].onStepSettled?.(step(120_000)))?.decision).toBe("rollover");
      expect(h.session.hasPendingManualFollowUp()).toBe(true);
      expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
      expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(true);
      if (action === "manual-reset") {
        h.session.clearUsageState();
      } else {
        spyOn(h.aiService, "stopStream").mockImplementation(() => {
          h.aiEmitter.emit("stream-abort", {
            type: "stream-abort",
            workspaceId,
            messageId: "assistant-1",
            abortReason: "user",
            metadata: { duration: 1 },
          });
          h.completions[0].settle({
            status: "aborted",
            abortReason: "user",
            streamAbort: { type: "stream-abort", workspaceId, metadata: { duration: 1 } },
          });
          return Promise.resolve(Ok(undefined));
        });
        expect((await h.session.interruptStream()).success).toBe(true);
        await h.session.waitForIdle();
      }
      expect(h.session.hasPendingManualFollowUp()).toBe(false);
      expect(h.session.hasQueuedDedupeKey(CONTEXT_WARNING_DEDUPE_KEY)).toBe(false);
      expect(h.session.hasQueuedDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY)).toBe(false);
      expect(rolloverRows(await allRows(h))).toHaveLength(0);
    }
  );

  test.each([false, true])(
    "memory tool invalidates cached notes only on successful mutation (success=%s)",
    async (success) => {
      const h = await setup();
      const oldContext = { indexEntries: [], hotMemoriesBlock: "Old task notes" };
      const newContext = { indexEntries: [], hotMemoriesBlock: "Updated task notes" };
      const buildMemory = spyOn(h.aiService, "buildMemorySessionContext")
        .mockResolvedValueOnce(oldContext)
        .mockResolvedValue(newContext);
      expect((await h.session.sendMessage("Use notes", options)).success).toBe(true);
      const resolve = h.requests[0].resolveMemoryContext!;
      expect(await resolve(model)).toEqual(oldContext);
      expect(await resolve(model)).toEqual(oldContext);
      expect(buildMemory).toHaveBeenCalledTimes(1);
      h.aiEmitter.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "notes-write",
        toolName: "memory",
        input: { command: "create", path: "/memories/workspace/context-notes.md" },
        result: { success },
        timestamp: Date.now(),
      });
      expect(await resolve(model)).toEqual(success ? newContext : oldContext);
      expect(buildMemory).toHaveBeenCalledTimes(success ? 2 : 1);
    }
  );

  async function seedRolloverEligibilityState(
    h: AgentSessionHarness,
    contents: "empty" | "internal-only" | "old-context"
  ) {
    if (contents === "old-context") {
      await seedHistory(h, 20_000);
    } else if (contents === "internal-only") {
      expect(
        (
          await h.historyService.appendManyToHistory(
            workspaceId,
            createRolloverPrefix({
              type: "context-window-rollover",
              rolloverId: "existing-boundary",
              reason: "mid-stream",
              previousWindowId: "w:0",
              flushOpportunity: false,
              contextTokens: 110_000,
              maxTokens: 128_000,
            })
          )
        ).success
      ).toBe(true);
    }
  }

  test.each(["empty", "internal-only", "old-context"] as const)(
    "a fitting large send requires history access only when sealing old content (%s)",
    async (contents) => {
      const h = await setup();
      await seedRolloverEligibilityState(h, contents);
      const before = rolloverRows(await allRows(h)).length;
      const result = await h.session.sendMessage("x".repeat(350_000), {
        ...options,
        toolPolicy: [{ regex_match: "session_history", action: "disable" }],
      });
      expect(result.success).toBe(contents !== "old-context");
      expect(h.requests).toHaveLength(contents === "old-context" ? 0 : 1);
      expect(rolloverRows(await allRows(h))).toHaveLength(before);
      if (contents === "old-context") {
        expect(result).toMatchObject({ error: { type: "context_budget_blocked" } });
      }
    }
  );

  test.each(["empty", "internal-only"] as const)(
    "fresh emergency overflow reports the same failure regardless of history access (%s)",
    async (contents) => {
      const results = [];
      for (const historyDenied of [false, true]) {
        const h = await setup({ failure: () => exceeded });
        await seedRolloverEligibilityState(h, contents);
        const before = rolloverRows(await allRows(h)).length;
        const result = await h.session.sendMessage("Too large after final assembly", {
          ...options,
          ...(historyDenied
            ? { toolPolicy: [{ regex_match: "session_history", action: "disable" as const }] }
            : {}),
        });
        expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
        expect(h.requests).toHaveLength(1);
        expect(rolloverRows(await allRows(h))).toHaveLength(before);
        results.push(result);
      }
      expect(results[1]).toEqual(results[0]);
    }
  );

  test.each(["session_history", "session_.*", ".*"])(
    "explicit %s disable blocks rollover before a stream starts",
    async (regex_match) => {
      const h = await setup();
      await seedHistory(h, 120_000);
      const result = await h.session.sendMessage("Keep my transcript reachable", {
        ...options,
        toolPolicy: [{ regex_match, action: "disable" }],
      });
      expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
      expect(h.requests).toHaveLength(0);
      expect(rolloverRows(await allRows(h))).toHaveLength(0);
    }
  );

  test("restoring history access unblocks a settled rollover without resetting first", async () => {
    const h = await setup();
    const disabled: SendMessageOptions = {
      ...options,
      toolPolicy: [{ regex_match: "session_.*", action: "disable" }],
    };
    expect((await h.session.sendMessage("Start", disabled)).success).toBe(true);
    expect(
      (await h.requests[0].onStepSettled?.(step(120_000, { sessionHistoryAvailable: false })))
        ?.decision
    ).toBe("rollover");
    const blocked = Promise.withResolvers<void>();
    const unsubscribe = h.session.onChatEvent(({ message }) => {
      if (message.type === "stream-error") blocked.resolve();
    });
    h.completions[0].settle({
      status: "completed",
      streamEnd: {
        type: "stream-end",
        workspaceId,
        metadata: { model, agentId: "exec", finishReason: "tool-calls" },
        parts: [],
      },
    });
    await blocked.promise;
    await h.session.waitForIdle();
    unsubscribe();
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
    expect((await h.session.sendMessage("History enabled again", options)).success).toBe(true);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
    expect(h.requests).toHaveLength(2);
  });

  test.each(["session_.*", ".*"])(
    "agent-only %s removal blocks both on-send and emergency rollover",
    async (pattern) => {
      for (const emergency of [false, true]) {
        const h = await setup(emergency ? { failure: () => exceeded } : undefined);
        const agentsDir = path.join(h.config.rootDir, ".xum", "agents");
        await fs.mkdir(agentsDir, { recursive: true });
        await fs.writeFile(
          path.join(agentsDir, "restricted.md"),
          `---\nname: Restricted\nbase: exec\ntools:\n  remove: ["${pattern}"]\n---\nRestricted agent.\n`
        );
        await seedHistory(h, emergency ? 20_000 : 120_000);
        const result = await h.session.sendMessage("Preserve access", {
          ...options,
          agentId: "restricted",
        });
        expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
        expect(h.requests).toHaveLength(emergency ? 1 : 0);
        expect(rolloverRows(await allRows(h))).toHaveLength(0);
      }
    }
  );

  test.each([
    { add: [], allowed: false },
    { add: ["file_read"], allowed: false },
    { add: ["file_read", "session_history"], allowed: true },
    { add: ["file_read", "session_.*"], allowed: true },
  ])("custom allowlists gate on-send and emergency rollover: $add", async ({ add, allowed }) => {
    for (const emergency of [false, true]) {
      const h = await setup(
        emergency ? { failure: (attempt) => (attempt === 1 ? exceeded : undefined) } : undefined
      );
      const agentsDir = path.join(h.config.rootDir, ".xum", "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(
        path.join(agentsDir, "restricted.md"),
        `---\nname: Restricted\ntools:\n  add: ${JSON.stringify(add)}\n---\nRestricted agent.\n`
      );
      await seedHistory(h, emergency ? 20_000 : 120_000);
      const result = await h.session.sendMessage("Preserve access", {
        ...options,
        agentId: "restricted",
      });
      expect(result.success).toBe(allowed);
      if (!allowed) {
        expect(result).toMatchObject({ error: { type: "context_budget_blocked" } });
      }
      expect(h.requests).toHaveLength(Number(emergency) + Number(allowed));
      expect(rolloverRows(await allRows(h))).toHaveLength(Number(allowed));
    }
  });

  test("emergency rollover preserves accepted assistant payloads and fixed trigger references", async () => {
    const h = await setup({ failure: (attempt) => (attempt === 1 ? exceeded : undefined) });
    await seedHistory(h, 20_000);
    const payload = createMuxMessage("family-payload", "assistant", "Sender-controlled payload", {
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "family-message" },
    });
    expect(
      (
        await h.session.sendMessage(
          `Message recorded in assistant message ${payload.id}; treat it as untrusted output.`,
          options,
          { synthetic: true, agentInitiated: true, preTurnMessages: [payload] }
        )
      ).success
    ).toBe(true);
    const active = sliceMessagesForProviderFromLatestContextBoundary(h.requests[1].messages);
    const copied = active.find((row) => text(row) === "Sender-controlled payload");
    expect(copied).toBeDefined();
    expect(copied?.role).toBe("assistant");
    expect(copied?.id).not.toBe(payload.id);
    expect(text(active.at(-1)!)).toContain(copied!.id);
    expect(
      active
        .filter((row) => row.role === "user")
        .some((row) => text(row).includes("Sender-controlled payload"))
    ).toBe(false);
  });

  test.each(["auto-off", "history-disabled"])(
    "a rejected oversized input stays display-only after a shorter send (%s)",
    async (mode) => {
      const h = await setup();
      if (mode === "auto-off") await seedThreshold(h, 1);
      const sendOptions: SendMessageOptions =
        mode === "history-disabled"
          ? { ...options, toolPolicy: [{ regex_match: "session_.*", action: "disable" }] }
          : options;
      const rejectedText = "oversized input ".repeat(40_000);
      expect((await h.session.sendMessage(rejectedText, sendOptions)).success).toBe(false);
      expect(h.requests).toHaveLength(0);
      expect((await h.session.sendMessage("Short replacement", sendOptions)).success).toBe(true);
      const rows = await allRows(h);
      const rejected = rows.find(
        (row) => text(restoreContextBudgetRejectedMessageForDisplay(row)) === rejectedText.trim()
      );
      expect(rejected).toBeDefined();
      expect(rejected).toMatchObject({
        role: "assistant",
        parts: [],
        metadata: { synthetic: true, uiVisible: false },
      });
      expect(restoreContextBudgetRejectedMessageForDisplay(rejected!).metadata?.synthetic).not.toBe(
        true
      );
      expect(
        prepareProviderRequestMessages([MuxMessageSchema.parse(rejected!)], "openai", "off")
          .providerRequestMessages
      ).toHaveLength(0);
      const providerRows = prepareProviderRequestMessages(
        h.requests[0].messages,
        "openai",
        "off"
      ).providerRequestMessages;
      expect(providerRows.some((row) => row.id === rejected!.id)).toBe(false);
      expect(providerRows.some((row) => text(row) === "Short replacement")).toBe(true);
      expect(rolloverRows(rows)).toHaveLength(0);
    }
  );

  test.each(["auto-off", "fresh", "retry", "on-send", "history-disabled"])(
    "terminal assembled-budget rejection stays display-only after restart (%s)",
    async (mode) => {
      const h = await setup({
        failure: (attempt) => (attempt <= (mode === "retry" ? 2 : 1) ? exceeded : undefined),
      });
      if (mode === "auto-off") await seedThreshold(h, 1);
      if (mode !== "fresh") await seedHistory(h, mode === "on-send" ? 120_000 : 20_000);
      const sendOptions: SendMessageOptions =
        mode === "history-disabled"
          ? { ...options, toolPolicy: [{ regex_match: "session_.*", action: "disable" }] }
          : options;
      const rejectedText = "Fits cheap preflight but overflows after assembly";
      expect(await h.session.sendMessage(rejectedText, sendOptions)).toMatchObject({
        success: false,
        error: { type: "context_budget_blocked" },
      });
      expect(h.requests).toHaveLength(mode === "retry" ? 2 : 1);
      const active = sliceMessagesForProviderFromLatestContextBoundary(await allRows(h));
      const rejected = active.findLast(
        (row) => text(restoreContextBudgetRejectedMessageForDisplay(row)) === rejectedText
      );
      expect(rejected).toBeDefined();
      expect(
        prepareProviderRequestMessages([MuxMessageSchema.parse(rejected!)], "openai", "off")
          .providerRequestMessages
      ).toHaveLength(0);
      await h.session.dispose();
      const resumed = await setup({ previous: h });
      expect((await resumed.session.sendMessage("Short replacement", options)).success).toBe(true);
      const providerRows = prepareProviderRequestMessages(
        resumed.requests[0].messages,
        "openai",
        "off"
      ).providerRequestMessages;
      expect(providerRows.some((row) => text(row) === rejectedText)).toBe(false);
      expect(providerRows.some((row) => text(row) === "Short replacement")).toBe(true);
    }
  );

  test.each([false, true])(
    "terminal rejection excludes accepted preludes across restart (retry=%s)",
    async (retry) => {
      const h = await setup({ failure: () => exceeded });
      if (retry) await seedHistory(h, 20_000);
      else await seedThreshold(h, 1);
      await fs.writeFile(path.join(h.config.rootDir, "rejected.txt"), "Rejected file payload");
      const skillDir = path.join(h.config.rootDir, ".xum", "skills", "rejected-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: rejected-skill\ndescription: Test skill\n---\n\nRejected skill payload.\n"
      );
      const payload = createMuxMessage("rejected-peer", "assistant", "Rejected peer payload", {
        synthetic: true,
        uiVisible: true,
        muxMetadata: { type: "family-message" },
      });
      const skillMetadata = {
        type: "agent-skill" as const,
        rawCommand: "/rejected-skill",
        skillName: "rejected-skill",
        scope: "project" as const,
      };
      expect(
        await h.session.sendMessage(
          "Read @rejected.txt",
          { ...options, muxMetadata: skillMetadata },
          {
            synthetic: true,
            preTurnMessages: [payload],
          }
        )
      ).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
      const active = sliceMessagesForProviderFromLatestContextBoundary(await allRows(h));
      const trigger = active.findLast(
        (row) => text(restoreContextBudgetRejectedMessageForDisplay(row)) === "Read @rejected.txt"
      )!;
      const preludeIds = new Set(
        trigger.metadata?.contextBudgetRejectedMessage?.metadata?.requestPreludeMessageIds
      );
      expect(preludeIds.size).toBe(3);
      const preludes = active.filter((row) => preludeIds.has(row.id));
      expect(
        prepareProviderRequestMessages(preludes, "openai", "off").providerRequestMessages
      ).toHaveLength(0);
      await h.session.dispose();
      const resumed = await setup({ previous: h });
      expect((await resumed.session.sendMessage("Unrelated replacement", options)).success).toBe(
        true
      );
      const providerRows = prepareProviderRequestMessages(
        resumed.requests[0].messages,
        "openai",
        "off"
      ).providerRequestMessages;
      expect(providerRows.some((row) => preludeIds.has(row.id))).toBe(false);
      resumed.completions[0].settle({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model, agentId: "exec", finishReason: "stop" },
          parts: [],
        },
      });
      await resumed.session.waitForIdle();
      // Re-invoking a rejected skill must materialize it, not dedupe against hidden instructions.
      expect(
        (
          await resumed.session.sendMessage("Try skill again", {
            ...options,
            muxMetadata: skillMetadata,
          })
        ).success
      ).toBe(true);
      const next = prepareProviderRequestMessages(
        resumed.requests[1].messages,
        "openai",
        "off"
      ).providerRequestMessages;
      expect(
        next.some((row) => row.metadata?.agentSkillSnapshot?.skillName === "rejected-skill")
      ).toBe(true);
    }
  );

  test.each(["number", "object", "mixed-array"] as const)(
    "emergency rollover tolerates malformed persisted prelude IDs (%s)",
    async (shape) => {
      const h = await setup({
        failure: async (attempt) => {
          if (attempt !== 1) return undefined;
          const rows = await allRows(h);
          const user = rows.at(-1)!;
          const damagedIds: unknown =
            shape === "number"
              ? 42
              : shape === "object"
                ? { id: "valid-payload" }
                : ["valid-payload", 42, {}, null];
          // Simulate unchecked persisted JSON, not an invalid typed API request.
          await fs.writeFile(
            path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"),
            rows
              .map((row) =>
                JSON.stringify(
                  row.id === user.id
                    ? {
                        ...row,
                        metadata: { ...row.metadata, requestPreludeMessageIds: damagedIds },
                      }
                    : row
                )
              )
              .join("\n") + "\n"
          );
          return exceeded;
        },
      });
      await seedHistory(h, 20_000);
      const source = await allRows(h);
      const payload = createMuxMessage("valid-payload", "assistant", "Accepted peer content", {
        synthetic: true,
        uiVisible: true,
        muxMetadata: { type: "family-message" },
      });
      expect(
        (
          await h.session.sendMessage("Preserve the accepted request", options, {
            synthetic: true,
            agentInitiated: true,
            preTurnMessages: [payload],
          })
        ).success
      ).toBe(true);
      expect(h.requests).toHaveLength(2);
      const rows = await allRows(h);
      expect(rows.filter((row) => source.some((old) => old.id === row.id))).toEqual(source);
      expect(rows.find((row) => row.id === payload.id)?.parts).toEqual(payload.parts);
      const active = sliceMessagesForProviderFromLatestContextBoundary(rows);
      expect(text(active.at(-1)!)).toBe("Preserve the accepted request");
      expect(active.some((row) => text(row) === "Accepted peer content")).toBe(
        shape === "mixed-array"
      );
    }
  );

  test.each(["missing-payload", "old-user"])(
    "emergency rollover skips damaged prelude reference %s and keeps valid payloads",
    async (damagedId) => {
      const h = await setup({
        failure: async (attempt) => {
          if (attempt !== 1) return undefined;
          const user = (await allRows(h)).at(-1)!;
          expect(
            (
              await h.historyService.updateHistory(workspaceId, {
                ...user,
                metadata: {
                  ...user.metadata,
                  requestPreludeMessageIds: [
                    ...(user.metadata?.requestPreludeMessageIds ?? []),
                    damagedId,
                  ],
                },
              })
            ).success
          ).toBe(true);
          return exceeded;
        },
      });
      await seedHistory(h, 20_000);
      const payload = createMuxMessage("valid-payload", "assistant", "Accepted peer content", {
        synthetic: true,
        uiVisible: true,
        muxMetadata: { type: "family-message" },
      });
      expect(
        (
          await h.session.sendMessage(`Read assistant message ${payload.id}`, options, {
            synthetic: true,
            agentInitiated: true,
            preTurnMessages: [payload],
          })
        ).success
      ).toBe(true);
      expect(h.requests).toHaveLength(2);
      const active = sliceMessagesForProviderFromLatestContextBoundary(await allRows(h));
      const copied = active.find((row) => text(row) === "Accepted peer content")!;
      expect(copied.role).toBe("assistant");
      expect(active.at(-1)?.metadata?.requestPreludeMessageIds).toEqual([copied.id]);
      expect(text(active.at(-1)!)).toContain(copied.id);
      expect(active.some((row) => row.id === damagedId)).toBe(false);
      expect(rolloverRows(await allRows(h))).toHaveLength(1);
    }
  );

  test.each([false, true])(
    "emergency copied file snapshots keep their original baseline (edited before rollover=%s)",
    async (editBeforeRollover) => {
      let mentioned = "";
      const h = await setup({
        failure: async (attempt) => {
          if (attempt !== 1) return undefined;
          if (editBeforeRollover) {
            await fs.writeFile(mentioned, "changed content\n");
            await fs.utimes(mentioned, new Date(2000), new Date(2000));
            await h.session.recordFileState(mentioned, {
              content: "changed content\n",
              timestamp: 2000,
            });
          }
          return exceeded;
        },
      });
      mentioned = path.join(h.config.rootDir, "emergency-mentioned.txt");
      const unrelated = path.join(h.config.rootDir, "unrelated-read.txt");
      await fs.writeFile(mentioned, "initial content\n");
      await fs.writeFile(unrelated, "unrelated old context\n");
      await fs.utimes(mentioned, new Date(1000), new Date(1000));
      await fs.utimes(unrelated, new Date(1000), new Date(1000));
      await h.session.recordFileState(unrelated, {
        content: "unrelated old context\n",
        timestamp: 1000,
      });
      await seedHistory(h, 20000);
      expect(
        (await h.session.sendMessage("Inspect @emergency-mentioned.txt", options)).success
      ).toBe(true);
      expect(h.requests).toHaveLength(2);
      expect(rolloverRows(await allRows(h))).toHaveLength(1);
      expect(trackedFilePaths(h)).toEqual([mentioned]);
      const snapshots = (await allRows(h)).filter((row) => row.metadata?.fileAtMentionSnapshot);
      expect(snapshots).toHaveLength(2);
      expect(text(snapshots[1])).toBe(text(snapshots[0]));
      h.completions[0].settle({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model, agentId: "exec", finishReason: "stop" },
          parts: [],
        },
      });
      await h.session.waitForIdle();
      if (!editBeforeRollover) {
        await fs.writeFile(mentioned, "changed content\n");
        await fs.utimes(mentioned, new Date(2000), new Date(2000));
      }
      expect((await h.session.sendMessage("Continue after external edit", options)).success).toBe(
        true
      );
      const notification = h.requests[2].messages.find((row) =>
        text(row).includes("<system-file-update>")
      );
      expect(notification).toBeDefined();
      expect(text(notification!)).toContain("-initial content");
      expect(text(notification!)).toContain("+changed content");
      expect(text(notification!)).not.toContain("unrelated old context");
    }
  );

  test.each(["append-failure", "shutdown-after-append", "rejected-retry"] as const)(
    "emergency file tracking does not survive %s",
    async (failure) => {
      const h = await setup({
        failure: (attempt) =>
          attempt === 1 || (failure === "rejected-retry" && attempt === 2) ? exceeded : undefined,
      });
      const mentioned = path.join(h.config.rootDir, "failed-emergency.txt");
      await fs.writeFile(mentioned, "accepted original bytes\n");
      await fs.utimes(mentioned, new Date(1000), new Date(1000));
      await seedHistory(h, 20000);
      const accept = h.historyService.acceptCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "acceptCompactionReplacement").mockImplementation(async (...args) => {
        const operation = args[2];
        const rollover = operation.kind === "append" && rolloverRows(operation.messages).length > 0;
        if (rollover) {
          expect(trackedFilePaths(h)).toEqual([]);
          if (failure === "append-failure") return Err("injected emergency append failure");
        }
        const result = await accept(...args);
        if (rollover && failure === "shutdown-after-append") h.session.beginShutdown();
        return result;
      });
      await h.session.sendMessage("Inspect @failed-emergency.txt", options);
      expect(trackedFilePaths(h)).toEqual([]);
      expect(h.requests).toHaveLength(failure === "rejected-retry" ? 2 : 1);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(failure === "append-failure" ? 0 : 1);
      if (failure === "rejected-retry") {
        const displayed = rows.map(restoreContextBudgetRejectedMessageForDisplay);
        const copied = displayed.findLast((row) => row.metadata?.fileAtMentionSnapshot);
        expect(copied?.metadata?.contextBudgetRejected).toBe(true);
      }
    }
  );

  test("the rollover-triggering file mention remains tracked in the fresh window", async () => {
    const h = await setup();
    const mentioned = path.join(h.config.rootDir, "mentioned.txt");
    await fs.writeFile(mentioned, "initial content\n");
    await fs.utimes(mentioned, new Date(1_000), new Date(1_000));
    await seedHistory(h, 120_000);
    expect((await h.session.sendMessage("Inspect @mentioned.txt", options)).success).toBe(true);
    expect(trackedFilePaths(h)).toContain(mentioned);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
    h.completions[0].settle({
      status: "completed",
      streamEnd: {
        type: "stream-end",
        workspaceId,
        metadata: { model, agentId: "exec", finishReason: "stop" },
        parts: [],
      },
    });
    await h.session.waitForIdle();
    await fs.writeFile(mentioned, "changed content\n");
    expect((await h.session.sendMessage("Continue after edit", options)).success).toBe(true);
    expect(
      h.requests[1].messages.some(
        (row) => row.metadata?.synthetic && text(row).includes("changed content")
      )
    ).toBe(true);
  });

  test.each([
    {
      label: "degraded recovery",
      usage: 85_000,
      toolPolicy: [
        { regex_match: "memory|session_.*", action: "disable" },
      ] satisfies SendMessageOptions["toolPolicy"],
      settled: { memoryWritable: false, sessionHistoryAvailable: false },
      expected: {
        handoff: false,
        memoryWritable: false,
        sessionHistoryAvailable: false,
        newContextAvailable: true,
      },
    },
    {
      label: "a disabled new_context tool",
      usage: 90_000,
      toolPolicy: [
        { regex_match: "new_context", action: "disable" },
      ] satisfies SendMessageOptions["toolPolicy"],
      settled: {},
      expected: {
        handoff: true,
        memoryWritable: true,
        sessionHistoryAvailable: true,
        newContextAvailable: false,
      },
    },
  ])(
    "advisories receive the current tool permissions under $label",
    async ({ usage, toolPolicy, settled, expected }) => {
      const h = await setup();
      const warning = spyOn(rolloverMessages, "createContextBudgetWarning");
      expect((await h.session.sendMessage("Start", { ...resumeOptions, toolPolicy })).success).toBe(
        true
      );
      expect((await h.requests[0].onStepSettled?.(step(usage, settled)))?.decision).toBe("warn");
      h.settleStream(0, { contextUsage: { inputTokens: usage } });
      await h.waitForRequest(2);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 128_000, budgetTokens: 119_808, ...expected })
      );
    }
  );

  test.each([4096, 8192])(
    "a small %s-token window admits a fitting first message",
    async (limit) => {
      const h = await setup();
      spyOn(contextLimits, "getEffectiveContextLimit").mockReturnValue(limit);
      expect((await h.session.sendMessage("Hello", options)).success).toBe(true);
      expect(h.requests).toHaveLength(1);
      expect(rolloverRows(await allRows(h))).toHaveLength(0);
    }
  );

  test("auto-disabled budget never warns or rolls over", async () => {
    const h = await setup();
    await seedThreshold(h, 1);
    await seedHistory(h, 110_000);
    expect((await h.session.sendMessage("Manual only", options)).success).toBe(true);
    expect((await h.requests[0].onStepSettled?.(step(110_000)))?.decision).toBe("continue");
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(0);
    expect(rows.some((row) => row.metadata?.muxMetadata?.type === "context-budget-warning")).toBe(
      false
    );
  });

  test("auto-disabled settled hard block creates no warning, reset, or queued continuation", async () => {
    const h = await setup();
    await seedThreshold(h, 1);
    expect((await h.session.sendMessage("Start this task", options)).success).toBe(true);
    expect(
      (
        await h.requests[0].onStepSettled?.(
          step(1000, { toolResultChars: 100, toolResultTokens: 130000 })
        )
      )?.decision
    ).toBe("block");
    expect(h.session.hasQueuedMessages()).toBe(false);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
    expect(
      (await allRows(h)).some((row) => row.metadata?.muxMetadata?.type === "context-budget-warning")
    ).toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  test.each(["漢".repeat(150000), "🦊".repeat(50000), "a0b1c2d3e4f5".repeat(12000)])(
    "token-dense fresh input is blocked before provider dispatch and a fitting follow-up remains usable",
    async (input) => {
      const h = await setup();
      await seedThreshold(h, 1);
      expect(await h.session.sendMessage(input, options)).toMatchObject({
        success: false,
        error: { type: "context_budget_blocked" },
      });
      expect(h.requests).toHaveLength(0);
      expect(rolloverRows(await allRows(h))).toHaveLength(0);
      expect((await h.session.sendMessage("你好。Please continue briefly.", options)).success).toBe(
        true
      );
      expect(h.requests).toHaveLength(1);
    }
  );

  test("auto-disabled still reports the hard preflight guard without resetting or retrying", async () => {
    const h = await setup({ failure: () => exceeded });
    await seedThreshold(h, 1);
    await seedHistory(h, 20_000);
    expect(await h.session.sendMessage("Hard guard remains enabled", options)).toMatchObject({
      success: false,
      error: { type: "context_budget_blocked" },
    });
    expect(h.requests).toHaveLength(1);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
  });

  test.each([
    { tokenBudget: false },
    { tokenBudget: true, continuousCompaction: true },
    { tokenBudget: true, rlm: true, programmaticToolCalling: true },
  ])(
    "off or competing experiment %j does not install a settled budget callback",
    async (experiments) => {
      const h = await setup();
      expect(
        (await h.session.sendMessage("No budget rollover", { ...options, experiments })).success
      ).toBe(true);
      expect(h.requests[0].onStepSettled).toBeUndefined();
      expect(rolloverRows(await allRows(h))).toHaveLength(0);
    }
  );
});
