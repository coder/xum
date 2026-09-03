import * as path from "path";
/* eslint-disable @typescript-eslint/unbound-method */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import * as fs from "fs/promises";

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

    // Mock readPartial to return errored partial
    partialService.readPartial = mock(() => Promise.resolve(erroredPartial));

    // Mock deletePartial
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));

    // Spy on partialService methods to verify calls
    const appendSpy = spyOn(partialService, "appendToHistory");

    // Call commitPartial
    const result = await partialService.commitPartial(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should have called appendToHistory with cleaned metadata (no error/errorType)
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const appendedMessage = appendSpy.mock.calls[0][1];

    expect(appendedMessage.id).toBe("msg-1");
    expect(appendedMessage.parts).toEqual(erroredPartial.parts);
    expect(appendedMessage.metadata?.error).toBeUndefined();
    expect(appendedMessage.metadata?.errorType).toBeUndefined();
    expect(appendedMessage.metadata?.historySequence).toBe(1);

    // Should have deleted the partial after committing
    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
  });

  test("updatePartialIfMessageIdMatches yields to a commitPartial already in flight", async () => {
    const workspaceId = "test-workspace";
    const partial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: { historySequence: 1, timestamp: Date.now(), model: "test-model" },
      parts: [{ type: "text", text: "Hello" }],
    };
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);

    // Park the commit after it has snapshotted the partial and before its history writes.
    let releaseHistoryRead: (() => void) | undefined;
    const historyReadGate = new Promise<void>((resolve) => {
      releaseHistoryRead = resolve;
    });
    const readHistory = partialService.getHistoryFromLatestBoundary.bind(partialService);
    const historySpy = spyOn(partialService, "getHistoryFromLatestBoundary").mockImplementation(
      async (targetWorkspaceId: string) => {
        await historyReadGate;
        return readHistory(targetWorkspaceId);
      }
    );
    try {
      const commit = partialService.commitPartial(workspaceId);

      const cas = await partialService.updatePartialIfMessageIdMatches(
        workspaceId,
        "msg-1",
        (current) => ({
          ...current,
          parts: [...current.parts, { type: "text", text: " (finalized)" }],
        })
      );
      expect(cas).toEqual(Ok(false));

      releaseHistoryRead?.();
      expect((await commit).success).toBe(true);
    } finally {
      historySpy.mockRestore();
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
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);
    const finalizedParts = [...partial.parts, { type: "text" as const, text: " (finalized)" }];

    // Park the CAS inside its critical section (after it took the lock, before it writes).
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

    // Mock readPartial to return errored partial
    partialService.readPartial = mock(() => Promise.resolve(erroredPartial));

    // Mock deletePartial
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));

    // Seed existing placeholder into history so getHistoryFromLatestBoundary finds it
    await partialService.appendToHistory(workspaceId, existingPlaceholder);

    // Spy on partialService methods AFTER seeding to verify only commitPartial calls
    const appendSpy = spyOn(partialService, "appendToHistory");
    const updateSpy = spyOn(partialService, "updateHistory");

    // Call commitPartial
    const result = await partialService.commitPartial(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should have called updateHistory (not append) with cleaned metadata
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();

    const updatedMessage = updateSpy.mock.calls[0][1];

    expect(updatedMessage.parts).toEqual(erroredPartial.parts);
    expect(updatedMessage.metadata?.error).toBeUndefined();
    expect(updatedMessage.metadata?.errorType).toBeUndefined();

    // Should have deleted the partial after updating
    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
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

    partialService.readPartial = mock(() => Promise.resolve(toolOnlyPartial));
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));

    // Spy on partialService methods to verify calls
    const appendSpy = spyOn(partialService, "appendToHistory");
    const updateSpy = spyOn(partialService, "updateHistory");

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();

    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
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

    // Mock readPartial to return empty errored partial
    partialService.readPartial = mock(() => Promise.resolve(emptyErrorPartial));

    // Mock deletePartial
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));

    // Spy on partialService methods to verify calls
    const appendSpy = spyOn(partialService, "appendToHistory");

    // Call commitPartial
    const result = await partialService.commitPartial(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call appendToHistory for empty message (no value to preserve)
    expect(appendSpy).not.toHaveBeenCalled();

    // Should still delete the partial (cleanup)
    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
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

    const deleteMessageSpy = spyOn(partialService, "deleteMessage");

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);
    expect(deleteMessageSpy).toHaveBeenCalledWith(workspaceId, "msg-1");

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
