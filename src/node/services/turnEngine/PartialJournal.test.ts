import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { makeTestEffectRunner, type TestEffectRunner } from "@/node/services/di/testEffectRunner";
import type { HistoryService } from "@/node/services/historyService";
import { log } from "@/node/services/log";
import { createTestHistoryService } from "@/node/services/testHistoryService";

import { PartialJournal, type PartialJournalState, type PartialTarget } from "./PartialJournal";

const WORKSPACE_ID = "journal-ws";
const MESSAGE_ID = "msg-journal";
const THROTTLE_MS = 500;

const assistant = (text: string, id = MESSAGE_ID): MuxMessage =>
  createMuxMessage(id, "assistant", text);

const textOf = (message: MuxMessage): string =>
  message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

const partialText = async (historyService: HistoryService): Promise<string | null> => {
  const partial = await historyService.readPartial(WORKSPACE_ID);
  return partial == null ? null : textOf(partial);
};

describe("PartialJournal", () => {
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let clock: TestEffectRunner;
  let journal: PartialJournal;
  let state: PartialJournalState;
  /** What the turn has streamed so far; the journal snapshots it at write time. */
  let streamed: string;
  let target: PartialTarget;

  beforeEach(async () => {
    ({ historyService, cleanup } = await createTestHistoryService());
    clock = makeTestEffectRunner();
    journal = new PartialJournal({
      historyService,
      runner: clock.runner,
      clock: clock.hostClock,
      throttleMs: THROTTLE_MS,
    });
    state = PartialJournal.initialState();
    streamed = "";
    target = { workspaceId: WORKSPACE_ID, state, snapshot: () => assistant(streamed) };
  });

  afterEach(async () => {
    await clock.dispose();
    await cleanup();
  });

  /** The stream-start placeholder row of MESSAGE_ID; returns its historySequence. */
  const appendPlaceholder = async (): Promise<number | undefined> => {
    await historyService.appendToHistory(WORKSPACE_ID, assistant(""));
    const history = await historyService.getHistoryFromLatestBoundary(WORKSPACE_ID);
    if (!history.success) throw new Error(history.error);
    return history.data[0].metadata?.historySequence;
  };

  /** Resolves when writePartial has finished `count` writes in total. */
  const trackWrites = () => {
    const write = historyService.writePartial.bind(historyService);
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    let done = 0;
    const spy = spyOn(historyService, "writePartial").mockImplementation(async (...args) => {
      const result = await write(...args);
      done += 1;
      for (const waiter of waiters.filter((entry) => entry.count <= done)) waiter.resolve();
      return result;
    });
    const written = (count: number) =>
      new Promise<void>((resolve) => {
        if (done >= count) resolve();
        else waiters.push({ count, resolve });
      });
    return { spy, written };
  };

  test("writes at once, then at most once per throttle window with the latest snapshot", async () => {
    const { spy, written } = trackWrites();

    streamed = "a";
    await journal.schedule(target, undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await partialText(historyService)).toBe("a");

    // Inside the window: each schedule re-arms one delayed flush.
    streamed = "ab";
    await journal.schedule(target, undefined);
    await clock.adjust(THROTTLE_MS - 100);
    streamed = "abc";
    await journal.schedule(target, undefined);
    // The re-armed flush is due THROTTLE_MS after the first write, not after the re-arm.
    await clock.adjust(99);
    expect(spy).toHaveBeenCalledTimes(1);

    await clock.adjust(1);
    await written(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await partialText(historyService)).toBe("abc");

    // The interrupted first arm never fires later.
    await clock.adjust(THROTTLE_MS * 4);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("a flush waits for the in-flight write, then writes the snapshot of that moment", async () => {
    const write = historyService.writePartial.bind(historyService);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    spyOn(historyService, "writePartial").mockImplementation(async (workspaceId, message) => {
      started.push(textOf(message));
      if (started.length === 1) await firstGate;
      return write(workspaceId, message);
    });

    streamed = "first";
    const firstFlush = journal.flush(target);
    // Same-tick flushes are not serialized: start the second once the first write runs.
    for (let i = 0; i < 10 && started.length === 0; i++) await Promise.resolve();
    expect(started).toEqual(["first"]);
    streamed = "second";
    const secondFlush = journal.flush(target);
    // Give the second flush every chance to start a concurrent write.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(started).toEqual(["first"]);

    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);
    expect(started).toEqual(["first", "second"]);
    expect(await partialText(historyService)).toBe("second");
    expect(state.partialWritePromise).toBeUndefined();
  });

  test("after the final message is committed, no flush or armed debounce brings the partial back", async () => {
    const { spy } = trackWrites();
    const historySequence = await appendPlaceholder();

    streamed = "done";
    await journal.schedule(target, undefined);
    // Arm a debounce that is due after the commit.
    await journal.schedule(target, undefined);
    expect(await partialText(historyService)).toBe("done");

    const final = createMuxMessage(MESSAGE_ID, "assistant", "done", { historySequence });
    await journal.commitFinal(WORKSPACE_ID, state, final, log);
    expect(await historyService.readPartial(WORKSPACE_ID)).toBeNull();

    await clock.adjust(THROTTLE_MS);
    await journal.flush(target);
    await journal.schedule(target, undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await historyService.readPartial(WORKSPACE_ID)).toBeNull();
    const after = await historyService.getHistoryFromLatestBoundary(WORKSPACE_ID);
    expect(after.success && after.data.map((message) => message.id)).toEqual([MESSAGE_ID]);
  });

  test("a terminal partial retires the journal, so a later flush cannot replace it", async () => {
    streamed = "before error";
    await journal.flush(target, assistant("error partial"));
    await journal.flush(target);
    expect(await partialText(historyService)).toBe("error partial");
  });

  test("a failed final write keeps the partial and marks it finalized only for its own message", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await failedFinalWrite(warn.mock.calls);
    } finally {
      warn.mockRestore();
    }
  });

  const failedFinalWrite = async (warnings: unknown[][]) => {
    // No historySequence: updateHistory refuses the row.
    const final = assistant("final");

    await historyService.writePartial(WORKSPACE_ID, assistant("streamed"));
    await journal.commitFinal(WORKSPACE_ID, state, final, log);
    const kept = await historyService.readPartial(WORKSPACE_ID);
    expect(kept?.metadata?.streamFinalized).toBe(true);
    expect(kept?.parts).toEqual(final.parts);

    await historyService.writePartial(WORKSPACE_ID, assistant("other turn", "msg-other"));
    await journal.commitFinal(WORKSPACE_ID, PartialJournal.initialState(), final, log);
    const other = await historyService.readPartial(WORKSPACE_ID);
    expect(other?.id).toBe("msg-other");
    expect(other?.metadata?.streamFinalized).toBeUndefined();
    expect(warnings.map((call) => call[0])).toContain("Failed to mark the kept partial finalized");
  };

  test("a committed final message deletes only its own partial", async () => {
    const historySequence = await appendPlaceholder();
    await historyService.writePartial(WORKSPACE_ID, assistant("next turn", "msg-next"));

    const final = createMuxMessage(MESSAGE_ID, "assistant", "done", { historySequence });
    await journal.commitFinal(WORKSPACE_ID, state, final, log);
    expect((await historyService.readPartial(WORKSPACE_ID))?.id).toBe("msg-next");
  });

  test("an abandoned abort deletes only its own partial; a kept abort commits it", async () => {
    await historyService.writePartial(WORKSPACE_ID, assistant("other", "msg-other"));
    const otherResult = await journal.settleAbort(WORKSPACE_ID, MESSAGE_ID, true);
    expect(otherResult).toEqual({ success: true, data: false });
    expect((await historyService.readPartial(WORKSPACE_ID))?.id).toBe("msg-other");

    await historyService.writePartial(WORKSPACE_ID, assistant("mine"));
    expect(await journal.settleAbort(WORKSPACE_ID, MESSAGE_ID, true)).toEqual({
      success: true,
      data: true,
    });
    expect(await historyService.readPartial(WORKSPACE_ID)).toBeNull();

    const historySequence = await appendPlaceholder();
    await historyService.writePartial(
      WORKSPACE_ID,
      createMuxMessage(MESSAGE_ID, "assistant", "kept", { historySequence })
    );
    expect((await journal.settleAbort(WORKSPACE_ID, MESSAGE_ID, false)).success).toBe(true);
    expect(await historyService.readPartial(WORKSPACE_ID)).toBeNull();
    const history = await historyService.getHistoryFromLatestBoundary(WORKSPACE_ID);
    expect(history.success && history.data.map((message) => textOf(message))).toEqual(["kept"]);
  });

  test("a retry reset makes the next write immediate and drops an armed debounce", async () => {
    const { spy } = trackWrites();
    streamed = "attempt 1";
    await journal.schedule(target, undefined);

    // Same instant as the first write: without the reset this would only arm a debounce.
    await journal.resetForRetry(state);
    streamed = "attempt 2";
    await journal.schedule(target, undefined);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await partialText(historyService)).toBe("attempt 2");

    await journal.schedule(target, undefined);
    await journal.resetForRetry(state);
    await clock.adjust(THROTTLE_MS * 2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
