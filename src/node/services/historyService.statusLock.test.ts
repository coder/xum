import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
// CJS default object: writeFileAtomic renames through it, so rename spies reach it.
import cjsFs from "fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { renameRetryTiming } from "@/node/utils/writeFileAtomic";
import { publishCompactionFile } from "./continuousCompactionJournal";
import { json, rowsToBytes } from "./historyScanner.generator.testHarness";
import { unlockedHistoryScans } from "./unlockedHistoryScans";
import { createTestHistoryService } from "./testHistoryService";

// #4790: the sidebar status read holds the history lock only for truncate recovery,
// open and fstat, then scans the pinned descriptors unlocked and verifies their stamps. These
// cases pause that scan at its first positional read (a gated FileHandle.read, no timers) and
// check that writers proceed, that every concurrent change fails the unlocked scan closed and
// falls back once to a fully locked read of the current files, and that descriptors never leak.
const everyRow = () => true;

interface TrackedHandle {
  file: string;
  closed: boolean;
  whenClosed: Promise<void>;
}

describe("HistoryService.getStatusHistorySuffix lock scope", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  const restores: Array<() => void> = [];
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    for (const restore of restores.splice(0)) restore();
    await h.cleanup();
  });

  const pathsFor = (workspaceId: string) => ({
    chat: path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"),
    archive: path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl"),
  });
  const messages = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      createMuxMessage(`${prefix}${i}`, i % 2 ? "assistant" : "user", `${prefix} ${i}`)
    );
  const rows = (prefix: string, count: number) => messages(prefix, count).map((m) => json(m));
  async function writeLayout(workspaceId: string, archive: string[] | null, chat: string[]) {
    const paths = pathsFor(workspaceId);
    await fs.mkdir(path.dirname(paths.chat), { recursive: true });
    if (archive) await fs.writeFile(paths.archive, rowsToBytes(archive));
    await fs.writeFile(paths.chat, rowsToBytes(chat));
  }
  const status = (workspaceId: string) =>
    h.historyService.getStatusHistorySuffix(workspaceId, 80, everyRow);
  async function statusIds(workspaceId: string): Promise<string[]> {
    const result = await status(workspaceId);
    if (!result.success) throw new Error(result.error);
    return result.data.map((m) => m.id);
  }
  async function fullIds(workspaceId: string): Promise<string[]> {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!result.success) throw new Error(result.error);
    return result.data.map((m) => m.id);
  }

  /**
   * Track every read-only history descriptor and optionally gate the first read of the first
   * chat.jsonl descriptor opened after this call. `failOpen` / `failRead` inject errors.
   */
  function instrumentOpen(
    workspaceId: string,
    options: { gate?: boolean; failOpen?: "archive"; failRead?: boolean; failClose?: boolean } = {}
  ) {
    const paths = pathsFor(workspaceId);
    const open = fs.open;
    const handles: TrackedHandle[] = [];
    let resolveReached!: () => void;
    const reached = new Promise<void>((resolve) => (resolveReached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = options.gate === true;
    const spy = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const [file, flags] = args;
      const history = (file === paths.chat || file === paths.archive) && flags === "r";
      if (history && options.failOpen === "archive" && file === paths.archive)
        throw Object.assign(new Error("injected open failure"), { code: "EACCES" });
      const handle = await open(...args);
      if (!history) return handle;
      let markClosed!: () => void;
      const whenClosed = new Promise<void>((resolve) => (markClosed = resolve));
      const tracked: TrackedHandle = { file: String(file), closed: false, whenClosed };
      handles.push(tracked);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        tracked.closed = true;
        await close();
        markClosed();
        if (options.failClose) throw new Error("injected close failure");
      };
      if (options.failRead && file === paths.chat)
        handle.read = (() =>
          Promise.reject(new Error("injected read failure"))) as typeof handle.read;
      if (armed && file === paths.chat) {
        armed = false;
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        handle.read = (async (...readArgs: unknown[]) => {
          handle.read = read as typeof handle.read;
          resolveReached();
          await gate;
          return read(...readArgs);
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof fs.open);
    restores.push(() => spy.mockRestore());
    return { handles, reached, release, restore: () => spy.mockRestore() };
  }

  test("a partial write completes while the scan is paused", async () => {
    const workspaceId = "lock-partial";
    await writeLayout(workspaceId, null, rows("m", 5));
    const expected = await statusIds(workspaceId);
    const paused = instrumentOpen(workspaceId, { gate: true });
    const read = status(workspaceId);
    await paused.reached;
    // Deadlocks (test timeout) if the scan still holds the history lock.
    const written = await h.historyService.writePartial(
      workspaceId,
      createMuxMessage("partial", "assistant", "streaming")
    );
    expect(written.success).toBe(true);
    paused.release();
    const result = await read;
    expect(result.success ? result.data.map((m) => m.id) : result.error).toEqual(expected);
  });

  test("an append during the paused scan falls back to a fresh read", async () => {
    const workspaceId = "lock-append";
    await writeLayout(workspaceId, null, rows("m", 5));
    const paused = instrumentOpen(workspaceId, { gate: true });
    const read = status(workspaceId);
    await paused.reached;
    const appended = await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("late", "user", "late")
    );
    expect(appended.success).toBe(true);
    paused.release();
    const result = await read;
    // The pinned snapshot ends before "late", so only the locked fallback can return it.
    expect(result.success ? result.data.map((m) => m.id) : result.error).toEqual(
      await statusIds(workspaceId)
    );
    expect(result.success && result.data.at(-1)?.id).toBe("late");
  });

  test("truncate recovery by another reader during the paused scan falls back to a fresh read", async () => {
    // Chat has no boundary and fewer rows than the window, so the scan also reads the archive.
    const workspaceId = "lock-recovery";
    await writeLayout(workspaceId, rows("a", 4), rows("c", 3));
    const paths = pathsFor(workspaceId);
    const paused = instrumentOpen(workspaceId, { gate: true });
    const read = status(workspaceId);
    await paused.reached;
    // A crashed truncation: the tombstone holds the pre-truncation archive and the marker's
    // hashes match nothing, so recovery rolls the archive back to the tombstone.
    await fs.writeFile(`${paths.archive}.truncate`, rowsToBytes(rows("old", 2)));
    await fs.writeFile(
      `${paths.archive}.truncate.json`,
      JSON.stringify({ finalArchiveHash: "0".repeat(64), finalChatHash: "0".repeat(64) })
    );
    const recovered = await fullIds(workspaceId);
    expect(recovered.slice(0, 2)).toEqual(["old0", "old1"]);
    paused.release();
    const result = await read;
    expect(result.success ? result.data.map((m) => m.id) : result.error).toEqual(recovered);
  });

  test("a foreign in-place shrink the stamp check misses still fails the unlocked scan closed", async () => {
    const workspaceId = "lock-shrink";
    const chat = rows("m", 40);
    await writeLayout(workspaceId, null, chat);
    const paths = pathsFor(workspaceId);
    const before = await fs.stat(paths.chat);
    const paused = instrumentOpen(workspaceId, { gate: true });
    const read = status(workspaceId);
    await paused.reached;
    await fs.truncate(paths.chat, Math.floor(before.size / 2));
    // Hide the shrink from the unlocked scan's stamp check (taken while only its own chat
    // descriptor is open), so only the short positional read can catch it.
    const chatOpens = () => paused.handles.filter((handle) => handle.file === paths.chat).length;
    const stat = fs.stat;
    const statSpy = spyOn(fs, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => (args[0] === paths.chat && chatOpens() === 1 ? before : stat(...args))) as typeof fs.stat);
    restores.push(() => statSpy.mockRestore());
    paused.release();
    const result = await read;
    statSpy.mockRestore();
    // A second chat descriptor means the unlocked scan failed and the locked fallback read
    // the shrunk file, matching an ungated read of the same bytes (never a partial parse).
    expect(chatOpens()).toBe(2);
    expect(result.success ? result.data.map((m) => m.id) : result.error).toEqual(
      await statusIds(workspaceId)
    );
  });

  test("closes every descriptor when an open, the scan or the stamp check fails", async () => {
    const cases = [
      { name: "success", expectOk: true, options: {} },
      { name: "second open", expectOk: false, options: { failOpen: "archive" as const } },
      { name: "scan", expectOk: false, options: { failRead: true } },
      { name: "stamp check", expectOk: false, options: {}, failStat: true },
    ];
    const problems: string[] = [];
    for (const c of cases) {
      const workspaceId = `lock-close-${c.name.replace(" ", "-")}`;
      await writeLayout(workspaceId, rows("a", 2), rows("c", 2));
      const paths = pathsFor(workspaceId);
      const tracked = instrumentOpen(workspaceId, c.options);
      const stat = fs.stat;
      let checkedAfterOpen = false;
      const statSpy = spyOn(fs, "stat").mockImplementation((async (
        ...args: Parameters<typeof fs.stat>
      ) => {
        // The stamp check stats chat.jsonl after both descriptors of an attempt are open.
        if (c.failStat && args[0] === paths.chat && tracked.handles.length >= 2) {
          checkedAfterOpen = true;
          throw Object.assign(new Error("injected stat failure"), { code: "EIO" });
        }
        return stat(...args);
      }) as typeof fs.stat);
      const result = await status(workspaceId);
      statSpy.mockRestore();
      tracked.restore();
      if (result.success !== c.expectOk) problems.push(`${c.name}: success=${result.success}`);
      if (c.failStat && !checkedAfterOpen) problems.push(`${c.name}: stamp check not reached`);
      // A failed unlocked scan or stamp check retries once under the lock with two new descriptors.
      const expectedHandles = c.options.failOpen ? 1 : c.expectOk ? 2 : 4;
      if (tracked.handles.length !== expectedHandles)
        problems.push(`${c.name}: opened ${tracked.handles.length}`);
      for (const handle of tracked.handles)
        if (!handle.closed) problems.push(`${c.name}: ${path.basename(handle.file)} left open`);
    }
    expect(problems).toEqual([]);
  });

  test("a scan whose close fails still releases its hold on the history files", async () => {
    const workspaceId = "lock-close-throws";
    await writeLayout(workspaceId, null, rows("m", 3));
    const tracked = instrumentOpen(workspaceId, { failClose: true });
    const result = await status(workspaceId);
    tracked.restore();
    expect(result.success).toBe(false);
    // A leaked registration would block every later publication over chat.jsonl forever.
    const released = await Promise.race([
      unlockedHistoryScans.waitForClose(pathsFor(workspaceId).chat).then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    expect(released).toBe(true);
  });

  test("an async rewrite retries a Windows sharing violation until the scan closes", async () => {
    const workspaceId = "lock-retry";
    const seeded = messages("m", 5);
    for (const message of seeded) await h.historyService.appendToHistory(workspaceId, message);
    const paths = pathsFor(workspaceId);
    const paused = instrumentOpen(workspaceId, { gate: true });
    const openChat = () =>
      paused.handles.filter((handle) => handle.file === paths.chat && !handle.closed);
    // Windows semantics on every platform: replacing chat.jsonl fails while a reader holds it.
    let sharingViolations = 0;
    const realRename = cjsFs.rename.bind(cjsFs);
    const renameSpy = spyOn(cjsFs, "rename").mockImplementation(((
      from: cjsFs.PathLike,
      to: cjsFs.PathLike,
      callback: cjsFs.NoParamCallback
    ) => {
      if (path.basename(String(to)) === "chat.jsonl" && openChat().length > 0) {
        sharingViolations += 1;
        paused.release();
        callback(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));
        return;
      }
      realRename(from, to, callback);
    }) as typeof cjsFs.rename);
    const nowSpy = spyOn(renameRetryTiming, "now").mockReturnValue(0);
    const sleepSpy = spyOn(renameRetryTiming, "sleep").mockImplementation(async () => {
      await Promise.all(openChat().map((handle) => handle.whenClosed));
    });
    restores.push(
      () => renameSpy.mockRestore(),
      () => nowSpy.mockRestore(),
      () => sleepSpy.mockRestore()
    );

    const read = status(workspaceId);
    await paused.reached;
    const target = seeded[2];
    const updated = await h.historyService.updateHistory(workspaceId, {
      ...target,
      parts: [{ type: "text", text: "rewritten" }],
    });
    const result = await read;

    expect(sharingViolations).toBeGreaterThan(0);
    expect(updated.success ? "ok" : updated.error).toBe("ok");
    expect(result.success ? result.data.map((m) => m.id) : result.error).toEqual(
      await statusIds(workspaceId)
    );
    const fresh = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(fresh.success && fresh.data.find((m) => m.id === target.id)?.parts).toEqual([
      { type: "text", text: "rewritten" },
    ]);
    expect(paused.handles.every((handle) => handle.closed)).toBe(true);
  });

  // Each synchronous publication renames over chat.jsonl or the archive right after its ownership
  // check, and truncations also unlink and rename them. Linux cannot observe the Windows sharing
  // violation, so these cases observe that the writer waits for the in-flight scan (entering the
  // drain) before it changes anything.
  async function replacementFor(workspaceId: string) {
    const capture = await h.historyService.captureCompactionReplacement(workspaceId);
    if (!capture.success) throw new Error(capture.error);
    return { capture: capture.data, isCurrent: () => true, onGenerationAdvanced: () => undefined };
  }
  const drainCases: Array<{
    name: string;
    drains: Array<"chat" | "archive">;
    setup: (workspaceId: string) => Promise<() => Promise<boolean>>;
  }> = [
    {
      name: "publishTruncationUnderWriteLock",
      drains: ["chat", "archive"],
      setup: async (workspaceId) => {
        await writeLayout(workspaceId, rows("a", 4), rows("c", 3));
        const replacement = await replacementFor(workspaceId);
        return async () =>
          (await h.historyService.truncateAfterMessage(workspaceId, "a1", { replacement })).success;
      },
    },
    {
      name: "truncateHistory full clear",
      drains: ["chat"],
      setup: async (workspaceId) => {
        await writeLayout(workspaceId, null, rows("c", 3));
        return async () => (await h.historyService.truncateHistory(workspaceId, 1)).success;
      },
    },
    {
      name: "truncateHistory with an archive",
      drains: ["chat", "archive"],
      setup: async (workspaceId) => {
        await writeLayout(workspaceId, rows("a", 2), rows("c", 4));
        return async () => (await h.historyService.truncateHistory(workspaceId, 0.5)).success;
      },
    },
    {
      name: "clearCompactionHistoryUnderHistoryLock",
      drains: ["chat"],
      setup: async (workspaceId) => {
        await writeLayout(workspaceId, null, rows("c", 3));
        return () =>
          h.historyService.withHistoryScanLocks(workspaceId, () =>
            h.historyService.clearCompactionHistoryUnderHistoryLock(
              workspaceId,
              1,
              () => true,
              () => Promise.resolve(),
              () => undefined
            )
          );
      },
    },
    {
      name: "publishHistoryUnderWriteLock",
      drains: ["chat"],
      setup: async (workspaceId) => {
        await writeLayout(workspaceId, null, rows("c", 4));
        const replacement = await replacementFor(workspaceId);
        return async () =>
          (await h.historyService.truncateAfterMessage(workspaceId, "c2", { replacement })).success;
      },
    },
    {
      name: "cleanupCompactionFollowUp",
      drains: ["chat"],
      setup: async (workspaceId) => {
        const summary = createMuxMessage("summary", "assistant", "summary", {
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "resume", model: "openai:gpt-4o", agentId: "exec" },
          },
        });
        await h.historyService.appendToHistory(workspaceId, summary);
        return async () => {
          const result = await h.historyService.cleanupCompactionFollowUp(
            workspaceId,
            summary,
            "clear",
            () => true
          );
          return result.success && result.data === "applied";
        };
      },
    },
    {
      name: "publishCompactionFile",
      drains: ["chat"],
      setup: async (workspaceId) => {
        await writeLayout(workspaceId, null, rows("c", 3));
        return () =>
          publishCompactionFile(pathsFor(workspaceId).chat, rowsToBytes(rows("n", 2)), () => true);
      },
    },
  ];

  test.each(drainCases)("$name waits for an in-flight scan before changing history", async (c) => {
    const workspaceId = `lock-drain-${c.name}`;
    const run = await c.setup(workspaceId);
    const watched = c.drains.map((artifact) => pathsFor(workspaceId)[artifact]);
    const stamps = () =>
      Promise.all(
        watched.map((file) =>
          fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return "missing";
          })
        )
      );
    const before = await stamps();
    const drained = new Set<string>();
    const drains: Array<Promise<void>> = [];
    let enterDrain!: () => void;
    const drainEntered = new Promise<"drain">((resolve) => (enterDrain = () => resolve("drain")));
    const waitForClose = unlockedHistoryScans.waitForClose.bind(unlockedHistoryScans);
    const drainSpy = spyOn(unlockedHistoryScans, "waitForClose").mockImplementation((filePath) => {
      const drain = waitForClose(filePath);
      if (watched.includes(path.resolve(filePath))) {
        drained.add(path.resolve(filePath));
        drains.push(drain);
        enterDrain();
      }
      return drain;
    });
    restores.push(() => drainSpy.mockRestore());

    const paused = instrumentOpen(workspaceId, { gate: true });
    const read = status(workspaceId);
    await paused.reached;
    let settled = false;
    const op = run().finally(() => (settled = true));
    expect(await Promise.race([op.then(() => "op" as const), drainEntered])).toBe("drain");
    // The paused scan must hold the drain open; an unregistered scan resolves it at once.
    const drainState = await Promise.race([
      ...drains.map((drain) => drain.then(() => "closed" as const)),
      new Promise<"open">((resolve) => setImmediate(() => resolve("open"))),
    ]);
    expect(drainState).toBe("open");
    expect(await stamps()).toEqual(before);
    expect(settled).toBe(false);
    paused.release();
    const [result, published] = await Promise.all([read, op]);

    expect(result.success).toBe(true);
    expect(published).toBe(true);
    expect([...drained].sort()).toEqual([...watched].sort());
    const after = await stamps();
    expect(after.filter((stamp, i) => stamp === before[i])).toEqual([]);
  });
});
