import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { computeSendDigest, decideSendIdsFromHistory, type SendIdentity } from "./sendIds";

const CHUNK = 1024 * 1024;

function rowLine(messageId: string, text: string, sendId: string): string {
  return JSON.stringify({
    ...createMuxMessage(messageId, "user", text),
    metadata: {
      sendIds: [sendId],
      sendDigests: { [sendId]: computeSendDigest({ message: text }) },
    },
  });
}

function identity(id: string, text: string): SendIdentity {
  return { id, digest: computeSendDigest({ message: text }) };
}

describe("decideSendIdsFromHistory", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "send-ids-"));
    file = path.join(dir, "chat.jsonl");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("finds a row whose line straddles the read chunk boundary", async () => {
    // The row starts just before the 1 MiB chunk boundary, so its line arrives in two pieces.
    const padding = JSON.stringify(createMuxMessage("pad", "user", "p".repeat(CHUNK - 120)));
    await fs.writeFile(file, `${padding}\n${rowLine("u1", "hello", "send-a")}\n`);
    expect(await decideSendIdsFromHistory([file], [identity("send-a", "hello")])).toEqual({
      kind: "already-accepted",
    });
    expect(await decideSendIdsFromHistory([file], [identity("send-b", "hello")])).toEqual({
      kind: "append",
    });
  });

  it("a line over the parse limit is searched to its end: naming the id makes it unverified", async () => {
    const big = rowLine("u1", "z".repeat(3 * CHUNK), "send-a");
    // Over the limit: searched only, in pieces (the id sits at the end of a 3 MiB line).
    await fs.writeFile(file, `${big}\n${rowLine("u2", "after", "send-c")}\n`);
    expect(await decideSendIdsFromHistory([file], [identity("send-a", "x")], 1024)).toEqual({
      kind: "refused",
      reason: "unverified",
    });
    expect(await decideSendIdsFromHistory([file], [identity("send-b", "x")], 1024)).toEqual({
      kind: "append",
    });
    // The line after the over-long one is parsed normally.
    expect(await decideSendIdsFromHistory([file], [identity("send-c", "after")], 1024)).toEqual({
      kind: "already-accepted",
    });
    // Within the limit the same line proves its send.
    expect(
      await decideSendIdsFromHistory([file], [identity("send-a", "z".repeat(3 * CHUNK))])
    ).toEqual({ kind: "already-accepted" });
  });

  it("an over-long line is searched across chunk boundaries: an id split by one is still found", async () => {
    // The quoted id starts 3 bytes before the 1 MiB boundary, so each read holds only part of it.
    await fs.writeFile(file, `${"x".repeat(CHUNK - 3)}"send-a"${"x".repeat(100)}\n`);
    expect(await decideSendIdsFromHistory([file], [identity("send-a", "x")], 1024)).toEqual({
      kind: "refused",
      reason: "unverified",
    });
  });

  it("a last line without its newline is judged like any line; missing files are empty", async () => {
    await fs.writeFile(file, rowLine("u1", "hello", "send-a"));
    expect(
      await decideSendIdsFromHistory(
        [path.join(dir, "missing.jsonl"), file],
        [identity("send-a", "hello")]
      )
    ).toEqual({ kind: "already-accepted" });
    await fs.writeFile(file, rowLine("u1", "hello", "send-a").slice(0, -5));
    expect(await decideSendIdsFromHistory([file], [identity("send-a", "hello")])).toEqual({
      kind: "refused",
      reason: "unverified",
    });
  });
});

describe("computeSendDigest", () => {
  it("ignores what a retry may change, keeps what describes the input", () => {
    const base = { message: "hi", muxMetadata: { type: "normal", requestedModel: "a:1" } };
    expect(computeSendDigest(base)).toBe(
      computeSendDigest({
        message: "hi",
        muxMetadata: {
          requestedModel: "b:2",
          type: "normal",
          acpPromptId: "p2",
          acpDelegatedTools: ["x"],
        },
      })
    );
    expect(computeSendDigest(base)).not.toBe(
      computeSendDigest({ ...base, muxMetadata: { type: "compaction-request" } })
    );
    expect(computeSendDigest(base)).not.toBe(computeSendDigest({ ...base, editMessageId: "m1" }));
    expect(computeSendDigest(base)).not.toBe(
      computeSendDigest({
        ...base,
        fileParts: [{ url: "data:,x", mediaType: "text/plain", filename: "x.txt" }],
      })
    );
  });
});
