import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "@/node/utils/writeFileAtomic";
import { createMuxMessage } from "@/common/types/message";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

const workspaceId = "truncation-compatibility";
const hash = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");
const reset = Buffer.concat([
  Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},'),
  Buffer.from([0xff]),
  Buffer.from("\n"),
]);
const active = Buffer.from(
  JSON.stringify(createMuxMessage("public", "user", "public facts")) + "\n"
);
const backup = Buffer.from(
  JSON.stringify(createMuxMessage("private", "user", "private facts")) + "\n"
);
const legacyHashes = {
  finalArchiveHash: hash(reset.toString("utf8")),
  finalChatHash: hash(active.toString("utf8")),
};
const rawHashes = {
  version: 1,
  finalArchiveHash: hash(reset),
  finalChatHash: hash(active),
};

describe("HistoryService truncation marker compatibility", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let chatPath: string;
  let archivePath: string;
  let markerPath: string;
  let tombstonePath: string;
  beforeEach(async () => {
    h = await createTestHistoryService();
    chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    archivePath = path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl");
    markerPath = `${archivePath}.truncate.json`;
    tombstonePath = `${archivePath}.truncate`;
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("seed", "user", "seed")
        )
      ).success
    ).toBe(true);
  });
  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  async function publishOwnedArchive(
    finalArchive: Buffer | null,
    isCurrent: () => boolean,
    onCommitted: () => undefined,
    finalChat: Buffer | null = active
  ) {
    const history = h.historyService as unknown as {
      rewriteHistoryFilesUnlocked(
        workspace: string,
        archive: Buffer | null,
        chat: Buffer | null,
        publication: {
          assertStillOwned: () => Promise<void>;
          isCurrent: () => boolean;
          onCommitted: () => undefined;
        }
      ): Promise<void>;
    };
    return h.historyService.withCompactionStorageLock(workspaceId, (_dir, assertStillOwned) =>
      history.rewriteHistoryFilesUnlocked(workspaceId, finalArchive, finalChat, {
        assertStillOwned,
        isCurrent,
        onCommitted,
      })
    );
  }

  test.skipIf(process.platform === "win32").each([
    ["retained archive", false],
    ["retained archive", true],
    ["removed archive", false],
    ["removed archive", true],
    ["removed chat", false],
    ["removed chat", true],
  ] as const)(
    "owned %s receipt waits for directory durability (flush fails=%s)",
    async (kind, fails) => {
      if (kind !== "removed chat") await fs.writeFile(archivePath, backup);
      const finalArchive = kind === "retained archive" ? reset : null;
      const finalChat = kind === "removed chat" ? null : active;
      let flushed = false;
      let flushedAtReceipt = false;
      const sync = nodeFs.fsyncSync;
      spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
        if (nodeFs.fstatSync(fd).isDirectory()) {
          if (fails) throw new Error("truncation directory unavailable");
          flushed = true;
        }
        return sync(fd);
      });
      const committed = mock(() => {
        flushedAtReceipt = flushed;
        return undefined;
      });
      if (fails) {
        await assert.rejects(
          publishOwnedArchive(finalArchive, () => true, committed, finalChat),
          /directory unavailable/
        );
        expect(committed).not.toHaveBeenCalled();
      } else {
        await publishOwnedArchive(finalArchive, () => true, committed, finalChat);
        expect(committed).toHaveBeenCalledTimes(1);
        expect(flushedAtReceipt).toBe(true);
        if (finalChat) expect(await fs.readFile(chatPath)).toEqual(finalChat);
        else expect(nodeFs.existsSync(chatPath)).toBe(false);
        if (finalArchive) expect(await fs.readFile(archivePath)).toEqual(finalArchive);
        else expect(nodeFs.existsSync(archivePath)).toBe(false);
      }
    }
  );

  test("owned archive publication commits retained raw bytes and chat before notification", async () => {
    await fs.writeFile(archivePath, backup);
    let current = true;
    const committed = mock(() => {
      expect(nodeFs.readFileSync(archivePath)).toEqual(reset);
      expect(nodeFs.readFileSync(chatPath)).toEqual(active);
      current = false;
      return undefined;
    });
    await publishOwnedArchive(reset, () => current, committed);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(nodeFs.existsSync(markerPath)).toBe(false);
    expect(nodeFs.existsSync(tombstonePath)).toBe(false);
  });

  test.each(["archive", "chat"] as const)(
    "Stop during owned %s staging leaves all history unchanged",
    async (stage) => {
      await fs.writeFile(archivePath, backup);
      const beforeChat = await fs.readFile(chatPath);
      let current = true;
      const atomic = atomicWrite.default;
      spyOn(atomicWrite, "default").mockImplementation(
        new Proxy(atomic, {
          async apply(target, receiver, args: Parameters<typeof atomic>) {
            const result = await Reflect.apply(target, receiver, args);
            if (
              String(args[0]).startsWith(
                `${stage === "archive" ? archivePath : chatPath}.publication-`
              )
            )
              current = false;
            return result;
          },
        })
      );
      const committed = mock(() => undefined);
      await assert.rejects(
        publishOwnedArchive(reset, () => current, committed),
        /no longer owned/
      );
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(beforeChat);
      expect(await fs.readFile(archivePath)).toEqual(backup);
      expect(nodeFs.existsSync(markerPath)).toBe(false);
      expect(nodeFs.existsSync(tombstonePath)).toBe(false);
    }
  );

  test.each([false, true])(
    "failed owned archive publication restores history only while its lease remains current (foreign=%s)",
    async (foreign) => {
      await fs.writeFile(archivePath, backup);
      const beforeChat = await fs.readFile(chatPath);
      const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
      const successor = new Map([
        [chatPath, "foreign chat"],
        [archivePath, "foreign archive"],
        [markerPath, "foreign marker"],
        [tombstonePath, "foreign tombstone"],
      ]);
      const rename = nodeFs.renameSync;
      spyOn(nodeFs, "renameSync").mockImplementation((source, destination) => {
        if (destination === chatPath) {
          if (foreign) {
            nodeFs.writeFileSync(lockPath, "foreign-owner");
            for (const [file, bytes] of successor) nodeFs.writeFileSync(file, bytes);
          }
          throw new Error("chat publication failed");
        }
        return rename(source, destination);
      });
      const committed = mock(() => undefined);
      try {
        await assert.rejects(publishOwnedArchive(reset, () => true, committed));
        expect(committed).not.toHaveBeenCalled();
        if (foreign) {
          for (const [file, bytes] of successor)
            expect(await fs.readFile(file, "utf8")).toBe(bytes);
        } else {
          expect(await fs.readFile(chatPath)).toEqual(beforeChat);
          expect(await fs.readFile(archivePath)).toEqual(backup);
          expect(nodeFs.existsSync(markerPath)).toBe(false);
          expect(nodeFs.existsSync(tombstonePath)).toBe(false);
        }
      } finally {
        if (foreign) await fs.rm(lockPath, { force: true });
      }
    }
  );

  test("owned archive cleanup failure preserves a committed transaction for restart", async () => {
    await fs.writeFile(archivePath, backup);
    const rm = fs.rm;
    spyOn(fs, "rm").mockImplementation((file, options) =>
      file === tombstonePath ? Promise.reject(new Error("cleanup failed")) : rm(file, options)
    );
    const committed = mock(() => undefined);
    await publishOwnedArchive(reset, () => true, committed);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(chatPath)).toEqual(active);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    mock.restore();
    await new HistoryService(h.config).getLastMessages(workspaceId, 1);
    expect(await fs.readFile(chatPath)).toEqual(active);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    expect(nodeFs.existsSync(markerPath)).toBe(false);
    expect(nodeFs.existsSync(tombstonePath)).toBe(false);
  });

  async function seedTransaction(marker: unknown, archive = reset): Promise<void> {
    await fs.writeFile(archivePath, archive);
    await fs.writeFile(chatPath, active);
    await fs.writeFile(tombstonePath, backup);
    await fs.writeFile(markerPath, JSON.stringify(marker));
  }

  test.each(["preceding build", "current build"])(
    "a committed new marker is recognized by the %s after a cleanup crash",
    async (reader) => {
      await fs.writeFile(archivePath, Buffer.concat([backup, reset]));
      const rows = [
        createMuxMessage("first", "user", "public context ".repeat(2000)),
        createMuxMessage("last", "user", "public context ".repeat(2000)),
      ];
      await fs.writeFile(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const originalRm = fs.rm;
      const cleanupFailure = spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (args[0] === tombstonePath) throw new Error("simulated cleanup crash");
        return originalRm(...args);
      });
      try {
        expect((await h.historyService.truncateHistory(workspaceId, 0.5)).success).toBe(true);
      } finally {
        cleanupFailure.mockRestore();
      }
      const finalArchive = await fs.readFile(archivePath);
      const finalChat = await fs.readFile(chatPath);
      expect(finalArchive).toEqual(reset);
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
      expect(marker.rawHashes).toEqual({
        version: 1,
        finalArchiveHash: hash(finalArchive),
        finalChatHash: hash(finalChat),
      });
      // The preceding build reads UTF-8 strings, ignores unknown fields, and
      // retires the tombstone only when both of these original fields match.
      const recognizedByOldBuild =
        marker.finalArchiveHash === hash(finalArchive.toString("utf8")) &&
        marker.finalChatHash === hash(finalChat.toString("utf8"));
      expect(recognizedByOldBuild).toBe(true);
      if (reader === "preceding build") {
        if (recognizedByOldBuild) {
          await fs.rm(tombstonePath);
          await fs.rm(markerPath);
        }
      } else {
        expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
      }
      expect(await fs.readFile(archivePath)).toEqual(finalArchive);
      expect(await fs.readFile(chatPath)).toEqual(finalChat);
      expect(
        await fs.stat(tombstonePath).then(
          () => true,
          () => false
        )
      ).toBe(false);
    }
  );

  test("upgrade recognizes a committed legacy UTF-8 marker with invalid bytes", async () => {
    await seedTransaction(legacyHashes);
    expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    expect(
      await fs.stat(tombstonePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("versioned raw hashes reject a byte change hidden by UTF-8 decoding", async () => {
    const changed = Buffer.from(reset);
    changed[changed.indexOf(0xff)] = 0xfe;
    expect(changed.toString("utf8")).toBe(reset.toString("utf8"));
    await seedTransaction({ ...legacyHashes, rawHashes }, changed);
    expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(backup);
  });

  test.each(
    [
      null,
      {},
      { ...rawHashes, version: 2 },
      { ...rawHashes, finalArchiveHash: 42 },
      { ...rawHashes, finalChatHash: "invalid" },
    ].map((value) => [value] as const)
  )(
    "malformed raw hash extension fails closed instead of falling back to legacy hashes: %j",
    async (extension) => {
      await seedTransaction({ ...legacyHashes, rawHashes: extension });
      expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
      expect(await fs.readFile(archivePath)).toEqual(backup);
    }
  );

  test.each([true, false])(
    "new recovery verifies committed raw hashes (tombstone: %s)",
    async (tombstone) => {
      await seedTransaction({ ...legacyHashes, rawHashes });
      if (!tombstone) await fs.rm(tombstonePath);
      expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
      expect(await fs.readFile(archivePath)).toEqual(reset);
      expect(
        await fs.stat(markerPath).then(
          () => true,
          () => false
        )
      ).toBe(false);
    }
  );

  test("a committed full delete with null raw hashes cannot resurrect its tombstone", async () => {
    await seedTransaction({
      finalArchiveHash: null,
      finalChatHash: null,
      rawHashes: { version: 1, finalArchiveHash: null, finalChatHash: null },
    });
    await fs.rm(archivePath);
    await fs.rm(chatPath);
    const next = createMuxMessage("fresh", "user", "fresh request");
    const restarted = new HistoryService(h.config);
    expect((await restarted.appendToHistory(workspaceId, next)).success).toBe(true);
    expect(next.metadata?.historySequence).toBe(0);
    expect(
      await fs.stat(tombstonePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(
      await fs.stat(archivePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("new recovery rolls back a prepared marker when only the archive commit landed", async () => {
    await seedTransaction({ ...legacyHashes, rawHashes });
    await fs.writeFile(chatPath, backup);
    expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(backup);
  });
});

/**
 * Two-backend race (TLA+ formal/history-crash ArchiveSwap A2): backend A's read path probes
 * for truncation artifacts, releases the lock, then re-acquires it for the lazy sealed-history
 * rotation. Backend B truncates in that gap and is SIGKILLed after renaming the archive to its
 * tombstone. Rotation must recover B's transaction first; appending to a fresh archive would
 * make the next recovery delete it together with the rotated rows.
 */
describe("HistoryService rotation over a crashed foreign truncation", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  const ws = "rotation-foreign-truncate";
  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  const allIds = ["boundary-0", "pre-0", "boundary-1", "post-0", "boundary-2", "post-1"];
  const fullIds = async () => {
    const ids: string[] = [];
    const result = await new HistoryService(h.config).iterateFullHistory(ws, "forward", (chunk) => {
      ids.push(...chunk.map((message) => message.id));
    });
    assert(result.success, result.success ? "" : result.error);
    return ids;
  };

  /** Epoch 1 sealed in the archive; chat.jsonl holds epochs 2 and 3, epoch 2 not yet rotated. */
  async function seedUnrotatedEpoch() {
    h = await createTestHistoryService();
    const dir = path.join(h.config.sessionsDir, ws);
    const row = (id: string, seq: number, epoch?: number) =>
      JSON.stringify({
        ...createMuxMessage(
          id,
          epoch ? "assistant" : "user",
          epoch ? `summary ${epoch}` : `message ${id}`,
          epoch
            ? {
                historySequence: seq,
                compactionBoundary: true,
                compacted: "user",
                compactionEpoch: epoch,
              }
            : { historySequence: seq }
        ),
        workspaceId: ws,
      }) + "\n";
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat.jsonl"),
      row("boundary-0", 0, 1) + row("pre-0", 1) + row("boundary-1", 2, 2) + row("post-0", 3)
    );
    // Rotates epoch 1 into the archive, so B's truncation has an archive to tombstone.
    expect((await h.historyService.getHistoryFromLatestBoundary(ws)).success).toBe(true);
    // A second boundary whose rotation has not happened yet (crash between the boundary
    // write and its rotation), which a fresh backend's lazy rotation heals on read.
    await fs.appendFile(path.join(dir, "chat.jsonl"), row("boundary-2", 4, 3) + row("post-1", 5));
    expect(await fullIds()).toEqual(allIds);
    return {
      archive: path.join(dir, "chat-archive.jsonl"),
      tombstone: path.join(dir, "chat-archive.jsonl.truncate"),
    };
  }

  /**
   * The first tombstone stat is backend A's lock-free read probe. Crash backend B right
   * after it (the race) or right before it (control: the probe sees the artifacts).
   */
  function crashForeignTruncationAtProbe(
    tombstone: string,
    crashAt: "after" | "before",
    percentage?: number,
    failNextProbe = false
  ) {
    const originalStat = fs.stat;
    const state = { raced: false, probeFailed: false };
    spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) !== tombstone) return originalStat(...args);
      // The next tombstone stat after the race is rotation's own artifact probe.
      if (state.raced && failNextProbe && !state.probeFailed) {
        state.probeFailed = true;
        throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      }
      if (state.raced) return originalStat(...args);
      state.raced = true;
      if (crashAt === "before") runCrashingForeignTruncation(h.config.rootDir, ws, percentage);
      try {
        return await originalStat(...args);
      } finally {
        if (crashAt === "after") runCrashingForeignTruncation(h.config.rootDir, ws, percentage);
      }
    }) as typeof fs.stat);
    return state;
  }

  test.skipIf(process.platform === "win32").each([
    ["between the read probe and rotation", "after"],
    ["before the read probe", "before"],
  ] as const)(
    "keeps every sealed row when backend B crashes %s",
    async (_label, crashAt) => {
      const { tombstone } = await seedUnrotatedEpoch();
      const race = crashForeignTruncationAtProbe(tombstone, crashAt);
      expect((await new HistoryService(h.config).getHistoryFromLatestBoundary(ws)).success).toBe(
        true
      );
      mock.restore();
      expect(race.raced).toBe(true);

      // Epoch 1 rows may be removed by the crashed truncation or restored by its rollback.
      const archived = new Set(["boundary-0", "pre-0"]);
      expect((await fullIds()).filter((id) => !archived.has(id))).toEqual([
        "boundary-1",
        "post-0",
        "boundary-2",
        "post-1",
      ]);
    },
    60_000
  );

  test.skipIf(process.platform === "win32").each(["artifact probe", "rollback rename"] as const)(
    "fails the read when the %s inside rotation fails, then heals on retry",
    async (failure) => {
      const { archive, tombstone } = await seedUnrotatedEpoch();
      // Removing chat rows too keeps B's transaction uncommitted, so recovery rolls it back.
      const race = crashForeignTruncationAtProbe(
        tombstone,
        "after",
        0.5,
        failure === "artifact probe"
      );
      // Or recovery's rollback (tombstone -> archive) fails once with a transient error.
      const originalRename = fs.rename;
      let renameFailed = false;
      spyOn(fs, "rename").mockImplementation((async (...args: Parameters<typeof fs.rename>) => {
        if (
          failure === "rollback rename" &&
          !renameFailed &&
          String(args[0]) === tombstone &&
          String(args[1]) === archive
        ) {
          renameFailed = true;
          throw Object.assign(new Error("injected EIO"), { code: "EIO" });
        }
        return originalRename(...args);
      }) as typeof fs.rename);
      // skip = 2 reaches the archived epoch. Swallowing the failure as a best-effort rotation
      // error would read without the archive and silently clamp to the boundary-1 epoch.
      const read = await new HistoryService(h.config).getHistoryFromLatestBoundary(ws, 2);
      mock.restore();
      expect(race.raced).toBe(true);
      expect(failure === "artifact probe" ? race.probeFailed : renameFailed).toBe(true);
      expect(read.success).toBe(false);

      const retry = await new HistoryService(h.config).getHistoryFromLatestBoundary(ws, 2);
      assert(retry.success, retry.success ? "" : retry.error);
      expect(retry.data.map((message) => message.id)).toEqual(allIds);
      expect(await fullIds()).toEqual(allIds);
    },
    60_000
  );
});

/** Backend B: a real second process killed after rename(archive -> tombstone), before chat.jsonl. */
function runCrashingForeignTruncation(rootDir: string, ws: string, percentage = 0.1): void {
  const script = `
    import { Config } from "@/node/config";
    import { HistoryService } from "@/node/services/historyService";
    // writeFileAtomic calls the CommonJS fs.rename at call time, so this hook sees the
    // chat.jsonl publication and dies before it: the disk then holds the marker and the
    // tombstone with no archive, exactly a crash at that point of the truncation.
    const nodeFs = require("fs");
    const rename = nodeFs.rename;
    nodeFs.rename = (from, to, callback) => {
      if (String(to).endsWith("chat.jsonl") && nodeFs.existsSync(String(to).slice(0, -"chat.jsonl".length) + "chat-archive.jsonl.truncate"))
        process.kill(process.pid, "SIGKILL");
      return rename(from, to, callback);
    };
    const result = await new HistoryService(new Config(${JSON.stringify(rootDir)})).truncateHistory(${JSON.stringify(ws)}, ${percentage});
    console.log("NOT CRASHED", JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: path.resolve(__dirname, "../../.."),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert(child.signal === "SIGKILL", `backend B did not crash: ${child.stdout}${child.stderr}`);
}
