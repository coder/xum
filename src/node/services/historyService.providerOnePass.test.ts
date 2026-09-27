import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { normalizePersistedMessage } from "@/node/utils/messages/normalizePersistedMessage";
import {
  deepEqualAnyDepth,
  generateRows,
  json,
  mulberry32,
  rowsToBytes,
  type GeneratedRow,
} from "./historyScanner.generator.testHarness";
import {
  isReadableHistoryMessage,
  readProviderHistory,
  readProviderHistoryFromLatestBoundary,
} from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";

// Skip-0 provider reads (every request and replay) answer in one pass (#4655). They must return
// exactly what the two-pass reader returns: a difference either leaks rows from behind a privacy
// floor or drops context. The two-pass reader stays the oracle.
describe("one-pass skip-0 provider read", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const pathsFor = (workspaceId: string) => ({
    chat: path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"),
    archive: path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl"),
  });
  async function writeLayout(
    workspaceId: string,
    archive: GeneratedRow[] | Buffer | null,
    chat: GeneratedRow[] | Buffer | null
  ) {
    const paths = pathsFor(workspaceId);
    await fs.mkdir(path.dirname(paths.chat), { recursive: true });
    const bytes = (rows: GeneratedRow[] | Buffer) =>
      Buffer.isBuffer(rows) ? rows : rowsToBytes(rows);
    if (archive) await fs.writeFile(paths.archive, bytes(archive));
    if (chat) await fs.writeFile(paths.chat, bytes(chat));
  }
  /** The two-pass oracle's messages and summed replay bytes (#4504) over the current files. */
  async function oracle(workspaceId: string) {
    let bytes = 0;
    const messages = await readProviderHistoryFromLatestBoundary(pathsFor(workspaceId), 0, {
      onBytesRead: (n) => (bytes += n),
    });
    return { messages, bytes };
  }

  test("equals the two-pass reader on generated layouts, before and after rotation", async () => {
    const problems: string[] = [];
    for (const adversarial of [false, true]) {
      for (let seed = 1; seed <= 90; seed++) {
        const random = mulberry32(seed);
        const rows = generateRows(random, { oversized: seed % 9 === 0, adversarial });
        const split = Math.floor(random() * (rows.length + 1));
        const workspaceId = `one-pass-${adversarial ? "adv" : "plain"}-${seed}`;
        const label = `${adversarial ? "adversarial" : "plain"} seed ${seed}`;
        // Cover each layout: chat only, archive+chat, archive only.
        if (seed % 3 === 0) await writeLayout(workspaceId, null, rows);
        else if (seed % 3 === 1)
          await writeLayout(workspaceId, rows.slice(0, split), rows.slice(split));
        else await writeLayout(workspaceId, rows, null);

        // Unrotated layout, straight at the scanner (the service rotates before it reads).
        let bytes = 0;
        const raw = await readProviderHistory(pathsFor(workspaceId), {
          onBytesRead: (n) => (bytes += n),
        });
        const before = await oracle(workspaceId);
        if (!deepEqualAnyDepth(raw, before.messages)) problems.push(`${label}: unrotated messages`);
        if (bytes !== before.bytes) problems.push(`${label}: unrotated bytes`);

        // Through the service, which may rotate first; the oracle then reads the same files.
        bytes = 0;
        const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId, 0, {
          onBytesRead: (n) => (bytes += n),
        });
        if (!result.success) throw new Error(result.error);
        const after = await oracle(workspaceId);
        if (!deepEqualAnyDepth(result.data, after.messages))
          problems.push(`${label}: service messages`);
        if (bytes !== after.bytes) problems.push(`${label}: service bytes`);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  test("fails closed if chat.jsonl changes during the read", async () => {
    const workspaceId = "one-pass-replaced";
    await writeLayout(workspaceId, null, [json(createMuxMessage("u", "user", "hello"))]);
    // Warm up once so the one-time rotation check is done and the next chat stat is the
    // snapshot verification after the read.
    expect((await h.historyService.getHistoryFromLatestBoundary(workspaceId, 0)).success).toBe(
      true
    );
    const paths = pathsFor(workspaceId);
    const stat = fs.stat;
    let changed = false;
    const spy = spyOn(fs, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => {
      if (args[0] === paths.chat && !changed) {
        changed = true;
        await fs.appendFile(paths.chat, `${json(createMuxMessage("late", "user", "late"))}\n`);
      }
      return stat(...args);
    }) as typeof fs.stat);
    try {
      const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId, 0);
      expect(changed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.success ? "" : result.error).toContain("History changed during provider read");
    } finally {
      spy.mockRestore();
    }
  });

  // Skip > 0 keeps the two-pass reader, whose tail decodes per row. Invalid UTF-8 right before or
  // after a newline must not swallow the newline and merge rows, and a final row without a newline
  // must still be read.
  test("per-row tail decoding equals decoding the whole tail", async () => {
    const workspaceId = "one-pass-decode";
    const boundary = (id: string, epoch: number) =>
      json(
        createMuxMessage(id, "assistant", "summary", {
          compactionBoundary: true,
          compacted: "user",
          compactionEpoch: epoch,
        })
      );
    const row = (id: string, text: string) => json(createMuxMessage(id, "user", text));
    const [head, rest] = row("invalid-text", "PLACEHOLDER").split("PLACEHOLDER");
    const prefix = Buffer.from(`${row("old", "before the read")}\n`);
    const tail = Buffer.concat([
      Buffer.from(`${boundary("b1", 1)}\n`),
      Buffer.from(`${row("multi", "héllo — 日本語 🎉")}\r\n`),
      Buffer.from("\n  \t \n\r\n"),
      // Truncated multibyte sequences at the end of a row, right before the newline.
      Buffer.concat([Buffer.from("garbage "), Buffer.from([0xe2, 0x82]), Buffer.from("\n")]),
      Buffer.from(`${row("after-truncated", "kept")}\n`),
      // A lone continuation byte right after the newline.
      Buffer.concat([Buffer.from([0x80]), Buffer.from(`${row("x", "dropped")}\n`)]),
      // Invalid bytes inside a JSON string decode to replacement characters.
      Buffer.from(head),
      Buffer.from([0xf0, 0x9f]),
      Buffer.from(`ok${rest}\n`),
      Buffer.from(`${boundary("b2", 2)}\n`),
      Buffer.from(`${row("newest", "no trailing newline")}`),
    ]);
    await writeLayout(workspaceId, null, Buffer.concat([prefix, tail]));

    // The pre-#4655 decode, applied to the bytes skip 1 must return.
    const expected: MuxMessage[] = [];
    for (const line of tail.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isReadableHistoryMessage(value)) expected.push(normalizePersistedMessage(value));
      } catch {
        // Unusable rows are not projected.
      }
    }
    expect(expected.map((m) => m.id)).toEqual([
      "b1",
      "multi",
      "after-truncated",
      "invalid-text",
      "b2",
      "newest",
    ]);

    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId, 1);
    if (!result.success) throw new Error(result.error);
    expect(result.data).toEqual(expected);
  });
});
