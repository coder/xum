import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { HistoryService, mergeTranscriptPartial } from "./historyService";
import type { Config } from "@/node/config";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import * as fs from "fs/promises";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { historyWriteLockPath } from "@/node/services/workspaceRemoval";

/** Streams append their empty assistant placeholder before the first partial flush. */
async function appendPlaceholder(
  service: HistoryService,
  workspaceId: string,
  partial: MuxMessage
): Promise<void> {
  const placeholder = createMuxMessage(partial.id, "assistant", "", {
    historySequence: partial.metadata?.historySequence,
  });
  expect((await service.appendToHistory(workspaceId, { ...placeholder, parts: [] })).success).toBe(
    true
  );
}

describe("HistoryService partial persistence - Error Recovery", () => {
  let partialService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService: partialService, cleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanup();
  });

  test("commitPartial should strip error metadata and commit parts from errored partial", async () => {
    const workspaceId = "test-workspace";
    const erroredPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream error occurred",
        errorType: "network",
      },
      parts: [
        { type: "text", text: "Hello, I was processing when" },
        { type: "text", text: " the error occurred" },
      ],
    };

    await appendPlaceholder(partialService, workspaceId, erroredPartial);
    expect((await partialService.writePartial(workspaceId, erroredPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // Committed with cleaned metadata (no error/errorType), then the partial is deleted.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data.map((m) => m.id)).toEqual(["msg-1"]);
    const appendedMessage = committed.success ? committed.data[0] : undefined;
    expect(appendedMessage?.parts).toEqual(erroredPartial.parts);
    expect(appendedMessage?.metadata?.error).toBeUndefined();
    expect(appendedMessage?.metadata?.errorType).toBeUndefined();
    expect(appendedMessage?.metadata?.historySequence).toBe(1);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("updatePartialIfMessageIdMatches waits out a commitPartial transaction and declines", async () => {
    const workspaceId = "test-workspace";
    const partial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: { historySequence: 1, timestamp: Date.now(), model: "test-model" },
      parts: [{ type: "text", text: "Hello" }],
    };
    await appendPlaceholder(partialService, workspaceId, partial);
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);

    // Park the commit inside its transaction: call 1 is its lock-free probe, call 2 the snapshot
    // it takes once it holds both locks.
    let releaseCommitRead: (() => void) | undefined;
    const commitReadGate = new Promise<void>((resolve) => {
      releaseCommitRead = resolve;
    });
    let commitReadReached: (() => void) | undefined;
    const commitReadReachedGate = new Promise<void>((resolve) => {
      commitReadReached = resolve;
    });
    const readPartial = partialService.readPartial.bind(partialService);
    let readCalls = 0;
    const readSpy = spyOn(partialService, "readPartial").mockImplementation(
      async (targetWorkspaceId: string) => {
        if (++readCalls === 2) {
          commitReadReached?.();
          await commitReadGate;
        }
        return readPartial(targetWorkspaceId);
      }
    );
    try {
      const commit = partialService.commitPartial(workspaceId);
      await commitReadReachedGate;

      const cas = partialService.updatePartialIfMessageIdMatches(
        workspaceId,
        "msg-1",
        (current) => ({
          ...current,
          parts: [...current.parts, { type: "text", text: " (finalized)" }],
        })
      );
      const sentinel = Symbol("still-pending");
      expect(
        await Promise.race([
          cas,
          new Promise((resolve) => setTimeout(() => resolve(sentinel), 100)),
        ])
      ).toBe(sentinel);

      releaseCommitRead?.();
      expect((await commit).success).toBe(true);
      expect(await cas).toEqual(Ok(false));
    } finally {
      readSpy.mockRestore();
    }

    // The commit landed exactly what it snapshotted, and the CAS did not write anything.
    const committed = await partialService.getLastMessages(workspaceId, 1);
    expect(committed.success && committed.data[0]?.parts).toEqual(partial.parts);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial snapshots the partial after an in-flight updatePartialIfMessageIdMatches lands", async () => {
    const workspaceId = "test-workspace";
    const partial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: { historySequence: 1, timestamp: Date.now(), model: "test-model" },
      parts: [{ type: "text", text: "Hello" }],
    };
    await appendPlaceholder(partialService, workspaceId, partial);
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);
    const finalizedParts = [...partial.parts, { type: "text" as const, text: " (finalized)" }];

    // Park the CAS inside its critical section (after it took both locks, before it writes).
    let releaseCasRead: (() => void) | undefined;
    const casReadGate = new Promise<void>((resolve) => {
      releaseCasRead = resolve;
    });
    let casReadReached: (() => void) | undefined;
    const casReadReachedGate = new Promise<void>((resolve) => {
      casReadReached = resolve;
    });
    const readPartial = partialService.readPartial.bind(partialService);
    let readCalls = 0;
    const readSpy = spyOn(partialService, "readPartial").mockImplementation(
      async (targetWorkspaceId: string) => {
        if (readCalls++ === 0) {
          casReadReached?.();
          await casReadGate;
        }
        return readPartial(targetWorkspaceId);
      }
    );
    try {
      const cas = partialService.updatePartialIfMessageIdMatches(
        workspaceId,
        "msg-1",
        (current) => ({
          ...current,
          parts: finalizedParts,
        })
      );
      await casReadReachedGate;

      const commit = partialService.commitPartial(workspaceId);
      releaseCasRead?.();

      expect(await cas).toEqual(Ok(true));
      expect((await commit).success).toBe(true);
    } finally {
      readSpy.mockRestore();
    }

    // The commit waited for the CAS and committed the finalized partial, not its pre-update state.
    const committed = await partialService.getLastMessages(workspaceId, 1);
    expect(committed.success && committed.data[0]?.parts).toEqual(finalizedParts);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial should update existing placeholder when errored partial has more parts", async () => {
    const workspaceId = "test-workspace";
    const erroredPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream error occurred",
        errorType: "network",
      },
      parts: [
        { type: "text", text: "Accumulated content before error" },
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "input-available",
          input: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        },
      ],
    };

    const existingPlaceholder: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
      },
      parts: [], // Empty placeholder
    };

    // Seed the existing placeholder into history so the commit finds it by historySequence.
    await partialService.appendToHistory(workspaceId, existingPlaceholder);
    expect((await partialService.writePartial(workspaceId, erroredPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // The placeholder row is updated in place (no second row) with cleaned metadata.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data.map((m) => m.id)).toEqual(["msg-1"]);
    const updatedMessage = committed.success ? committed.data[0] : undefined;
    expect(updatedMessage?.parts).toEqual(erroredPartial.parts);
    expect(updatedMessage?.metadata?.error).toBeUndefined();
    expect(updatedMessage?.metadata?.errorType).toBeUndefined();
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial should skip tool-only incomplete partials", async () => {
    const workspaceId = "test-workspace";
    const toolOnlyPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream interrupted",
        errorType: "network",
      },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "input-available",
          input: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        },
      ],
    };

    await appendPlaceholder(partialService, workspaceId, toolOnlyPartial);
    expect((await partialService.writePartial(workspaceId, toolOnlyPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // Nothing committed (the blank errored placeholder is dropped), partial still cleaned up.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data).toEqual([]);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });
  test("commitPartial should skip empty errored partial", async () => {
    const workspaceId = "test-workspace";
    const emptyErrorPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Network error",
        errorType: "network",
      },
      parts: [], // Empty - no content accumulated before error
    };

    expect((await partialService.writePartial(workspaceId, emptyErrorPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // No value to preserve: nothing committed, partial still cleaned up.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data).toEqual([]);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial deletes a blank assistant placeholder after an empty errored partial", async () => {
    const workspaceId = "test-workspace";
    const historySequence = 1;

    await partialService.appendToHistory(
      workspaceId,
      createMuxMessage("msg-1", "assistant", "", {
        historySequence,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
      })
    );

    partialService.readPartial = mock(() =>
      Promise.resolve({
        id: "msg-1",
        role: "assistant",
        metadata: {
          historySequence,
          timestamp: Date.now(),
          model: "test-model",
          partial: true,
          error: "Network error",
          errorType: "empty_output",
        },
        parts: [],
      } satisfies MuxMessage)
    );

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    const historyResult = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    expect(historyResult.data).toEqual([]);
  });
  test("commitPartial deletes stale pre-boundary partial instead of appending it", async () => {
    const workspaceId = "test-workspace-stale-partial";
    const rows = [
      createMuxMessage("user-before", "user", "before", { historySequence: 0 }),
      createMuxMessage("assistant-before", "assistant", "before reply", { historySequence: 1 }),
      createMuxMessage("summary", "assistant", "summary", {
        historySequence: 2,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      }),
      createMuxMessage("user-after", "user", "after", { historySequence: 3 }),
    ];

    for (const row of rows) {
      const appendResult = await partialService.appendToHistory(workspaceId, row);
      expect(appendResult.success).toBe(true);
    }

    const stalePartial = createMuxMessage("assistant-before", "assistant", "stale partial", {
      historySequence: 1,
      partial: true,
    });
    const writePartialResult = await partialService.writePartial(workspaceId, stalePartial);
    expect(writePartialResult.success).toBe(true);

    const commitResult = await partialService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);

    const partialAfterCommit = await partialService.readPartial(workspaceId);
    expect(partialAfterCommit).toBeNull();

    const historyResult = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }

    expect(historyResult.data.map((message) => message.id)).toEqual(["summary", "user-after"]);
    expect(historyResult.data.at(-1)?.metadata?.historySequence).toBe(3);

    const nextMessage = createMuxMessage("next-user", "user", "next");
    const appendNextResult = await partialService.appendToHistory(workspaceId, nextMessage);
    expect(appendNextResult.success).toBe(true);
    expect(nextMessage.metadata?.historySequence).toBe(4);
  });
});

describe("HistoryService partial persistence - Foreign backend", () => {
  let config: Config;
  let partialService: HistoryService;
  let cleanup: () => Promise<void>;
  const workspaceId = "foreign-ws";
  const partial: MuxMessage = {
    id: "msg-1",
    role: "assistant",
    metadata: { historySequence: 1, timestamp: 1, model: "test-model", partial: true },
    parts: [{ type: "text", text: "Hello" }],
  };
  const stillPending = Symbol("still-pending");

  beforeEach(async () => {
    ({ config, historyService: partialService, cleanup } = await createTestHistoryService());
    await appendPlaceholder(partialService, workspaceId, partial);
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);
  });

  afterEach(async () => {
    await cleanup();
  });

  // Another backend (XUM_ALLOW_MULTIPLE_INSTANCES=1) holds the session-dir write lock.
  const holdForeignLock = () =>
    acquireProcessFileLock({
      lockPath: historyWriteLockPath(config.rootDir, workspaceId),
      timeoutMs: 5_000,
      label: "test foreign backend",
    });
  const overwritePartialOnDisk = (message: MuxMessage) =>
    fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "partial.json"),
      JSON.stringify(message)
    );
  const raceWithTimeout = <T>(promise: Promise<T>) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(stillPending), 250))]);

  test("commitPartial snapshots the partial only once it holds the cross-process lock", async () => {
    const foreign = await holdForeignLock();
    const commit = partialService.commitPartial(workspaceId);
    expect(await raceWithTimeout(commit)).toBe(stillPending);

    // The foreign holder finalizes the partial before releasing the lock.
    const finalizedParts = [...partial.parts, { type: "text" as const, text: " (finalized)" }];
    await overwritePartialOnDisk({ ...partial, parts: finalizedParts });
    await foreign[Symbol.asyncDispose]();

    expect((await commit).success).toBe(true);
    const committed = await partialService.getLastMessages(workspaceId, 1);
    expect(committed.success && committed.data[0]?.parts).toEqual(finalizedParts);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("updatePartialIfMessageIdMatches reads the partial only once it holds the cross-process lock", async () => {
    const foreign = await holdForeignLock();
    const cas = partialService.updatePartialIfMessageIdMatches(workspaceId, "msg-1", (current) => ({
      ...current,
      parts: [...current.parts, { type: "text", text: " (finalized)" }],
    }));
    expect(await raceWithTimeout(cas)).toBe(stillPending);

    // The foreign holder committed msg-1 and started a new stream under msg-2.
    const foreignPartial: MuxMessage = {
      ...partial,
      id: "msg-2",
      parts: [{ type: "text", text: "Next" }],
    };
    await overwritePartialOnDisk(foreignPartial);
    await foreign[Symbol.asyncDispose]();

    expect(await cas).toEqual(Ok(false));
    const onDisk = await partialService.readPartial(workspaceId);
    expect(onDisk?.id).toBe("msg-2");
    expect(onDisk?.parts).toEqual(foreignPartial.parts);
  });
});

describe("HistoryService partial persistence - Legacy compatibility", () => {
  let config: Config;
  let partialService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ config, historyService: partialService, cleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanup();
  });

  test("readPartial upgrades legacy cmuxMetadata", async () => {
    const workspaceId = "legacy-ws";
    const workspaceDir = path.join(config.sessionsDir, workspaceId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const partialMessage = createMuxMessage("partial-1", "assistant", "legacy", {
      historySequence: 0,
    });
    (partialMessage.metadata as Record<string, unknown>).cmuxMetadata = { type: "normal" };

    const partialPath = path.join(workspaceDir, "partial.json");
    await fs.writeFile(partialPath, JSON.stringify(partialMessage));

    const result = await partialService.readPartial(workspaceId);
    expect(result?.metadata?.muxMetadata?.type).toBe("normal");
  });
});

// A partial is only ever committed onto its own placeholder row (matched by message id AND
// historySequence). Crash-model findings F1/F2 (formal/history-crash): a partial whose turn an
// edit truncation removed must be retired, never resurrected, fail forever, or overwrite a newer
// row that reused its sequence.
describe("HistoryService partial persistence - Orphaned partials", () => {
  let config: Config;
  let a: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ config, historyService: a, cleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanup();
  });

  async function ids(service: HistoryService, workspaceId: string): Promise<string[]> {
    const history = await service.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    return history.data.map((message) => message.id);
  }

  async function row(service: HistoryService, workspaceId: string, id: string) {
    const history = await service.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    return history.data.find((message) => message.id === id);
  }

  /** A turn up to its first partial flush: user row, empty placeholder, partial.json. */
  async function startTurn(
    service: HistoryService,
    workspaceId: string,
    userId: string,
    assistantId: string
  ): Promise<MuxMessage> {
    const user = createMuxMessage(userId, "user", `prompt ${userId}`);
    expect((await service.appendToHistory(workspaceId, user)).success).toBe(true);
    const placeholder: MuxMessage = {
      ...createMuxMessage(assistantId, "assistant", ""),
      parts: [],
    };
    expect((await service.appendToHistory(workspaceId, placeholder)).success).toBe(true);
    const partial = createMuxMessage(assistantId, "assistant", `streamed ${assistantId}`, {
      historySequence: placeholder.metadata?.historySequence,
    });
    expect((await service.writePartial(workspaceId, partial)).success).toBe(true);
    return partial;
  }

  /** The next turn after an orphan was retired still commits its own partial. */
  async function expectNextTurnCommits(service: HistoryService, workspaceId: string) {
    await startTurn(service, workspaceId, "u-next", "a-next");
    expect((await service.commitPartial(workspaceId)).success).toBe(true);
    expect((await row(service, workspaceId, "a-next"))?.parts).toMatchObject([
      { type: "text", text: "streamed a-next" },
    ]);
  }

  test("a crash between an edit's publish and its partial retirement cannot resurrect the turn", async () => {
    const workspaceId = "orphan-f1";
    await startTurn(a, workspaceId, "u0", "a0");
    // The edit truncation publishes chat.jsonl, then the process dies before partial.json is
    // retired: its unlink fails the way a crash at that point would leave the disk.
    const partialPath = path.join(config.sessionsDir, workspaceId, "partial.json");
    const unlink = fs.unlink;
    const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (String(target) === partialPath) throw Object.assign(new Error("crash"), { code: "EIO" });
      return unlink(target);
    });
    try {
      expect(
        (await new HistoryService(config).truncateAfterMessage(workspaceId, "u0")).success
      ).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }
    expect((await a.readPartial(workspaceId))?.id).toBe("a0");

    // Restart; the edited prompt is re-sent and the stream start commits any partial.
    const restarted = new HistoryService(config);
    const edited = createMuxMessage("u0-edited", "user", "edited prompt");
    expect((await restarted.appendToHistory(workspaceId, edited)).success).toBe(true);
    expect((await restarted.commitPartial(workspaceId)).success).toBe(true);

    expect(await ids(restarted, workspaceId)).toEqual(["u0-edited"]);
    expect(await restarted.readPartial(workspaceId)).toBeNull();
    await expectNextTurnCommits(restarted, workspaceId);
  });

  test("a streaming backend's abort commit after a foreign edit retires its partial instead of failing", async () => {
    const workspaceId = "orphan-f2-abort";
    const b = new HistoryService(config); // second backend on the same root
    const partial = await startTurn(a, workspaceId, "u0", "a0");
    expect((await b.truncateAfterMessage(workspaceId, "u0")).success).toBe(true);
    // A's next delta recreates partial.json for the discarded turn.
    const more = { ...partial, parts: [{ type: "text" as const, text: "streamed a0 more" }] };
    expect((await a.writePartial(workspaceId, more)).success).toBe(true);

    expect((await a.commitPartial(workspaceId, "a0")).success).toBe(true);
    expect(await a.readPartial(workspaceId)).toBeNull();
    expect(await ids(a, workspaceId)).toEqual([]);
    // Nothing is left to block (or leak into) either backend's next send.
    await expectNextTurnCommits(a, workspaceId);
  });

  test("the other backend's next send does not commit the recreated partial of a discarded turn", async () => {
    const workspaceId = "orphan-f2-ghost";
    const b = new HistoryService(config);
    const partial = await startTurn(a, workspaceId, "u0", "a0");
    expect((await b.truncateAfterMessage(workspaceId, "u0")).success).toBe(true);
    expect((await a.writePartial(workspaceId, partial)).success).toBe(true);

    const u1 = createMuxMessage("u1", "user", "new prompt");
    expect((await b.appendToHistory(workspaceId, u1)).success).toBe(true);
    expect((await b.commitPartial(workspaceId)).success).toBe(true);

    expect(await ids(b, workspaceId)).toEqual(["u1"]);
    expect(await b.readPartial(workspaceId)).toBeNull();
  });

  test("a late completion of a discarded turn cannot overwrite a newer row that reused its sequence", async () => {
    const workspaceId = "orphan-f2-overwrite";
    const b = new HistoryService(config);
    const partial = await startTurn(a, workspaceId, "u0", "a0");
    expect((await b.truncateAfterMessage(workspaceId, "u0")).success).toBe(true);
    const u1 = createMuxMessage("u1", "user", "new prompt");
    expect((await b.appendToHistory(workspaceId, u1)).success).toBe(true);
    const a1 = createMuxMessage("a1", "assistant", "fresh answer");
    expect((await b.appendToHistory(workspaceId, a1)).success).toBe(true);
    expect(a1.metadata?.historySequence).toBe(partial.metadata?.historySequence);
    const before = await row(b, workspaceId, "a1");

    const final = createMuxMessage("a0", "assistant", "final a0", {
      historySequence: partial.metadata?.historySequence,
    });
    expect((await a.updateHistory(workspaceId, final)).success).toBe(false);

    expect(await ids(b, workspaceId)).toEqual(["u1", "a1"]);
    expect(await row(b, workspaceId, "a1")).toEqual(before);
  });

  test("a partial whose own row sits at another historySequence is retired, not committed", async () => {
    const workspaceId = "orphan-wrong-sequence";
    const partial = await startTurn(a, workspaceId, "u0", "a0");
    const before = await ids(a, workspaceId);
    const misplaced = {
      ...partial,
      metadata: {
        ...partial.metadata,
        historySequence: (partial.metadata?.historySequence ?? 0) + 5,
      },
    };
    expect((await a.writePartial(workspaceId, misplaced)).success).toBe(true);

    expect((await a.commitPartial(workspaceId)).success).toBe(true);

    expect(await a.readPartial(workspaceId)).toBeNull();
    expect(await ids(a, workspaceId)).toEqual(before);
    expect((await row(a, workspaceId, "a0"))?.parts).toEqual([]);
    await expectNextTurnCommits(a, workspaceId);
  });

  // The transcript overlay (tokenizer, subagent transcripts) must apply the same ownership rule
  // as commitPartial until the orphan is retired: it only ever replaces the partial's own row.
  describe("mergeTranscriptPartial", () => {
    async function merged(service: HistoryService, workspaceId: string): Promise<string[][]> {
      const history = await service.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      return mergeTranscriptPartial(history.data, await service.readPartial(workspaceId)).map(
        (message) => [message.id, ...message.parts.map((part) => ("text" in part ? part.text : ""))]
      );
    }

    /** F2: a foreign edit discards A's turn and A's next delta recreates its partial. */
    async function discardTurnAndRecreatePartial(workspaceId: string): Promise<HistoryService> {
      const b = new HistoryService(config);
      const partial = await startTurn(a, workspaceId, "u0", "a0");
      expect((await b.truncateAfterMessage(workspaceId, "u0")).success).toBe(true);
      const more = {
        ...partial,
        parts: [
          { type: "text" as const, text: "discarded a0" },
          { type: "text" as const, text: "discarded a0 more" },
        ],
      };
      expect((await a.writePartial(workspaceId, more)).success).toBe(true);
      return b;
    }

    test("does not show a discarded partial over a newer row that reused its sequence", async () => {
      const workspaceId = "orphan-f2-overwrite-overlay";
      const b = await discardTurnAndRecreatePartial(workspaceId);
      const u1 = createMuxMessage("u1", "user", "new prompt");
      expect((await b.appendToHistory(workspaceId, u1)).success).toBe(true);
      const a1 = createMuxMessage("a1", "assistant", "fresh answer");
      expect((await b.appendToHistory(workspaceId, a1)).success).toBe(true);
      expect(a1.metadata?.historySequence).toBe(
        (await a.readPartial(workspaceId))?.metadata?.historySequence
      );

      expect(await merged(b, workspaceId)).toEqual([
        ["u1", "new prompt"],
        ["a1", "fresh answer"],
      ]);
    });

    test("does not slot a discarded partial in between newer rows", async () => {
      const workspaceId = "orphan-f2-gap-overlay";
      const b = await discardTurnAndRecreatePartial(workspaceId);
      for (const message of [
        createMuxMessage("u1", "user", "new prompt"),
        createMuxMessage("a1", "assistant", "fresh answer"),
        createMuxMessage("u2", "user", "next prompt"),
      ]) {
        expect((await b.appendToHistory(workspaceId, message)).success).toBe(true);
      }
      // Leaves no row at the orphan's sequence, with newer rows after it.
      expect((await b.deleteMessage(workspaceId, "a1")).success).toBe(true);

      expect(await merged(b, workspaceId)).toEqual([
        ["u1", "new prompt"],
        ["u2", "next prompt"],
      ]);
    });

    test("does not duplicate a partial whose own row sits at another historySequence", async () => {
      const workspaceId = "orphan-wrong-sequence-overlay";
      const partial = await startTurn(a, workspaceId, "u0", "a0");
      const misplaced = {
        ...partial,
        metadata: {
          ...partial.metadata,
          historySequence: (partial.metadata?.historySequence ?? 0) + 5,
        },
      };
      expect((await a.writePartial(workspaceId, misplaced)).success).toBe(true);

      expect(await merged(a, workspaceId)).toEqual([["u0", "prompt u0"], ["a0"]]);
    });
  });
});
