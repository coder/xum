import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";
import { EAGER_LEAD_PERCENT } from "@/constants/continuousCompaction";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { ContinuousCompactor, type ContinuousCompactionContext } from "./continuousCompactor";
import { CompactionHandler } from "./compactionHandler";
import { createTestHistoryService } from "./testHistoryService";

type Dependencies = ConstructorParameters<typeof ContinuousCompactor>[0];
type LiveSnapshot = NonNullable<ReturnType<Dependencies["streamManager"]["getStreamInfo"]>> & {
  currentStepStartIndex: number;
};

const releaseLatches: Array<() => void> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  releaseLatches.push(resolve);
  return { promise, resolve };
}

const workspaceId = "continuous-tests";
const context: ContinuousCompactionContext & { phase: "on-send" | "mid-stream" | "stream-end" } = {
  enabled: true,
  model: "anthropic:claude-sonnet-4-5",
  contextWindowTokens: 100_000,
  thresholdPercent: 80,
  systemMessageTokens: 300,
  attachmentTokens: 100,
  phase: "stream-end",
};
const eagerPercent = context.thresholdPercent - EAGER_LEAD_PERCENT;
const forcePercent = context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT;
const summary = {
  text: "The earlier investigation established the fix and its validation plan.",
  model: context.model,
};

// Only the background job is joined through a private seam. All state assertions use durable
// history or callbacks; no timer guesses how long filesystem I/O or usage recording takes.
function eagerJob(compactor: ContinuousCompactor): Promise<void> {
  const job = (compactor as unknown as { job: { done: Promise<void> } | null }).job;
  assert(job, "Expected an eager job to have started");
  return job.done;
}

describe("ContinuousCompactor", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  let handler: CompactionHandler;
  let emitter: EventEmitter;
  let compactor: ContinuousCompactor;
  let live: LiveSnapshot | undefined;
  let streaming: boolean;
  let prepare: ReturnType<typeof mock<Dependencies["prepare"]>>;
  let summarize: ReturnType<typeof mock<Dependencies["summarize"]>>;
  let fastApply: ReturnType<typeof mock<Dependencies["fastApply"]>>;
  let completed: ReturnType<typeof mock>;
  const jobs: Array<Promise<void>> = [];

  beforeEach(async () => {
    store = await createTestHistoryService();
    emitter = new EventEmitter();
    live = undefined;
    streaming = false;
    completed = mock();
    handler = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir: path.join(store.tempDir, "pending"),
      emitter,
      onCompactionComplete: completed,
    });
    prepare = mock(() => {
      emitter.emit("compaction.prepare");
      return Promise.resolve();
    });
    summarize = mock(() => Promise.resolve(summary));
    fastApply = mock(async (apply) => {
      streaming = false;
      live = undefined;
      return apply();
    });
    compactor = new ContinuousCompactor({
      workspaceId,
      historyService: store.historyService,
      compactionHandler: handler,
      streamManager: { getStreamInfo: () => live, isStreaming: () => streaming },
      prepare,
      summarize,
      fastApply,
    });
  });

  afterEach(async () => {
    compactor.reset("test cleanup");
    // An assertion failure must not leave a background summary waiting forever.
    for (const release of releaseLatches.splice(0)) release();
    await Promise.all(jobs.splice(0));
    await compactor.waitForIdle();
    mock.restore();
    await store.cleanup();
  });

  async function seed(...messages: MuxMessage[]) {
    for (const message of messages) {
      expect((await store.historyService.appendToHistory(workspaceId, message)).success).toBe(true);
    }
  }

  async function rows() {
    const result = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success, "History should be readable");
    return result.data;
  }

  async function seedConversation() {
    await seed(
      createMuxMessage("old-user", "user", "Investigate the regression"),
      createMuxMessage("old-answer", "assistant", "earlier investigation ".repeat(4_000)),
      createMuxMessage("recent-user", "user", "Implement the fix"),
      createMuxMessage("recent-answer", "assistant", "The fix is ready for review.")
    );
  }

  async function start(usage = eagerPercent, options = context) {
    const verdict = await compactor.observe(usage, options);
    const job = eagerJob(compactor);
    jobs.push(job);
    return { verdict, job };
  }

  async function stage() {
    await (
      await start()
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
  }

  it("starts once at the eager threshold, stages without a boundary, and applies without another summary", async () => {
    await seedConversation();
    const release = deferred();
    const entered = deferred();
    summarize.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return summary;
    });
    expect(await compactor.observe(eagerPercent - 1, context)).toBe("none");
    expect(prepare).not.toHaveBeenCalled();
    const { job } = await start();
    await entered.promise;
    expect(await compactor.observe(eagerPercent, context)).toBe("none");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect((await rows()).map((row) => row.id)).toContain("old-answer");
    release.resolve();
    await job;
    expect(await compactor.observe(eagerPercent, context)).toBe("none");
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect((await rows())[0].parts).toMatchObject([{ type: "text", text: summary.text }]);
  });

  for (const disabled of [{ enabled: false }, { thresholdPercent: 100 }]) {
    it(`does no prepare, summary, apply, or forced fallback when ${JSON.stringify(disabled)}`, async () => {
      await seedConversation();
      expect(await compactor.observe(200, { ...context, ...disabled })).toBe("none");
      expect(prepare).not.toHaveBeenCalled();
      expect(summarize).not.toHaveBeenCalled();
      expect(fastApply).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect((await rows()).map((row) => row.id)).toEqual([
        "old-user",
        "old-answer",
        "recent-user",
        "recent-answer",
      ]);
    });
  }

  for (const disabled of [{ enabled: false }, { thresholdPercent: 100 }]) {
    it(`discards an already staged summary when ${JSON.stringify(disabled)}`, async () => {
      await seedConversation();
      await stage();
      expect(await compactor.observe(200, { ...context, ...disabled, phase: "mid-stream" })).toBe(
        "none"
      );
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(fastApply).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      summarize.mockResolvedValue(null);
      const next = await start(context.thresholdPercent);
      await next.job;
      expect(next.verdict).toBe("none");
      expect(completed).not.toHaveBeenCalled();
      expect((await rows())[0].id).toBe("old-user");
    });
  }

  it("awaits compaction.prepare listener persistence before taking the head snapshot", async () => {
    await seedConversation();
    const listenerEntered = deferred();
    const release = deferred();
    let mutation = Promise.resolve();
    emitter.on("compaction.prepare", () => {
      mutation = (async () => {
        listenerEntered.resolve();
        await release.promise;
        const head = (await rows())[1];
        head.parts.push({ type: "text", text: "Prepared listener state" });
        expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
      })();
    });
    prepare.mockImplementation(async () => {
      emitter.emit("compaction.prepare");
      await mutation;
    });
    const { job } = await start();
    await listenerEntered.promise;
    expect(summarize).not.toHaveBeenCalled();
    release.resolve();
    await job;
    expect(summarize.mock.calls[0][0].find((row) => row.id === "old-answer")?.parts).toContainEqual(
      { type: "text", text: "Prepared listener state" }
    );
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
  });

  it("aborts reset and cannot stage a stale summary after its last usage-recording await", async () => {
    await seedConversation();
    const usageEntered = deferred();
    const usageRecorded = deferred();
    summarize.mockImplementation(async () => {
      usageEntered.resolve();
      await usageRecorded.promise;
      return summary;
    });
    const { job } = await start();
    await usageEntered.promise;
    const signal = summarize.mock.calls[0][1];
    compactor.reset("edited while recording usage");
    expect(signal.aborted).toBe(true);
    usageRecorded.resolve();
    await job;
    summarize.mockResolvedValue(null);
    const replacement = await start(context.thresholdPercent);
    expect(replacement.verdict).toBe("none");
    await replacement.job;
    expect(completed).not.toHaveBeenCalled();
    expect((await rows())[0].id).toBe("old-user");
  });

  for (const change of ["parts", "request metadata", "epoch", "truncate", "delete"] as const) {
    it(`rejects a staged summary after ${change} changes`, async () => {
      await seedConversation();
      await stage();
      const head = (await rows())[1];
      if (change === "parts") {
        head.parts.push({ type: "text", text: "An edit changes provider input" });
        expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
      } else if (change === "request metadata") {
        head.metadata = { ...head.metadata, fileAtMentionSnapshot: ["/tmp/new-context.ts"] };
        expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
      } else if (change === "epoch") {
        await seed(
          createMuxMessage("other-boundary", "assistant", "Another compaction", {
            compacted: "user",
            compactionBoundary: true,
            compactionEpoch: 1,
            muxMetadata: { type: "compaction-summary" },
          })
        );
      } else if (change === "truncate") {
        expect(
          (await store.historyService.truncateAfterMessage(workspaceId, head.id)).success
        ).toBe(true);
      } else {
        expect((await store.historyService.deleteMessage(workspaceId, head.id)).success).toBe(true);
      }
      summarize.mockResolvedValue(null);
      const next = await start(forcePercent);
      expect(next.verdict).toBe("fallback");
      await next.job;
      expect(completed).not.toHaveBeenCalled();
      expect(fastApply).not.toHaveBeenCalled();
    });
  }

  it("allows partial finalization, timestamps, and usage-only changes to the summarized head", async () => {
    await seedConversation();
    await stage();
    const head = (await rows())[1];
    head.metadata = {
      ...head.metadata,
      partial: false,
      timestamp: 9000,
      usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      contextUsage: { inputTokens: 600, outputTokens: 200, totalTokens: 800 },
    };
    expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent observes and awaits the single durable apply", async () => {
    await seedConversation();
    await stage();
    const entered = deferred();
    const release = deferred();
    fastApply.mockImplementation(async (apply) => {
      entered.resolve();
      await release.promise;
      return apply();
    });
    const first = compactor.observe(context.thresholdPercent, { ...context, phase: "mid-stream" });
    await entered.promise;
    expect(compactor.isApplying()).toBe(true);
    const second = compactor.observe(forcePercent, { ...context, phase: "mid-stream" });
    const idle = compactor.waitForIdle();
    release.resolve();
    expect(await Promise.all([first, second])).toEqual(["applied", "applied"]);
    await idle;
    expect(compactor.isApplying()).toBe(false);
    expect(fastApply).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect((await rows()).filter((row) => row.metadata?.compactionBoundary)).toHaveLength(1);
  });

  it("refuses to append a boundary while a stream remains active", async () => {
    await seedConversation();
    await stage();
    streaming = true;
    const result = await compactor
      .observe(context.thresholdPercent, context)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("stream is active");
    expect(completed).not.toHaveBeenCalled();
    expect((await rows())[0].id).toBe("old-user");
  });

  it("requires partial.json to be committed before applying the staged summary", async () => {
    await seedConversation();
    await stage();
    const partial = (await rows()).at(-1)!;
    partial.metadata = { ...partial.metadata, partial: true };
    expect((await store.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    const result = await compactor
      .observe(context.thresholdPercent, context)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("partial to be committed");
    expect(completed).not.toHaveBeenCalled();
    expect(await store.historyService.readPartial(workspaceId)).not.toBeNull();
    expect((await store.historyService.commitPartial(workspaceId)).success).toBe(true);
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
  });

  it("prepares durable file diffs before the boundary and reloads them after restart", async () => {
    await seedConversation();
    const edit = (await rows())[1];
    edit.parts.push({
      type: "dynamic-tool",
      toolCallId: "edit-1",
      toolName: "file_edit_replace_string",
      state: "output-available",
      input: { path: "/tmp/fix.ts" },
      output: { success: true, diff: "@@ -1 +1 @@\n-broken\n+fixed\n" },
    });
    expect((await store.historyService.updateHistory(workspaceId, edit)).success).toBe(true);
    await stage();
    const original = store.historyService.persistBoundaryWithTailCopies.bind(store.historyService);
    const persist = spyOn(store.historyService, "persistBoundaryWithTailCopies").mockImplementation(
      async (...args) => {
        const state: unknown = JSON.parse(
          await readFile(path.join(store.tempDir, "pending", "post-compaction.json"), "utf8")
        );
        expect(state).toMatchObject({
          diffs: [{ path: "/tmp/fix.ts", diff: "@@ -1 +1 @@\n-broken\n+fixed\n" }],
        });
        return original(...args);
      }
    );
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    expect(persist).toHaveBeenCalledTimes(1);
    const restarted = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir: path.join(store.tempDir, "pending"),
      emitter: new EventEmitter(),
    });
    expect((await restarted.peekPendingState())?.diffs).toMatchObject([
      { path: "/tmp/fix.ts", diff: "@@ -1 +1 @@\n-broken\n+fixed\n" },
    ]);
  });

  it("invalidates an apply reset during pending-state persistence", async () => {
    await seedConversation();
    await stage();
    const entered = deferred();
    const release = deferred();
    const original = handler.preparePendingStateFromMessages.bind(handler);
    spyOn(handler, "preparePendingStateFromMessages").mockImplementation(async (messages) => {
      await original(messages);
      entered.resolve();
      await release.promise;
    });
    const applying = compactor.observe(context.thresholdPercent, context);
    await entered.promise;
    compactor.reset("new turn while persisting pending state");
    summarize.mockResolvedValue(null);
    release.resolve();
    expect(await applying).toBe("none");
    const job = eagerJob(compactor);
    jobs.push(job);
    await job;
    expect(completed).not.toHaveBeenCalled();
    expect((await rows())[0].id).toBe("old-user");
  });

  async function seedLiveTurn() {
    await seed(
      createMuxMessage("old-user", "user", "Investigate the regression"),
      createMuxMessage("old-answer", "assistant", "earlier investigation ".repeat(4_000)),
      createMuxMessage("live-user", "user", "Implement and verify the fix")
    );
    const answer = createMuxMessage("live-answer", "assistant", "", {
      partial: true,
      stepStartPartIndices: [0, 1, 2],
      usage: { inputTokens: 70_000, outputTokens: 1_000, totalTokens: 71_000 },
      contextUsage: { inputTokens: 70_000, outputTokens: 1_000, totalTokens: 71_000 },
    });
    answer.parts = [
      { type: "text", text: "completed investigation ".repeat(4_000) },
      { type: "text", text: "latest completed step" },
      { type: "text", text: "currently streaming step" },
    ];
    await seed(answer);
    live = {
      messageId: answer.id,
      parts: structuredClone(answer.parts),
      stepStartIndices: [0, 1, 2],
      currentStepStartIndex: 2,
    };
    streaming = true;
    return answer;
  }

  it("copies a sliced live tail including post-snapshot fast-stop growth and the pending follow-up", async () => {
    const answer = await seedLiveTurn();
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
    const summarizedAnswer = summarize.mock.calls[0][0].find((row) => row.id === answer.id);
    assert(summarizedAnswer, "The earlier completed step should be in the summarized head");
    expect(summarizedAnswer.parts).toEqual(answer.parts.slice(0, 1));
    const followUp: CompactionFollowUpRequest = {
      text: "Continue verification",
      model: context.model,
      agentId: "exec",
      thinkingLevel: "high",
    };
    const afterSnapshot = { type: "text" as const, text: "Finished while stopping the stream" };
    fastApply.mockImplementation(async (apply) => {
      const partial = { ...answer, parts: [...answer.parts, afterSnapshot] };
      expect((await store.historyService.writePartial(workspaceId, partial)).success).toBe(true);
      expect((await store.historyService.commitPartial(workspaceId)).success).toBe(true);
      streaming = false;
      live = undefined;
      return apply(followUp);
    });
    expect(
      await compactor.observe(context.thresholdPercent, { ...context, phase: "mid-stream" })
    ).toBe("applied");
    expect(await store.historyService.readPartial(workspaceId)).toBeNull();
    const persisted = await rows();
    const boundary = persisted[0];
    expect(boundary.metadata?.muxMetadata).toMatchObject({
      strategy: "continuous",
      pendingFollowUp: followUp,
    });
    expect(persisted[1].role).toBe("user");
    expect(persisted[1].parts).toMatchObject([
      { type: "text", text: "Implement and verify the fix" },
    ]);
    const copy = persisted.find((row) => row.role === "assistant" && row.id !== boundary.id);
    assert(copy, "Expected the sliced assistant tail");
    expect(copy.id).not.toBe(answer.id);
    expect(copy.parts).toEqual([...answer.parts.slice(1), afterSnapshot]);
    expect(copy.metadata).toMatchObject({
      synthetic: true,
      uiVisible: true,
      rlmPreservedTailCopy: true,
      stepStartPartIndices: [0, 1],
    });
    expect(copy.metadata?.partial).toBeUndefined();
    expect(copy.metadata?.usage).toBeUndefined();
    expect(copy.metadata?.contextUsage).toBeUndefined();
    expect(copy.metadata?.compactionBoundary).toBeUndefined();
    const expectedInput =
      context.systemMessageTokens! +
      context.attachmentTokens! +
      persisted.reduce((sum, row) => sum + estimateMuxMessageTokens(row), 0);
    expect(boundary.metadata?.contextUsage?.inputTokens).toBe(expectedInput);
    expect(boundary.metadata?.contextUsage?.inputTokens).toBeGreaterThan(
      estimateMuxMessageTokens(boundary) + context.systemMessageTokens! + context.attachmentTokens!
    );
    expect(boundary.metadata?.usage).toBeUndefined();
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("uses finish-step's completed end even before the next start-step arrives", async () => {
    const answer = await seedLiveTurn();
    assert(live, "Expected an active stream snapshot");
    live.parts = live.parts.slice(0, 2);
    live.stepStartIndices = [0, 1];
    live.currentStepStartIndex = 2;
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
    const head = summarize.mock.calls[0][0];
    const summarizedAnswer = head.find((row) => row.id === answer.id);
    assert(summarizedAnswer, "The earlier completed step should be in the summarized head");
    expect(summarizedAnswer.parts).toEqual(answer.parts.slice(0, 1));
    expect(head.flatMap((row) => row.parts)).not.toContainEqual(answer.parts[1]);
  });

  it("waits for the first completed live step instead of summarizing an unfinished turn", async () => {
    await seedLiveTurn();
    assert(live, "Expected an active stream snapshot");
    live.stepStartIndices = [0];
    live.currentStepStartIndex = 0;
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it("does not summarize when even the mandatory live tail is too large", async () => {
    const answer = await seedLiveTurn();
    assert(live, "Expected an active stream snapshot");
    live.parts[1] = { type: "text", text: "mandatory completed step ".repeat(25_000) };
    answer.parts = structuredClone(live.parts);
    expect((await store.historyService.updateHistory(workspaceId, answer)).success).toBe(true);
    const { verdict, job } = await start(forcePercent, { ...context, phase: "mid-stream" });
    await job;
    expect(verdict).toBe("fallback");
    expect(summarize).not.toHaveBeenCalled();
    expect(fastApply).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it("skips applying when fast-stop growth makes the retained tail exceed the force budget", async () => {
    const answer = await seedLiveTurn();
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
    fastApply.mockImplementation(async (apply) => {
      const partial = {
        ...answer,
        parts: [
          ...answer.parts,
          { type: "text" as const, text: "unbounded late tool result ".repeat(25_000) },
        ],
      };
      expect((await store.historyService.writePartial(workspaceId, partial)).success).toBe(true);
      expect((await store.historyService.commitPartial(workspaceId)).success).toBe(true);
      streaming = false;
      live = undefined;
      return apply();
    });
    summarize.mockResolvedValue(null);
    const { verdict, job } = await start(forcePercent, { ...context, phase: "mid-stream" });
    expect(verdict).toBe("fallback");
    await job;
    expect(completed).not.toHaveBeenCalled();
    expect((await rows()).some((row) => row.metadata?.compactionBoundary)).toBe(false);
  });

  it("applies a no-tail summary when there is no safe recent suffix", async () => {
    await seed(
      createMuxMessage("only-answer", "assistant", "earlier investigation ".repeat(4_000))
    );
    await stage();
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].metadata?.compactionBoundary).toBe(true);
    expect(persisted[0].parts).toMatchObject([{ type: "text", text: summary.text }]);
    expect(completed.mock.calls[0][0]).toMatchObject({ preservedTailMessageCount: 0 });
  });

  it("requests full-compaction fallback at the force threshold when no summary is ready", async () => {
    await seedConversation();
    const release = deferred();
    summarize.mockImplementation(async () => {
      await release.promise;
      return summary;
    });
    const { verdict, job } = await start(forcePercent);
    expect(verdict).toBe("fallback");
    expect(completed).not.toHaveBeenCalled();
    release.resolve();
    await job;
  });
});
