import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import {
  SESSION_HISTORY_MAX_RESULT_BYTES,
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_MAX_SCAN_ROWS,
} from "@/common/constants/contextBudget";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";
import {
  createSessionHistoryTool,
  type SessionHistoryArgs,
  type SessionHistoryResult,
} from "./session_history";

let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
const workspaceId = "history-browser";
let chatPath: string;
let archivePath: string;
let call: (input: SessionHistoryArgs, workspace?: string) => Promise<SessionHistoryResult>;
async function append(
  id: string,
  text: string,
  metadata?: MuxMetadata,
  parts?: MuxMessage["parts"]
) {
  const message = createMuxMessage(id, "assistant", text, metadata, parts);
  expect((await fixture.historyService.appendToHistory(workspaceId, message)).success).toBe(true);
  return message;
}
async function pages(input: SessionHistoryArgs) {
  const results: SessionHistoryResult[] = [];
  let cursor: string | undefined;
  do {
    const result = await call({ ...input, cursor });
    expect(result.success).toBe(true);
    expect(result.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
    expect(result.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
    results.push(result);
    cursor = result.nextCursor;
    expect(results.length).toBeLessThan(40);
  } while (cursor);
  return results;
}
const rollover: MuxMetadata = {
  contextBoundaryKind: "reset",
  synthetic: true,
  muxMetadata: {
    type: "context-window-rollover",
    rolloverId: "roll",
    reason: "on-send",
    previousWindowId: "w:0",
    flushOpportunity: false,
    contextTokens: 5000,
    maxTokens: 6000,
  },
};

beforeEach(async () => {
  fixture = await createTestHistoryService();
  chatPath = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
  archivePath = path.join(fixture.config.sessionsDir, workspaceId, "chat-archive.jsonl");
  call = async (input, workspace = workspaceId) => {
    const config = createTestToolConfig(fixture.tempDir, { workspaceId: workspace });
    config.historyService = fixture.historyService;
    const tool = createSessionHistoryTool(config);
    return TOOL_DEFINITIONS.session_history.resultSchema.parse(
      await tool.execute!(input, mockToolCallOptions)
    );
  };
  await append("first", "opening facts");
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("session_history real disk recovery", () => {
  test("scanner fails closed when a reset races a page or a truncate is unresolved", async () => {
    expect(
      await fixture.historyService
        .scanHistoryBounded(workspaceId, {
          visit: () => {
            appendFileSync(
              chatPath,
              JSON.stringify(
                createMuxMessage("racing-reset", "assistant", "", { contextBoundaryKind: "reset" })
              ) + "\n"
            );
            return true;
          },
        })
        .then(
          () => null,
          (error: unknown) => error
        )
    ).toMatchObject({ message: "stale_cursor" });
    await fs.writeFile(`${archivePath}.truncate`, "pending transaction");
    expect((await call({ action: "search", query: "opening facts" })).error).toBe("stale_cursor");
  });

  test("bounded append validation advances across pages without exposing newly appended rows", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    const tail = Array.from({ length: 650 }, (_, i) =>
      createMuxMessage(`append-${i}`, "assistant", "match" + "z".repeat(4096))
    );
    await fs.appendFile(chatPath, tail.map((message) => JSON.stringify(message)).join("\n") + "\n");
    let cursor = first.nextCursor;
    const results: SessionHistoryResult[] = [];
    do {
      const page = await call({ action: "search", query: "match", limit: 1, cursor });
      expect(page.success).toBe(true);
      expect(page.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
      expect(page.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
      results.push(page);
      cursor = page.nextCursor;
      expect(results.length).toBeLessThan(10);
    } while (cursor);
    expect(results[0].items).toEqual([]);
    expect(results.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
      "match two",
    ]);
  });

  test("malformed lines do not hide surviving rows and a legacy reset still protects older IDs", async () => {
    await fs.appendFile(chatPath, "not-json\nnull\n");
    await fs.appendFile(
      chatPath,
      JSON.stringify(
        createMuxMessage("legacy-reset", "assistant", "", { contextBoundaryKind: "reset" })
      ) + "\n"
    );
    await fs.appendFile(
      chatPath,
      "broken-json\n" +
        JSON.stringify(createMuxMessage("after-legacy-reset", "assistant", "recoverable")) +
        "\n"
    );
    const result = await call({ action: "search", query: "recoverable" });
    expect(result.items?.[0]).toMatchObject({
      itemId: "m:after-legacy-reset",
      windowId: "w:m:legacy-reset",
    });
    expect(result.malformedLines).toBeGreaterThan(0);
    expect((await call({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  test.each([
    '{"id":"broken-reset","role":"assistant","metadata":{"contextBoundaryKind" : "reset"},"parts":[',
    '{"role":"assistant","metadata":{"contextBoundaryKind":"reset"},"parts":[]}',
  ])("unreadable reset rows below the size cap protect list/search/read: %s", async (resetLine) => {
    const olderWindow = await append("private-boundary", "private summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const hidden = await append("private-item", "private-before-malformed-reset");
    await fs.appendFile(chatPath, resetLine + "\n");
    const publicBoundary = createMuxMessage("public-boundary", "assistant", "", {
      ...rollover,
      historySequence: 100,
    });
    await fs.appendFile(
      chatPath,
      [
        JSON.stringify(publicBoundary),
        "unrelated malformed row",
        JSON.stringify(
          createMuxMessage("public-item", "assistant", "public facts", { historySequence: 101 })
        ),
      ].join("\n") + "\n"
    );
    const windows = (await pages({ action: "list_windows" })).flatMap((page) => page.windows ?? []);
    expect(windows.map((window) => window.windowId)).toEqual(["w:100"]);
    expect(
      windows.some(
        (window) => window.windowId === `w:${String(olderWindow.metadata!.historySequence)}`
      )
    ).toBe(false);
    expect(
      (await pages({ action: "search", query: "private" })).flatMap((page) => page.items ?? [])
    ).toEqual([]);
    expect(
      (await pages({ action: "read_item", item_id: String(hidden.metadata!.historySequence) })).at(
        -1
      )?.error
    ).toBe("item_not_found");
    expect(
      (await pages({ action: "search", query: "public facts" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["public facts"]);
  });

  test("an appended malformed reset invalidates an existing cursor", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    expect(first.nextCursor).toBeString();
    await fs.appendFile(chatPath, '{"metadata":{"contextBoundaryKind":"reset"},"parts":[\n');
    expect((await call({ action: "search", query: "match", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  test("lists root, sequenced compactions, heartbeat/rollover windows and legacy IDs", async () => {
    const compact = await append("compact", "summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const heartbeat = await append("heartbeat", "heartbeat summary", {
      compacted: "heartbeat",
      compactionBoundary: true,
      compactionEpoch: 2,
    });
    const roll = await append("roll", "", rollover);
    await append("recent", "recent facts");
    // Legacy imported rows predate historySequence; real disk fixture is needed
    // because appendToHistory correctly assigns a sequence to all new writes.
    const legacy = createMuxMessage("legacy-boundary", "assistant", "legacy summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 3,
    });
    await fs.appendFile(
      chatPath,
      JSON.stringify(legacy) +
        "\n" +
        JSON.stringify(createMuxMessage("legacy-item", "assistant", "legacy facts")) +
        "\n"
    );
    const windows = (await pages({ action: "list_windows", limit: 1 }))
      .flatMap((page) => page.windows ?? [])
      .map((window) => window.windowId);
    expect(windows).toEqual([
      "w:0",
      `w:${String(compact.metadata!.historySequence)}`,
      `w:${String(heartbeat.metadata!.historySequence)}`,
      `w:${String(roll.metadata!.historySequence)}`,
      "w:m:legacy-boundary",
    ]);
    expect((await call({ action: "read_item", item_id: "m:legacy-item" })).items?.[0]?.text).toBe(
      "legacy facts"
    );
    expect(
      (
        await call({
          action: "search",
          query: "facts",
          window_id: `w:${String(roll.metadata!.historySequence)}`,
        })
      ).items?.map((item) => item.text)
    ).toEqual(["recent facts"]);
  });

  test("plain manual reset is a privacy floor even for arbitrary IDs and multi-page floor discovery", async () => {
    const hidden = await append("hidden", "private-before-reset");
    await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
    const tail = Array.from({ length: 650 }, (_, i) =>
      createMuxMessage(`tail-${i}`, "assistant", `public-${i}`, { historySequence: 1000 + i })
    );
    await fs.appendFile(chatPath, tail.map((message) => JSON.stringify(message)).join("\n") + "\n");
    const first = await call({
      action: "read_item",
      item_id: String(hidden.metadata!.historySequence),
    });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeString();
    expect(first.exhausted).toBe(false);
    const all = await pages({ action: "search", query: "private-before-reset", window_id: "w:0" });
    expect(all.flatMap((page) => page.items ?? [])).toEqual([]);
    expect(all.at(-1)?.exhausted).toBe(true);
    expect(
      (await pages({ action: "read_item", item_id: String(hidden.metadata!.historySequence) })).at(
        -1
      )?.error
    ).toBe("item_not_found");
    const envelope = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()) as {
      data: string;
      signature: string;
    };
    const forged = JSON.parse(envelope.data) as {
      scan: { phase: string; artifact: string; byteOffset: number };
    };
    forged.scan.phase = "browse";
    forged.scan.artifact = "archive";
    forged.scan.byteOffset = 0;
    envelope.data = JSON.stringify(forged);
    expect(
      (
        await call({
          action: "read_item",
          item_id: String(hidden.metadata!.historySequence),
          cursor: Buffer.from(JSON.stringify(envelope)).toString("base64url"),
        })
      ).error
    ).toBe("invalid_cursor");
  });

  test("suppresses hidden synthetic requests, copied tails and reasoning; redacts media and nested history", async () => {
    await append("hidden", "private needle", { synthetic: true });
    await append("rejected", "private needle", { contextBudgetRejected: true });
    await append("copy", "private needle", { rlmPreservedTailCopy: true });
    await append("compact-request", "private needle", {
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    });
    await append("visible", "visible needle", { synthetic: true, uiVisible: true });
    const mixed = await append("mixed", "normal needle", undefined, [
      { type: "reasoning", text: "private needle" },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,private needle" },
      {
        type: "dynamic-tool",
        toolCallId: "ptc",
        toolName: "code_execution",
        state: "output-available",
        input: {},
        output: {
          nestedCalls: [
            { toolName: "session_history", output: "private needle" },
            { toolName: "attach_file", output: { type: "image", data: "private needle" } },
          ],
          stdout: "safe",
        },
      },
    ]);
    expect((await call({ action: "search", query: "private needle" })).items).toEqual([]);
    expect((await call({ action: "search", query: "NEEDLE" })).items?.length).toBe(2);
    const read = await call({
      action: "read_item",
      item_id: String(mixed.metadata!.historySequence),
    });
    expect(read.items?.[0]?.text).toContain("safe");
    expect(read.items?.[0]?.text).not.toContain("private needle");
  });

  test("search is literal, pages matches without duplicates, and read_item pages characters", async () => {
    const first = await append("literal", "A [x].* literal");
    await append("other", "another [X].* value");
    await append("regex-decoy", "xZZZ value");
    const all = (await pages({ action: "search", query: "[x].*", limit: 1 })).flatMap(
      (page) => page.items ?? []
    );
    expect(all.map((item) => item.text)).toEqual(["A [x].* literal", "another [X].* value"]);
    const read = await call({
      action: "read_item",
      item_id: String(first.metadata!.historySequence),
      offset_chars: 2,
      limit_chars: 5,
    });
    expect(read.items?.[0]?.text).toBe("[x].*");
    expect(read.items?.[0]?.nextCharOffset).toBe(7);
  });

  test("default read returns 8000 fitting ASCII characters and snake-case inputs resume the remainder", async () => {
    const text = "a".repeat(8000) + "remaining".repeat(250);
    const message = await append("paged-item", text);
    const first = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      window_id: null,
      offset_chars: null,
      limit_chars: null,
      cursor: null,
      limit: null,
    });
    expect(first.items?.[0]?.text).toBe(text.slice(0, 8000));
    expect(first.items?.[0]?.nextCharOffset).toBe(8000);
    expect(first.exhausted).toBe(true);
    expect(first.skipped_oversized_rows).toBe(0);
    const second = await call({
      action: "read_item",
      item_id: first.items![0].itemId,
      window_id: first.items![0].windowId,
      offset_chars: first.items![0].nextCharOffset,
    });
    expect(second.items?.[0]?.text).toBe(text.slice(8000));
    expect(second.items?.[0]?.nextCharOffset).toBeUndefined();
    expect(second.exhausted).toBe(true);
    expect(
      (
        await call({
          action: "read_item",
          item_id: first.items![0].itemId,
          window_id: "w:missing",
        })
      ).error
    ).toBe("item_not_found");
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
  });

  test("oversized rows consume bounded bytes and resume mid-line, then recover newer data", async () => {
    await fs.appendFile(
      chatPath,
      JSON.stringify(
        createMuxMessage("giant", "assistant", "", undefined, [
          {
            type: "dynamic-tool",
            toolCallId: "giant-tool",
            toolName: "bash",
            state: "output-available",
            input: {},
            output: { stdout: "x".repeat(5 * 1024 * 1024) },
          },
        ])
      ) + "\n"
    );
    await fs.appendFile(
      chatPath,
      JSON.stringify(createMuxMessage("after", "assistant", "recover me")) + "\n"
    );
    const all = await pages({ action: "search", query: "recover me" });
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.reduce((sum, page) => sum + page.skipped_oversized_rows, 0)).toBe(2);
    expect(all.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
      "recover me",
    ]);
    const size = (await fs.stat(chatPath)).size;
    expect(all.reduce((sum, page) => sum + (page.bytesRead ?? 0), 0)).toBeLessThan(
      size * 2 + 1024 * 1024 + 128 * 1024
    );
    expect(
      (await pages({ action: "search", query: "opening facts" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["opening facts"]);
  });

  test("oversized reset markers are a privacy floor, regardless of nested rollover metadata", async () => {
    const reset = createMuxMessage("oversized-reset", "assistant", "x".repeat(5 * 1024 * 1024), {
      contextBoundaryKind: "reset",
      muxMetadata: rollover.muxMetadata,
    });
    const raw = JSON.stringify(reset).replace(
      '"contextBoundaryKind":"reset"',
      '"contextBoundaryKind"' + " ".repeat(3 * 1024 * 1024) + '\t:  "reset"'
    );
    await fs.appendFile(
      chatPath,
      raw +
        "\n" +
        JSON.stringify(createMuxMessage("new", "assistant", "public after oversized reset")) +
        "\n"
    );
    const hidden = await pages({ action: "read_item", item_id: "0" });
    expect(hidden.flatMap((page) => page.items ?? [])).toEqual([]);
    expect(hidden.at(-1)?.error).toBe("item_not_found");
    expect(
      (await pages({ action: "search", query: "public" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["public after oversized reset"]);
  });

  test("appending the tool's own result preserves a fixed cursor snapshot; rotation expires it", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    expect(first.nextCursor).toBeString();
    await append("tool-result", "", undefined, [
      {
        type: "dynamic-tool",
        toolCallId: "history",
        toolName: "session_history",
        state: "output-available",
        input: { action: "search" },
        output: first,
      },
    ]);
    const second = await call({
      action: "search",
      query: "match",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.success).toBe(true);
    expect(second.items?.[0]?.text).toBe("match two");
    expect(second.nextCursor).toBeUndefined();
    expect(second.exhausted).toBe(true);
    await append("roll", "", rollover);
    expect((await call({ action: "search", query: "match", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  test("cursor binds workspace, action and query and detects in-place anchor mutation", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    const cursor = first.nextCursor;
    expect(
      (await call({ action: "search", query: "match", cursor }, "other-workspace")).error
    ).toBe("invalid_cursor");
    expect((await call({ action: "list_windows", query: "match", cursor })).error).toBe(
      "invalid_cursor"
    );
    expect((await call({ action: "search", query: "other", cursor })).error).toBe("invalid_cursor");
    const handle = await fs.open(chatPath, "r+");
    try {
      await handle.write(Buffer.from("!"), 0, 1, 0);
    } finally {
      await handle.close();
    }
    expect((await call({ action: "search", query: "match", cursor })).error).toBe("stale_cursor");
  });

  test("appended manual reset invalidates an otherwise append-stable cursor", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    // Simulate a cross-process append without rotation: the reset must still
    // invalidate privacy, rather than relying on inode replacement as the gate.
    await fs.appendFile(
      chatPath,
      JSON.stringify(createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" })) +
        "\n"
    );
    expect((await call({ action: "search", query: "match", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  test("archive watermark deduplicates crash-replayed rows without content deduplication", async () => {
    await append("same-one", "identical content");
    await append("same-two", "identical content");
    const sealed = await fs.readFile(chatPath, "utf8");
    await append("boundary", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    await fs.writeFile(chatPath, sealed + (await fs.readFile(chatPath, "utf8")));
    expect((await fs.stat(archivePath)).size).toBeGreaterThan(0);
    expect(
      (await pages({ action: "search", query: "identical content" })).flatMap(
        (page) => page.items ?? []
      ).length
    ).toBe(2);
  });

  test("aggregate encoded result, cursor, Unicode, and markers fit the output budget", async () => {
    const text = '"\\\n\t界'.repeat(6000);
    const message = await append("big", text);
    const read = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      limit_chars: 16000,
    });
    expect(read.success).toBe(true);
    expect(read.items?.[0]?.nextCharOffset).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
    for (let i = 0; i < 30; i++) await append(`result-${i}`, `needle${text.slice(0, 600)}`);
    const all = await pages({ action: "search", query: "needle", limit: 25 });
    expect(all.flatMap((page) => page.items ?? []).length).toBe(30);
  });
});
