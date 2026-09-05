import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Err, Ok } from "@/common/types/result";
import { prepareProviderRequestMessages } from "./turnContextAssembler";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import type { AgentSessionAIService } from "./agentSession";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import { createTurnCompletionController, type SettledStepBudget } from "./streamManager";
import { createRolloverPrefix, type ContextWindowRollover } from "./contextWindowRollover";
import * as rolloverMessages from "./contextWindowRollover";
import * as contextLimits from "@/common/utils/compaction/contextLimit";

const workspaceId = "token-budget-session";
const model = "openai:gpt-4o";
const options: SendMessageOptions = {
  model,
  agentId: "exec",
  experiments: { tokenBudget: true },
};
const correlation = {
  type: "workspace-turn-task",
  taskHandleId: "wst_budget",
  ownerWorkspaceId: "parent",
  turnId: "delegated-turn",
} as const;
type Request = Parameters<AgentSessionAIService["streamMessage"]>[0];

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

describe("AgentSession token-budget lifecycle", () => {
  const harnesses: AgentSessionHarness[] = [];
  afterEach(async () => {
    for (const h of harnesses.reverse()) {
      h.session.dispose();
      await h.cleanup();
    }
    harnesses.length = 0;
    mock.restore();
  });

  async function setup(args?: {
    previous?: AgentSessionHarness;
    failure?: (attempt: number) => SendMessageError | undefined;
  }) {
    const requests: Request[] = [];
    const secondRequest = Promise.withResolvers<Request>();
    const completions: Array<ReturnType<typeof createTurnCompletionController>> = [];
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>((request) => {
      requests.push(request);
      if (requests.length === 2) secondRequest.resolve(request);
      const error = args?.failure?.(requests.length);
      if (error) return Promise.resolve(Err(error));
      h.aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: `assistant-${requests.length}`,
        model: request.modelString,
        startTime: Date.now(),
      });
      const completion = createTurnCompletionController();
      completions.push(completion);
      return Promise.resolve(
        Ok({ messageId: `assistant-${requests.length}`, completion: completion.promise })
      );
    });
    const h = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      historyService: args?.previous?.historyService,
      config: args?.previous?.config,
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
    h.session.setAutoCompactionThreshold(0.7);
    const finishAndDispatch = async () => {
      h.aiEmitter.emit("stream-end", {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        metadata: { model, agentId: "exec", finishReason: "tool-calls" },
        parts: [],
      });
      completions[0].settle({ status: "completed" });
      await secondRequest.promise;
    };
    return { ...h, requests, completions, streamMessage, secondRequest, finishAndDispatch };
  }

  test("on-send rollover appends reset, hidden lead-in, skill snapshot and the original user together", async () => {
    const h = await setup();
    await seedHistory(h, 110_000);
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
    const append = spyOn(h.historyService, "appendManyToHistory");
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
    expect(append.mock.calls[0][1].map((row) => row.id)).toEqual(
      rows.slice(boundaryIndex).map((row) => row.id)
    );
    expect(h.requests).toHaveLength(1);
    const providerRows = sliceMessagesForProviderFromLatestContextBoundary(h.requests[0].messages);
    expect(providerRows.map((row) => row.id)).toEqual([leadIn.id, snapshot.id, user.id]);
    expect(rows.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")).toBe(
      false
    );
  });

  test("on-send usage below the force buffer preserves history while warning permissions are unknown", async () => {
    const h = await setup();
    await seedHistory(h, 95_000);
    expect(
      (await h.session.sendMessage("Keep working below the force band", options)).success
    ).toBe(true);
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(0);
    expect(
      rows.filter((row) => row.metadata?.muxMetadata?.type === "context-budget-warning")
    ).toHaveLength(0);
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
      h.session.dispose();
      const resumed = await setup({
        previous: h,
        failure: emergency ? (attempt) => (attempt === 1 ? exceeded : undefined) : undefined,
      });
      await seedHistory(resumed, emergency ? 20_000 : 110_000);
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

  test("restart recomputes pending rollover including a giant final tool result", async () => {
    const first = await setup();
    await seedHistory(first, 30_000, 300_000);
    first.session.dispose();
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
        output: "x".repeat(300_000),
      },
    ];
    expect((await first.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    first.session.dispose();
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
      await seedHistory(first, 110_000);
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
      first.session.dispose();
      const h = await setup({ previous: first });
      expect((await h.session.sendMessage("Recover accepted work", options)).success).toBe(true);
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(1);
      expect(text(rows.at(-1)!)).toBe("Recover accepted work");
      expect(h.requests).toHaveLength(1);
    }
  );

  test("failed atomic append preserves history and retry after fail-closed cleanup", async () => {
    const h = await setup();
    await seedHistory(h, 110_000);
    const cleanup = spyOn(h.session, "applyContextResetSideEffects");
    const append = spyOn(h.historyService, "appendManyToHistory").mockImplementationOnce(
      async () => {
        expect(cleanup).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        throw new Error("disk unavailable");
      }
    );
    expect((await h.session.sendMessage("Retry me", options)).success).toBe(false);
    expect(rolloverRows(await allRows(h))).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    const failedRollover = append.mock.calls[0][1][0].metadata?.muxMetadata;
    expect((await h.session.sendMessage("Retry me", options)).success).toBe(true);
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(1);
    expect(rolloverRows(rows)[0].metadata?.muxMetadata).toEqual(failedRollover);
    expect(rows.filter((row) => text(row) === "Retry me")).toHaveLength(1);
  });

  test("a published rollover is not repeated when its append acknowledgment fails", async () => {
    const h = await setup();
    await seedHistory(h, 110_000);
    const append = h.historyService.appendManyToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendManyToHistory").mockImplementationOnce(
      async (workspace, rows) => {
        const result = await append(workspace, rows);
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
      expect(await h.requests[0].onStepSettled?.(step(110_000))).toBe("rollover");
      expect(rolloverRows(await allRows(h))).toHaveLength(0);
      await h.finishAndDispatch();
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(1);
      expect(rows.filter((row) => text(row) === "Real queued instruction")).toHaveLength(1);
      expect(rows.filter((row) => text(row) === "Continue")).toHaveLength(0);
      expect(h.requests).toHaveLength(2);
    }
  );

  test("restart defers its first warning until settled memory availability is known", async () => {
    const h = await setup();
    await seedHistory(h, 85_000);
    expect((await h.session.sendMessage("Resume work", options)).success).toBe(true);
    expect(
      (await allRows(h)).filter(
        (row) => row.metadata?.muxMetadata?.type === "context-budget-warning"
      )
    ).toHaveLength(0);
    expect(await h.requests[0].onStepSettled?.(step(85_000, { memoryWritable: true }))).toBe(
      "warn"
    );
    await h.finishAndDispatch();
    expect(
      (await allRows(h)).filter(
        (row) => row.metadata?.muxMetadata?.type === "context-budget-warning"
      )
    ).toHaveLength(1);
  });

  test("settled warning is durable once per window and retains delegated continuation attribution", async () => {
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
    expect(await h.requests[0].onStepSettled?.(step(85_000))).toBe("warn");
    expect(
      (await allRows(h)).some((row) => row.metadata?.muxMetadata?.type === "context-budget-warning")
    ).toBe(false);
    expect(h.session.hasPendingWorkspaceTurnContinuation(correlation)).toBe(true);
    await h.finishAndDispatch();
    const rows = await allRows(h);
    const warnings = rows.filter(
      (row) => row.metadata?.muxMetadata?.type === "context-budget-warning"
    );
    expect(warnings).toHaveLength(1);
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
    expect(await h.requests[1].onStepSettled?.(step(85_000))).toBe("continue");
    expect(rolloverRows(rows)).toHaveLength(0);
  });

  test.each([110_000, 127_000])(
    "force/ceiling at %i tokens suppresses warning and preserves continuation correlation",
    async (inputTokens) => {
      const h = await setup();
      expect(
        (await h.session.sendMessage("Work", { ...options, muxMetadata: correlation })).success
      ).toBe(true);
      expect(await h.requests[0].onStepSettled?.(step(inputTokens))).toBe("rollover");
      await h.finishAndDispatch();
      const rows = await allRows(h);
      expect(rolloverRows(rows)).toHaveLength(1);
      expect(rows.some((row) => row.metadata?.muxMetadata?.type === "context-budget-warning")).toBe(
        false
      );
      expect(rows.at(-1)?.metadata).toMatchObject({
        synthetic: true,
        retrySendOptions: { agentInitiated: true },
        muxMetadata: correlation,
      });
    }
  );

  const exceeded: SendMessageError = {
    type: "context_budget_exceeded",
    model,
    estimate: 127_000,
    hardCeiling: 119_808,
  };
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
    await seedHistory(h, 110_000);
    const result = await h.session.sendMessage("Still too big after assembly", options);
    expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
    expect(h.requests).toHaveLength(1);
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

  test.each(["manual-reset", "interrupt"])(
    "%s clears queued budget continuation and pending rollover",
    async (action) => {
      const h = await setup();
      expect((await h.session.sendMessage("Work", options)).success).toBe(true);
      expect(await h.requests[0].onStepSettled?.(step(110_000))).toBe("rollover");
      expect(h.session.hasPendingManualFollowUp()).toBe(true);
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
          return Promise.resolve(Ok(undefined));
        });
        expect((await h.session.interruptStream()).success).toBe(true);
        await h.session.waitForIdle();
      }
      expect(h.session.hasPendingManualFollowUp()).toBe(false);
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

  test.each(["session_history", "session_.*", ".*"])(
    "explicit %s disable blocks rollover before a stream starts",
    async (regex_match) => {
      const h = await setup();
      await seedHistory(h, 110_000);
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
      await h.requests[0].onStepSettled?.(step(110_000, { sessionHistoryAvailable: false }))
    ).toBe("rollover");
    const blocked = Promise.withResolvers<void>();
    const unsubscribe = h.session.onChatEvent(({ message }) => {
      if (message.type === "stream-error") blocked.resolve();
    });
    h.aiEmitter.emit("stream-end", {
      type: "stream-end",
      workspaceId,
      messageId: "assistant-1",
      metadata: { model, agentId: "exec", finishReason: "tool-calls" },
      parts: [],
    });
    h.completions[0].settle({ status: "completed" });
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
        await seedHistory(h, emergency ? 20_000 : 110_000);
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
      if (mode === "auto-off") h.session.setAutoCompactionThreshold(1);
      const sendOptions: SendMessageOptions =
        mode === "history-disabled"
          ? { ...options, toolPolicy: [{ regex_match: "session_.*", action: "disable" }] }
          : options;
      const rejectedText = "oversized input ".repeat(40_000);
      expect((await h.session.sendMessage(rejectedText, sendOptions)).success).toBe(false);
      expect(h.requests).toHaveLength(0);
      expect((await h.session.sendMessage("Short replacement", sendOptions)).success).toBe(true);
      const rows = await allRows(h);
      const rejected = rows.find((row) => text(row) === rejectedText.trim());
      expect(rejected).toBeDefined();
      expect(rejected?.metadata?.synthetic).not.toBe(true);
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

  test("the rollover-triggering file mention remains tracked in the fresh window", async () => {
    const h = await setup();
    const mentioned = path.join(h.config.rootDir, "mentioned.txt");
    await fs.writeFile(mentioned, "initial content\n");
    await fs.utimes(mentioned, new Date(1_000), new Date(1_000));
    await seedHistory(h, 110_000);
    expect((await h.session.sendMessage("Inspect @mentioned.txt", options)).success).toBe(true);
    expect(h.session.getTrackedFilePaths()).toContain(mentioned);
    expect(rolloverRows(await allRows(h))).toHaveLength(1);
    h.aiEmitter.emit("stream-end", {
      type: "stream-end",
      workspaceId,
      messageId: "assistant-1",
      metadata: { model, agentId: "exec", finishReason: "stop" },
      parts: [],
    });
    h.completions[0].settle({ status: "completed" });
    await h.session.waitForIdle();
    await fs.writeFile(mentioned, "changed content\n");
    expect((await h.session.sendMessage("Continue after edit", options)).success).toBe(true);
    expect(
      h.requests[1].messages.some(
        (row) => row.metadata?.synthetic && text(row).includes("changed content")
      )
    ).toBe(true);
  });

  test("warnings receive the settled tool availability instead of promising disabled recovery", async () => {
    const h = await setup();
    const warning = spyOn(rolloverMessages, "createContextBudgetWarning");
    const denied: SendMessageOptions = {
      ...options,
      toolPolicy: [{ regex_match: "session_.*", action: "disable" }],
    };
    expect((await h.session.sendMessage("Start without history", denied)).success).toBe(true);
    expect(
      await h.requests[0].onStepSettled?.(
        step(85_000, {
          memoryWritable: false,
          sessionHistoryAvailable: false,
        })
      )
    ).toBe("warn");
    await h.finishAndDispatch();
    expect(warning).toHaveBeenCalledWith(expect.any(Number), 128_000, false, false);
  });

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
    h.session.setAutoCompactionThreshold(1);
    await seedHistory(h, 110_000);
    expect((await h.session.sendMessage("Manual only", options)).success).toBe(true);
    expect(await h.requests[0].onStepSettled?.(step(127_000))).toBe("continue");
    const rows = await allRows(h);
    expect(rolloverRows(rows)).toHaveLength(0);
    expect(rows.some((row) => row.metadata?.muxMetadata?.type === "context-budget-warning")).toBe(
      false
    );
  });

  test("auto-disabled still reports the hard preflight guard without resetting or retrying", async () => {
    const h = await setup({ failure: () => exceeded });
    h.session.setAutoCompactionThreshold(1);
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
