import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";

/**
 * The maxHistorySequence append precondition of acceptCompactionReplacement (#7214): a Token
 * Budget warning is refused when history holds a row its request did not read. The check reads
 * back from the tail and stops at the first older row, so a stage publication never loads the
 * whole history under the write lock.
 */
const workspaceId = "max-history-sequence";

describe("maxHistorySequence append precondition", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  async function appendWithMax(message: MuxMessage, observer: { maxHistorySequence?: number }) {
    const history = fixture.historyService;
    const capture = await history.captureCompactionReplacement(workspaceId);
    assert(capture.success);
    return history.acceptCompactionReplacement(
      workspaceId,
      capture.data,
      { kind: "append", messages: [message], preserveCancellation: true },
      { isCurrent: () => true, onCommitted: () => undefined, ...observer }
    );
  }

  async function tailSequence(): Promise<number> {
    const rows = await fixture.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(rows.success);
    const tail = rows.data.at(-1)?.metadata?.historySequence;
    assert(tail != null);
    return tail;
  }

  async function ids() {
    const rows = await fixture.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(rows.success);
    return rows.data.map((row) => row.id);
  }

  async function seed(count: number) {
    for (let index = 0; index < count; index += 1) {
      const row = createMuxMessage(`u${index}`, "user", `row ${index}`);
      expect((await fixture.historyService.appendToHistory(workspaceId, row)).success).toBe(true);
    }
  }

  it("refuses the append after a row above the stamp and admits it at the stamp", async () => {
    await seed(3);
    const tail = await tailSequence();

    const refused = await appendWithMax(createMuxMessage("w1", "user", "warning"), {
      maxHistorySequence: tail - 1,
    });
    expect(refused.success && refused.data.kind).toBe("skipped");
    expect(await ids()).toEqual(["u0", "u1", "u2"]);

    const accepted = await appendWithMax(createMuxMessage("w2", "user", "warning"), {
      maxHistorySequence: tail,
    });
    expect(accepted.success && accepted.data.kind).toBe("accepted");
    expect(await ids()).toEqual(["u0", "u1", "u2", "w2"]);
  });

  it("decides from the newest rows without reading the archive", async () => {
    await seed(2);
    const tail = await tailSequence();
    // An archived row above every active row cannot exist (archived rows are older). Only a scan
    // that goes past the newest active rows sees it.
    const dir = path.join(fixture.config.sessionsDir, workspaceId);
    const [line] = (await fs.readFile(path.join(dir, "chat.jsonl"), "utf8")).split("\n");
    const archived = JSON.parse(line) as MuxMessage;
    archived.id = "archived";
    archived.metadata = { ...archived.metadata, historySequence: tail + 100 };
    await fs.writeFile(path.join(dir, "chat-archive.jsonl"), `${JSON.stringify(archived)}\n`);

    const accepted = await appendWithMax(createMuxMessage("w1", "user", "warning"), {
      maxHistorySequence: tail,
    });
    expect(accepted.success && accepted.data.kind).toBe("accepted");
  });

  // Rewrites one persisted row of chat.jsonl, as a corrupted or hand-edited file would have it.
  async function rewriteRow(id: string, edit: (row: MuxMessage) => void) {
    const file = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    const rewritten = lines.map((line) => {
      if (line.length === 0) return line;
      const row = JSON.parse(line) as MuxMessage;
      if (row.id !== id) return line;
      edit(row);
      return JSON.stringify(row);
    });
    await fs.writeFile(file, rewritten.join("\n"));
  }

  it("fails closed when the deciding rows are out of order", async () => {
    await seed(3);
    const tail = await tailSequence();
    // Every sequence stays at or below the stamp, but u1 now claims a later sequence than u2.
    await rewriteRow("u1", (row) => {
      row.metadata = { ...row.metadata, historySequence: tail + 10 };
    });
    const refused = await appendWithMax(createMuxMessage("w1", "user", "warning"), {
      maxHistorySequence: tail + 10,
    });
    expect(refused.success && refused.data.kind).toBe("skipped");
  });

  it("decides after the first chunk of a large active file", async () => {
    // u0 fills more than one backward-read chunk (256 KiB), so the newest chunk holds u1 and u2
    // but not all of u0. u0 then claims an impossible later sequence: only a scan past the
    // first chunk sees it.
    const big = createMuxMessage("u0", "user", "x".repeat(400 * 1024));
    expect((await fixture.historyService.appendToHistory(workspaceId, big)).success).toBe(true);
    for (const id of ["u1", "u2"]) {
      const row = createMuxMessage(id, "user", id);
      expect((await fixture.historyService.appendToHistory(workspaceId, row)).success).toBe(true);
    }
    const tail = await tailSequence();
    await rewriteRow("u0", (row) => {
      row.metadata = { ...row.metadata, historySequence: tail + 100 };
    });
    const accepted = await appendWithMax(createMuxMessage("w1", "user", "warning"), {
      maxHistorySequence: tail,
    });
    expect(accepted.success && accepted.data.kind).toBe("accepted");
  });
});
