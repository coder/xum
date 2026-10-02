import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { HistoryService } from "./historyService";
import { computeSendDigest, type SendIdDecision, type SendIdentity } from "./sendIdIndex";
import { createTestHistoryService } from "./testHistoryService";

/**
 * The in-lock send id check of HistoryService.acceptCompactionReplacement (idempotent sends,
 * formal/composer-drafts ComposerSends.tla): a row on disk is the only acceptance evidence, so
 * no second row is ever appended for an id a row already carries -- across services sharing one
 * session dir, across rotation into the archive, and for an unreadable line holding the id.
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
    identities: SendIdentity[],
    rebuild?: (keep: readonly SendIdentity[]) => MuxMessage["parts"] | undefined
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
          ...(rebuild != null ? { rebuild } : {}),
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

  it("a second service on the same session dir finds the first one's row: already accepted, no second row", async () => {
    const first = fixture.historyService;
    const second = new HistoryService(fixture.config);
    const sent = identity("send-a", "hello");
    expect(await publish(first, createMuxMessage("u1", "user", "hello"), [sent])).toEqual({
      kind: "accepted",
      decision: { kind: "append" },
    });
    expect(await publish(second, createMuxMessage("u2", "user", "hello"), [sent])).toEqual({
      kind: "skipped",
      decision: { kind: "already-accepted" },
    });
    // And back again: the first service extends its index with nothing new.
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
    ).toEqual({ kind: "skipped", decision: { kind: "conflict", ids: ["send-a"] } });
    expect(await userRows()).toEqual([{ text: "one", sendIds: ["send-a"] }]);
  });

  it("an unreadable line that holds the id blocks a second append without proving its payload", async () => {
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("prior", "user", "before")
    );
    // A torn row: its JSON never closes, but the raw id string is on disk.
    await fs.appendFile(chatPath, '{"id":"torn","role":"user","metadata":{"sendIds":["send-a"\n');
    expect(
      await publish(fixture.historyService, createMuxMessage("u2", "user", "hello"), [
        identity("send-a", "hello"),
      ])
    ).toEqual({ kind: "skipped", decision: { kind: "unverified", ids: ["send-a"] } });
    // An id the torn line does not contain is unaffected.
    expect(
      (
        await publish(fixture.historyService, createMuxMessage("u3", "user", "other"), [
          identity("send-b", "other"),
        ])
      ).decision
    ).toEqual({ kind: "append" });
  });

  it("a batch skips the ids a row already carries and is rebuilt from the remaining adds; without a rebuild it is refused", async () => {
    await publish(fixture.historyService, createMuxMessage("u1", "user", "first"), [
      identity("send-a", "first"),
    ]);
    const batch = [identity("send-a", "first"), identity("send-b", "second")];
    expect(
      await publish(fixture.historyService, createMuxMessage("u2", "user", "first\nsecond"), batch)
    ).toEqual({ kind: "skipped", decision: { kind: "partial-refused", known: ["send-a"] } });
    const kept: string[][] = [];
    const rebuilt = createMuxMessage("u3", "user", "first\nsecond");
    expect(
      await publish(fixture.historyService, rebuilt, batch, (keep) => {
        kept.push(keep.map((entry) => entry.id));
        return createMuxMessage("u3", "user", "second").parts;
      })
    ).toEqual({
      kind: "accepted",
      decision: { kind: "append-filtered", keep: [batch[1]], skipped: ["send-a"] },
    });
    expect(kept).toEqual([["send-b"]]);
    // The caller's message reflects what was published.
    expect(rebuilt.metadata?.sendIds).toEqual(["send-b"]);
    expect(rebuilt.parts).toEqual(createMuxMessage("u3", "user", "second").parts);
    expect(await userRows()).toEqual([
      { text: "first", sendIds: ["send-a"] },
      { text: "second", sendIds: ["send-b"] },
    ]);
  });

  it("rows rotated into the archive still block, and the live index rebuilds after the rewrite", async () => {
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
    expect(
      (await publish(fixture.historyService, createMuxMessage("u2", "user", "hello"), [sent]))
        .decision
    ).toEqual({ kind: "already-accepted" });
    // A fresh service builds from both files.
    expect(
      (
        await publish(new HistoryService(fixture.config), createMuxMessage("u3", "user", "hello"), [
          sent,
        ])
      ).decision
    ).toEqual({ kind: "already-accepted" });
  });

  it("truncation drops the evidence: the index rebuilds instead of remembering a removed row", async () => {
    const sent = identity("send-a", "hello");
    await publish(fixture.historyService, createMuxMessage("u1", "user", "hello"), [sent]);
    expect(await fixture.historyService.clearHistory(workspaceId)).toMatchObject({ success: true });
    expect(
      (await publish(fixture.historyService, createMuxMessage("u2", "user", "hello"), [sent]))
        .decision
    ).toEqual({ kind: "append" });
  });

  it("resolveSendIds decides under the lock with what every row says", async () => {
    await publish(fixture.historyService, createMuxMessage("u1", "user", "hello"), [
      identity("send-a", "hello"),
    ]);
    const answer = await new HistoryService(fixture.config).resolveSendIds(
      workspaceId,
      (evidenceOf) => [evidenceOf("send-a"), evidenceOf("send-b")]
    );
    expect(answer).toEqual(
      Ok([{ kind: "row", digest: identity("send-a", "hello").digest }, undefined])
    );
  });
});
