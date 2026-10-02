import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsPromises from "fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeSendDigest,
  decideSendIdPublication,
  WorkspaceSendIdIndex,
  type SendIdEvidence,
} from "./sendIdIndex";

function row(id: string, sendIds?: string[], digest = "d"): string {
  return JSON.stringify({
    id,
    role: "user",
    parts: [{ type: "text", text: `text of ${id}` }],
    metadata: {
      historySequence: 1,
      ...(sendIds != null
        ? { sendIds, sendDigests: Object.fromEntries(sendIds.map((sid) => [sid, digest])) }
        : {}),
    },
  });
}

describe("WorkspaceSendIdIndex", () => {
  let dir: string;
  let paths: { chat: string; archive: string };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "send-id-index-"));
    paths = { chat: path.join(dir, "chat.jsonl"), archive: path.join(dir, "chat-archive.jsonl") };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("extends by reading only appended bytes and rebuilds after a truncation or rewrite", async () => {
    await fs.writeFile(paths.chat, `${row("a", ["s1"])}\n`);
    const index = new WorkspaceSendIdIndex();
    await index.refresh(paths);
    expect(index.evidence("s1")).toEqual({ kind: "row", digest: "d" });

    const reads: number[] = [];
    const open = fsPromises.open;
    const spy = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      spyOn(handle, "read").mockImplementation(((
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => {
        reads.push(position);
        return read(buffer, offset, length, position);
      }) as typeof handle.read);
      return handle;
    });
    try {
      const before = (await fs.stat(paths.chat)).size;
      await fs.appendFile(paths.chat, `${row("b", ["s2"])}\n`);
      await index.refresh(paths);
      expect(index.evidence("s2")).toEqual({ kind: "row", digest: "d" });
      // Nothing before the indexed offset is re-read, except the short tail check.
      expect(reads.length).toBeGreaterThan(0);
      expect(Math.min(...reads)).toBeGreaterThanOrEqual(before - 64);
      expect(index.rebuildCount).toBe(0);

      // Truncate in place to the first row: the shrink rebuilds and forgets s2.
      await fs.truncate(paths.chat, before);
      await index.refresh(paths);
      expect(index.rebuildCount).toBe(1);
      expect(index.evidence("s2")).toBeUndefined();
      expect(index.evidence("s1")).toEqual({ kind: "row", digest: "d" });

      // Same size, different bytes before the offset (an atomic rewrite to equal length).
      const replaced = `${row("a", ["s9"])}\n`;
      expect(Buffer.byteLength(replaced)).toBe(before);
      await fs.writeFile(`${paths.chat}.tmp`, replaced);
      await fs.rename(`${paths.chat}.tmp`, paths.chat);
      await index.refresh(paths);
      expect(index.rebuildCount).toBe(2);
      expect(index.evidence("s1")).toBeUndefined();
      expect(index.evidence("s9")).toEqual({ kind: "row", digest: "d" });
    } finally {
      spy.mockRestore();
    }
  });

  it("matches an unreadable line by the raw id string, and ignores sendIds inside client metadata", async () => {
    await fs.writeFile(
      paths.chat,
      [
        '{"id":"torn","metadata":{"sendIds":["s1","s2"',
        JSON.stringify({
          id: "c",
          role: "user",
          parts: [{ type: "text", text: "c" }],
          metadata: { muxMetadata: { sendIds: ["s3"] } },
        }),
        // Parses, but readers drop it (no parts): its id blocks without proving acceptance.
        JSON.stringify({ id: "bad", role: "user", metadata: { sendIds: ["s5"] } }),
        // A trailing fragment without a newline is read but never indexed past.
        `${row("x", ["s4"]).slice(0, 40)}`,
      ].join("\n")
    );
    const index = new WorkspaceSendIdIndex();
    await index.refresh(paths);
    const evidence = (id: string): SendIdEvidence | undefined => index.evidence(id);
    expect(evidence("s1")).toEqual({ kind: "unreadable" });
    expect(evidence("s2")).toEqual({ kind: "unreadable" });
    expect(evidence("s")).toBeUndefined();
    expect(evidence("s3")).toBeUndefined();
    expect(evidence("s5")).toEqual({ kind: "unreadable" });
    // The fragment completes on a later write and is then indexed.
    await fs.appendFile(paths.chat, `${row("x", ["s4"]).slice(40)}\n`);
    await index.refresh(paths);
    expect(evidence("s4")).toEqual({ kind: "row", digest: "d" });
  });

  it("a complete line longer than the fragment cap is still indexed", async () => {
    const huge = JSON.stringify({
      id: "h",
      role: "user",
      parts: [{ type: "text", text: "y".repeat(3 * 1024 * 1024) }],
      metadata: { sendIds: ["s-huge"], sendDigests: { "s-huge": "d" } },
    });
    await fs.writeFile(paths.chat, `${huge}\n${row("after", ["s-after"])}\n`);
    const index = new WorkspaceSendIdIndex();
    await index.refresh(paths);
    expect(index.evidence("s-huge")).toEqual({ kind: "row", digest: "d" });
    expect(index.evidence("s-after")).toEqual({ kind: "row", digest: "d" });
  });

  it("a torn tail is not re-read until the file grows, and an oversized one is not indexed", async () => {
    const big = `{"id":"x","metadata":{"sendIds":["s-big"]},"pad":"${"x".repeat(1024 * 1024)}`;
    await fs.writeFile(paths.chat, `${row("a", ["s1"])}\n${big}`);
    const index = new WorkspaceSendIdIndex();
    await index.refresh(paths);
    expect(index.evidence("s1")).toEqual({ kind: "row", digest: "d" });
    expect(index.evidence("s-big")).toBeUndefined();
    const reads: number[] = [];
    const open = fsPromises.open;
    const spy = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      spyOn(handle, "read").mockImplementation(((
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => {
        reads.push(length);
        return read(buffer, offset, length, position);
      }) as typeof handle.read);
      return handle;
    });
    try {
      await index.refresh(paths);
      // Only the short tail check of the live file; the torn megabyte is not read again.
      expect(reads.every((length) => length <= 64)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("50k rows: one build, then each refresh reads only the new bytes", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) {
      lines.push(i % 2 === 0 ? row(`r${i}`, [`s${i}`]) : row(`r${i}`));
    }
    await fs.writeFile(paths.archive, `${lines.slice(0, 40_000).join("\n")}\n`);
    await fs.writeFile(paths.chat, `${lines.slice(40_000).join("\n")}\n`);
    const index = new WorkspaceSendIdIndex();
    let started = performance.now();
    await index.refresh(paths);
    const buildMs = performance.now() - started;
    expect(index.evidence("s0")).toEqual({ kind: "row", digest: "d" });
    expect(index.evidence("s49998")).toEqual({ kind: "row", digest: "d" });
    expect(index.evidence("s49999")).toBeUndefined();

    await fs.appendFile(paths.chat, `${row("new", ["s-new"])}\n`);
    started = performance.now();
    await index.refresh(paths);
    const extendMs = performance.now() - started;
    expect(index.evidence("s-new")).toEqual({ kind: "row", digest: "d" });
    // Recorded in the PR; the bounds only catch a regression to rescanning (CI is slow).
    console.log(
      `send id index, 50k rows (${Math.round(lines.join("\n").length / 1e6)} MB): build ${buildMs.toFixed(0)} ms, extend ${extendMs.toFixed(1)} ms`
    );
    expect(buildMs).toBeLessThan(10_000);
    expect(extendMs).toBeLessThan(Math.max(50, buildMs / 10));
  });
});

describe("decideSendIdPublication", () => {
  const evidence: Record<string, SendIdEvidence> = {
    same: { kind: "row", digest: "d1" },
    other: { kind: "row", digest: "zz" },
    blank: { kind: "row", digest: undefined },
    torn: { kind: "unreadable" },
  };
  const of = (id: string) => evidence[id];
  const id = (name: string) => ({ id: name, digest: "d1" });

  it("refuses when nothing is left to append and any known id disagrees or proves nothing", () => {
    expect(decideSendIdPublication([id("same")], of, true)).toEqual({ kind: "already-accepted" });
    expect(decideSendIdPublication([id("same"), id("other")], of, true)).toEqual({
      kind: "conflict",
      ids: ["other"],
    });
    expect(decideSendIdPublication([id("blank")], of, true)).toEqual({
      kind: "unverified",
      ids: ["blank"],
    });
    expect(decideSendIdPublication([id("torn"), id("same")], of, true)).toEqual({
      kind: "unverified",
      ids: ["torn"],
    });
  });

  it("a batch skips only ids proven by a same-payload row; any other known id refuses it", () => {
    expect(decideSendIdPublication([id("same"), id("new")], of, true)).toEqual({
      kind: "append-filtered",
      keep: [id("new")],
      skipped: ["same"],
    });
    expect(decideSendIdPublication([id("same"), id("new")], of, false)).toEqual({
      kind: "partial-refused",
      known: ["same"],
    });
    expect(decideSendIdPublication([id("other"), id("new")], of, true)).toEqual({
      kind: "conflict",
      ids: ["other"],
    });
    expect(decideSendIdPublication([id("torn"), id("new")], of, true)).toEqual({
      kind: "unverified",
      ids: ["torn"],
    });
  });
});

describe("computeSendDigest", () => {
  it("is independent of metadata key order and distinguishes the edit target", () => {
    const base = { message: "hi", fileParts: [{ url: "data:x", mediaType: "text/plain" }] };
    expect(computeSendDigest({ ...base, muxMetadata: { a: 1, b: [1, { c: 2, d: 3 }] } })).toBe(
      computeSendDigest({ ...base, muxMetadata: { b: [1, { d: 3, c: 2 }], a: 1 } })
    );
    expect(computeSendDigest({ ...base, editMessageId: "m1" })).not.toBe(computeSendDigest(base));
    // A retry under a new ACP prompt re-correlates its metadata mirror: same payload.
    expect(
      computeSendDigest({ ...base, muxMetadata: { acpPromptId: "p1", acpDelegatedTools: ["a"] } })
    ).toBe(computeSendDigest({ ...base, muxMetadata: { acpPromptId: "p2" } }));
  });
});
