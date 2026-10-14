import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { HistoryService } from "./historyService";
import { computeSendDigest, type SendIdDecision, type SendIdentity } from "./sendIds";
import { createTestHistoryService } from "./testHistoryService";

/**
 * The in-lock send id check of HistoryService.acceptCompactionReplacement (idempotent sends):
 * a row on disk is the only acceptance evidence, read fresh under the write lock, so no second
 * row is ever appended for an id a row already carries -- across services sharing one session
 * dir, across rotation into the archive, and for a line the history readers drop.
 */
const workspaceId = "send-ids";

function identity(id: string, text: string): SendIdentity {
  return { id, digest: computeSendDigest({ message: text }) };
}

describe("send id check under the history write lock", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  let chatPath: string;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
    chatPath = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  async function publish(
    history: HistoryService,
    message: MuxMessage,
    identities: SendIdentity[]
  ): Promise<{ kind: string; decision: SendIdDecision | undefined }> {
    const capture = await history.captureCompactionReplacement(workspaceId);
    assert(capture.success);
    let decision: SendIdDecision | undefined;
    const result = await history.acceptCompactionReplacement(
      workspaceId,
      capture.data,
      { kind: "append", messages: [message] },
      {
        isCurrent: () => true,
        onCommitted: () => undefined,
        sendIds: {
          identities,
          onDecision: (made) => {
            decision = made;
          },
        },
      }
    );
    assert(result.success);
    return { kind: result.data.kind, decision };
  }

  async function userRows(history: HistoryService = fixture.historyService) {
    const rows = await history.getHistoryFromLatestBoundary(workspaceId);
    assert(rows.success);
    return rows.data
      .filter((row) => row.role === "user")
      .map((row) => ({
        text: row.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        sendIds: row.metadata?.sendIds,
      }));
  }

  async function appendRawLine(line: string): Promise<void> {
    await fs.mkdir(path.dirname(chatPath), { recursive: true });
    await fs.appendFile(chatPath, `${line}\n`);
  }

  it("a second service on the same session dir finds the first one's row: already accepted, no second row", async () => {
    const first = fixture.historyService;
    const second = new HistoryService(fixture.config);
    const sent = identity("send-a", "hello");
    const published = createMuxMessage("u1", "user", "hello");
    expect(await publish(first, published, [sent])).toEqual({
      kind: "accepted",
      decision: { kind: "append" },
    });
    // The caller's message carries what was stamped.
    expect(published.metadata?.sendIds).toEqual(["send-a"]);
    expect(await publish(second, createMuxMessage("u2", "user", "hello"), [sent])).toEqual({
      kind: "skipped",
      decision: { kind: "already-accepted" },
    });
    // And back again: nothing is cached, the first service reads the same row.
    expect(
      (await publish(first, createMuxMessage("u3", "user", "hello"), [sent])).decision
    ).toEqual({ kind: "already-accepted" });
    expect(await userRows(second)).toEqual([{ text: "hello", sendIds: ["send-a"] }]);
  });

  it("the same id with a different payload is a conflict: refused, no row", async () => {
    await publish(fixture.historyService, createMuxMessage("u1", "user", "one"), [
      identity("send-a", "one"),
    ]);
    expect(
      await publish(fixture.historyService, createMuxMessage("u2", "user", "two"), [
        identity("send-a", "two"),
      ])
    ).toEqual({ kind: "skipped", decision: { kind: "refused", reason: "conflict" } });
    expect(await userRows()).toEqual([{ text: "one", sendIds: ["send-a"] }]);
  });

  it("a line the readers drop or a row without the id's digest blocks a second append without proving it", async () => {
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("prior", "user", "before")
    );
    const refusedFor = async (id: string) =>
      (
        await publish(fixture.historyService, createMuxMessage(`u-${id}`, "user", "hello"), [
          identity(id, "hello"),
        ])
      ).decision;
    // A torn row: its JSON never closes, but the quoted id is on disk.
    await appendRawLine('{"id":"torn","role":"user","metadata":{"sendIds":["send-torn"]');
    // Parses, but is no readable message (no parts): the readers drop it.
    await appendRawLine(
      JSON.stringify({ id: "noparts", role: "user", metadata: { sendIds: ["send-noparts"] } })
    );
    // Readable, but no digest for its id.
    await appendRawLine(
      JSON.stringify({
        ...createMuxMessage("nodigest", "user", "x"),
        metadata: { sendIds: ["send-nodigest"] },
      })
    );
    for (const id of ["send-torn", "send-noparts", "send-nodigest"]) {
      expect(await refusedFor(id)).toEqual({ kind: "refused", reason: "unverified" });
    }
    // An id no line names is unaffected.
    expect(await refusedFor("send-other")).toEqual({ kind: "append" });
    expect((await userRows()).map((row) => row.text)).toEqual(["before", "x", "hello"]);
  });

  it("a row longer than the session_history line limit (a large paste) still proves its send", async () => {
    const text = "y".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 10);
    const sent = identity("send-big", text);
    expect(
      (await publish(fixture.historyService, createMuxMessage("u1", "user", text), [sent])).decision
    ).toEqual({ kind: "append" });
    expect(
      (await publish(fixture.historyService, createMuxMessage("u2", "user", text), [sent])).decision
    ).toEqual({ kind: "already-accepted" });
  });

  it("an id that appears only in message text or client metadata is not evidence", async () => {
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("quoted", "user", 'please resend "send-a"', {
        muxMetadata: { type: "normal", note: "send-a", sendIds: ["send-a"] },
      } as never)
    );
    expect(
      (
        await publish(fixture.historyService, createMuxMessage("u1", "user", "hello"), [
          identity("send-a", "hello"),
        ])
      ).decision
    ).toEqual({ kind: "append" });
  });

  it("a batch only partly on rows is refused whole; a fully known batch adds nothing; one id twice is refused", async () => {
    await publish(fixture.historyService, createMuxMessage("u1", "user", "first"), [
      identity("send-a", "first"),
    ]);
    const batch = [identity("send-a", "first"), identity("send-b", "second")];
    expect(
      await publish(fixture.historyService, createMuxMessage("u2", "user", "first\nsecond"), batch)
    ).toEqual({ kind: "skipped", decision: { kind: "refused", reason: "partly-accepted" } });
    expect(
      await publish(fixture.historyService, createMuxMessage("u3", "user", "second\nsecond"), [
        identity("send-b", "second"),
        identity("send-b", "second"),
      ])
    ).toEqual({ kind: "skipped", decision: { kind: "refused", reason: "repeated" } });
    await publish(fixture.historyService, createMuxMessage("u4", "user", "second"), [batch[1]]);
    expect(
      (
        await publish(
          fixture.historyService,
          createMuxMessage("u5", "user", "first\nsecond"),
          batch
        )
      ).decision
    ).toEqual({ kind: "already-accepted" });
    expect(await userRows()).toEqual([
      { text: "first", sendIds: ["send-a"] },
      { text: "second", sendIds: ["send-b"] },
    ]);
  });

  it("ids named like Object.prototype members read only the row's own digests", async () => {
    for (const id of ["__proto__", "constructor"]) {
      const sent = identity(id, `text ${id}`);
      expect(
        (
          await publish(fixture.historyService, createMuxMessage(`u-${id}`, "user", `text ${id}`), [
            sent,
          ])
        ).decision
      ).toEqual({ kind: "append" });
      expect(
        (
          await publish(fixture.historyService, createMuxMessage(`r-${id}`, "user", `text ${id}`), [
            sent,
          ])
        ).decision
      ).toEqual({ kind: "already-accepted" });
    }
  });

  it("rows rotated into the archive still block, for a fresh service too", async () => {
    const sent = identity("send-a", "hello");
    await publish(fixture.historyService, createMuxMessage("u1", "user", "hello"), [sent]);
    // A compaction boundary rotates the earlier rows into chat-archive.jsonl and rewrites chat.jsonl.
    const boundary = createMuxMessage("summary", "assistant", "summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      muxMetadata: { type: "compaction-summary" },
    });
    expect(await fixture.historyService.appendToHistory(workspaceId, boundary)).toEqual(
      Ok(undefined)
    );
    expect(
      await fixture.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("after", "user", "x")
      )
    ).toEqual(Ok(undefined));
    const archive = await fs.readFile(
      path.join(fixture.config.sessionsDir, workspaceId, "chat-archive.jsonl"),
      "utf8"
    );
    expect(archive).toContain('"send-a"');
    expect(await fs.readFile(chatPath, "utf8")).not.toContain('"send-a"');
    for (const history of [fixture.historyService, new HistoryService(fixture.config)]) {
      expect(
        (await publish(history, createMuxMessage("u2", "user", "hello"), [sent])).decision
      ).toEqual({ kind: "already-accepted" });
    }
  });

  it("clearing history drops the evidence", async () => {
    const sent = identity("send-a", "hello");
    await publish(fixture.historyService, createMuxMessage("u1", "user", "hello"), [sent]);
    expect(await fixture.historyService.clearHistory(workspaceId)).toMatchObject({ success: true });
    expect(
      (await publish(fixture.historyService, createMuxMessage("u2", "user", "hello"), [sent]))
        .decision
    ).toEqual({ kind: "append" });
  });

  it("decideSendIds answers from every row, for another service too", async () => {
    await publish(fixture.historyService, createMuxMessage("u1", "user", "hello"), [
      identity("send-a", "hello"),
    ]);
    const other = new HistoryService(fixture.config);
    expect(await other.decideSendIds(workspaceId, [identity("send-a", "hello")])).toEqual(
      Ok({ kind: "already-accepted" })
    );
    expect(await other.decideSendIds(workspaceId, [identity("send-b", "hello")])).toEqual(
      Ok({ kind: "append" })
    );
  });
});
