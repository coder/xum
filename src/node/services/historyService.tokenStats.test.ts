import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import * as historyScanner from "./historyScanner";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { workspaceRemovalTombstonePath } from "./workspaceRemoval";

// #5301: a token-stats miss reads the active epoch with the history locks held only for
// recovery + receipt + open and for the final receipt check. These cases park that scan at a
// deterministic gate (a spy on the snapshot read, no timers) and pin the failure policy: a stale
// snapshot is retried exactly once, then Err, and every opened descriptor is closed.
const posix = process.platform !== "win32";
const WS = "stats-ws";

describe("HistoryService.getHistoryForTokenStats", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let service: HistoryService;
  const restores: Array<() => void> = [];
  const realScan = historyScanner.readProviderHistoryFromSnapshot;

  beforeEach(async () => {
    h = await createTestHistoryService();
    service = h.historyService;
  });
  afterEach(async () => {
    for (const restore of restores.splice(0)) restore();
    await h.cleanup();
  });

  const chatPath = () => path.join(h.config.sessionsDir, WS, "chat.jsonl");
  const archivePath = () => path.join(h.config.sessionsDir, WS, "chat-archive.jsonl");
  const boundary = (id: string, epoch: number) =>
    createMuxMessage(id, "assistant", `Summary ${epoch}`, {
      compactionBoundary: true,
      compacted: "user",
      compactionEpoch: epoch,
    });
  async function append(...messages: MuxMessage[]): Promise<void> {
    for (const message of messages) {
      expect((await service.appendToHistory(WS, message)).success).toBe(true);
    }
  }
  const user = (id: string) => createMuxMessage(id, "user", `text of ${id}`);
  async function seedEpochs(): Promise<void> {
    await append(user("old-0"), user("old-1"), boundary("boundary-1", 1), user("post-0"));
  }
  async function statsRead(target = service) {
    const result = await target.getHistoryForTokenStats(WS);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }
  async function lockedRead(target = service): Promise<MuxMessage[]> {
    const result = await target.getHistoryFromLatestBoundary(WS);
    assert(result.success);
    return result.data;
  }
  function spyScan() {
    const spy = spyOn(historyScanner, "readProviderHistoryFromSnapshot");
    restores.push(() => spy.mockRestore());
    return spy;
  }
  /** Parks the next scan after open (locks released) until `release()`. */
  function parkNextScan() {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    spyScan().mockImplementationOnce(async (snapshot) => {
      reached.resolve();
      await gate.promise;
      try {
        return await realScan(snapshot);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    });
    return { reached: reached.promise, release: () => gate.resolve(), errors };
  }
  /** Every read-only chat/archive descriptor opened from now on, and whether it was closed. */
  function trackDescriptors() {
    const open = fs.open;
    const handles: Array<{ file: string; closes: number }> = [];
    const spy = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await open(...args);
      const [file, flags] = args;
      if ((file === chatPath() || file === archivePath()) && flags === "r") {
        const tracked = { file: String(file), closes: 0 };
        handles.push(tracked);
        const close = handle.close.bind(handle);
        handle.close = () => {
          tracked.closes++;
          return close();
        };
      }
      return handle;
    }) as typeof fs.open);
    restores.push(() => spy.mockRestore());
    return handles;
  }

  test.skipIf(!posix)("a since read, a window read and an append finish mid-scan", async () => {
    await seedEpochs();
    const parked = parkNextScan();
    const read = service.getHistoryForTokenStats(WS);
    await parked.reached;
    // Each deadlocks (test timeout) if the stats read still holds a history lock.
    const caps = { maxRows: 100, maxBytes: 1_000_000 };
    const window = await service.getHistoryWindowFromLatestBoundary(WS, caps);
    const since = await service.getHistorySinceFromLatestBoundary(WS, caps, {
      floor: 2,
      anchor: 3,
    });
    assert(window.success && window.data.kind === "window");
    assert(since.success && since.data.kind === "range");
    await append(user("mid-scan"));
    parked.release();
    const result = await read;
    assert(result.success);
    // The parked snapshot went stale; the single retry read (and certified) the current files.
    expect(parked.errors).toHaveLength(1);
    expect(result.data.messages).toEqual(await lockedRead());
    expect(result.data.messages.at(-1)?.id).toBe("mid-scan");
    expect(result.data.receiptKey).toBe(await service.captureTokenStatsReceiptKey(WS));
  });

  describe("rows equal the locked read", () => {
    test("normal rotated history", async () => {
      await seedEpochs();
      const stats = await statsRead();
      expect(stats.messages).toEqual(await lockedRead());
      expect(stats.receiptKey).not.toBeNull();
    });

    async function crashLayout(keepArchive: boolean): Promise<void> {
      await seedEpochs();
      const archived = await fs.readFile(archivePath(), "utf-8");
      const active = await fs.readFile(chatPath(), "utf-8");
      await fs.writeFile(chatPath(), archived + active);
      if (!keepArchive) await fs.rm(archivePath());
    }
    for (const [name, keepArchive] of [
      ["legacy unrotated (sealed prefix + boundary in chat.jsonl)", false],
      ["crash-replayed prefix (archive + the same prefix in chat.jsonl)", true],
    ] as const) {
      test(name, async () => {
        await crashLayout(keepArchive);
        // A fresh process: no full read has rotated or repaired the layout yet.
        const fresh = new HistoryService(h.config);
        const before = await fs.readFile(chatPath(), "utf-8");
        const stats = await statsRead(fresh);
        // The stats read never rotates (#5321): the files are untouched.
        expect(await fs.readFile(chatPath(), "utf-8")).toBe(before);
        expect(stats.messages.map((m) => m.id)).toEqual(["boundary-1", "post-0"]);
        expect(stats.messages).toEqual(await lockedRead(fresh));
      });
    }

    test("no boundary, with an archive", async () => {
      await append(user("a-0"), user("a-1"));
      await fs.rename(chatPath(), archivePath());
      await append(user("c-0"), user("c-1"));
      const stats = await statsRead();
      expect(stats.messages.map((m) => m.id)).toEqual(["a-0", "a-1", "c-0", "c-1"]);
      expect(stats.messages).toEqual(await lockedRead());
    });

    test("no history at all: empty rows and no receipt key", async () => {
      expect(await statsRead()).toEqual({ messages: [], receiptKey: null });
    });
  });

  describe("failure policy", () => {
    test("a failed verify is retried once and then succeeds", async () => {
      await seedEpochs();
      const scan = spyScan();
      scan.mockImplementationOnce((snapshot) =>
        realScan({ ...snapshot, verify: () => Promise.reject(new Error("changed")) })
      );
      expect((await statsRead()).messages).toEqual(await lockedRead());
      expect(scan).toHaveBeenCalledTimes(2);
    });

    test("two failed verifies are Err, with no third attempt", async () => {
      await seedEpochs();
      const scan = spyScan();
      scan.mockImplementation((snapshot) =>
        realScan({ ...snapshot, verify: () => Promise.reject(new Error("changed")) })
      );
      const result = await service.getHistoryForTokenStats(WS);
      assert(!result.success);
      expect(result.error).toContain("changed");
      expect(scan).toHaveBeenCalledTimes(2);
    });

    test.skipIf(!posix)("an in-place truncation during the scan is stale", async () => {
      await seedEpochs();
      const bytes = await fs.readFile(chatPath());
      const lastRowStart = bytes.lastIndexOf(10, bytes.length - 2) + 1;
      const parked = parkNextScan();
      const read = service.getHistoryForTokenStats(WS);
      await parked.reached;
      // A foreign shrink keeps the inode but drops the newest row.
      await fs.truncate(chatPath(), lastRowStart);
      parked.release();
      const result = await read;
      assert(result.success);
      expect(parked.errors).toHaveLength(1);
      expect(result.data.messages.map((m) => m.id)).toEqual(["boundary-1"]);
      expect(result.data.messages).toEqual(await lockedRead());
    });

    test.skipIf(!posix)("a removal tombstone published mid-read is Err", async () => {
      await seedEpochs();
      const parked = parkNextScan();
      const read = service.getHistoryForTokenStats(WS);
      await parked.reached;
      const tombstone = workspaceRemovalTombstonePath(h.config.rootDir, WS);
      await fs.mkdir(path.dirname(tombstone), { recursive: true });
      await fs.writeFile(tombstone, "{}");
      parked.release();
      const result = await read;
      assert(!result.success);
      expect(result.error).toContain("removed");
    });

    test("every opened descriptor is closed exactly once, on every path", async () => {
      await seedEpochs();
      const handles = trackDescriptors();
      const scan = spyScan();
      // Success.
      await statsRead();
      // Stale then retried.
      scan.mockImplementationOnce((snapshot) =>
        realScan({ ...snapshot, verify: () => Promise.reject(new Error("changed")) })
      );
      await statsRead();
      // A throwing scan on both attempts (Err).
      scan.mockImplementation(() => Promise.reject(new Error("scan exploded")));
      expect((await service.getHistoryForTokenStats(WS)).success).toBe(false);
      scan.mockRestore();
      // A changed receipt on both attempts (Err).
      const capture = spyOn(service, "captureTokenStatsReceiptKey");
      restores.push(() => capture.mockRestore());
      let n = 0;
      capture.mockImplementation(() => Promise.resolve(`key-${n++}`));
      expect((await service.getHistoryForTokenStats(WS)).success).toBe(false);
      // 1 + 2 + 2 + 2 attempts, each opening chat and archive.
      expect(handles).toHaveLength(14);
      expect(handles.every((handle) => handle.closes === 1)).toBe(true);
    });
  });
});
