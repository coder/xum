import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { json, rowsToBytes } from "./historyScanner.generator.testHarness";
import { createTestHistoryService } from "./testHistoryService";

// #4790: on POSIX the sidebar status read holds the history lock only for truncate recovery,
// open and fstat, then scans the pinned descriptors unlocked and verifies their stamps. These
// cases pause that scan at its first positional read (a gated FileHandle.read, no timers) and
// check that writers proceed, that every concurrent change fails the unlocked scan closed and
// falls back once to a fully locked read of the current files, and that descriptors never leak. Windows keeps the whole scan locked (open handles make rename fail there).
const posix = process.platform !== "win32";
const everyRow = () => true;

interface TrackedHandle {
  file: string;
  closed: boolean;
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
  const rows = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      json(createMuxMessage(`${prefix}${i}`, i % 2 ? "assistant" : "user", `${prefix} ${i}`))
    );
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
    options: { gate?: boolean; failOpen?: "archive"; failRead?: boolean } = {}
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
      const tracked: TrackedHandle = { file: String(file), closed: false };
      handles.push(tracked);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        tracked.closed = true;
        return close();
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

  test.skipIf(!posix)("a partial write completes while the scan is paused", async () => {
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

  test.skipIf(!posix)("an append during the paused scan falls back to a fresh read", async () => {
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

  test.skipIf(!posix)(
    "truncate recovery by another reader during the paused scan falls back to a fresh read",
    async () => {
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
    }
  );

  test.skipIf(!posix)(
    "a foreign in-place shrink the stamp check misses still fails the unlocked scan closed",
    async () => {
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
      ) =>
        args[0] === paths.chat && chatOpens() === 1 ? before : stat(...args)) as typeof fs.stat);
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
    }
  );

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
      // On POSIX a failed unlocked scan or stamp check retries once under the lock with two new
      // descriptors; Windows reads only once, under the lock (this file runs in the Windows smoke).
      const expectedHandles = c.options.failOpen ? 1 : c.expectOk || !posix ? 2 : 4;
      if (tracked.handles.length !== expectedHandles)
        problems.push(`${c.name}: opened ${tracked.handles.length}`);
      for (const handle of tracked.handles)
        if (!handle.closed) problems.push(`${c.name}: ${path.basename(handle.file)} left open`);
    }
    expect(problems).toEqual([]);
  });

  test.skipIf(posix)("Windows: a history-lock waiter runs only after the whole scan", async () => {
    const workspaceId = "lock-win32";
    await writeLayout(workspaceId, null, rows("m", 5));
    const paused = instrumentOpen(workspaceId, { gate: true });
    const read = status(workspaceId);
    await paused.reached;
    // The in-process history mutex writePartial and appendToHistory queue on. Unlocked, it
    // would run at once, before the paused scan closed its descriptor.
    let closedWhenLocked: boolean[] = [];
    const waiter = workspaceFileLocks.withLock(workspaceId, () => {
      closedWhenLocked = paused.handles.map((handle) => handle.closed);
      return Promise.resolve();
    });
    paused.release();
    const [result] = await Promise.all([read, waiter]);
    expect(result.success).toBe(true);
    expect(closedWhenLocked).toEqual([true]);
  });
});
