import {
  HistoryAppendProvenance,
  HISTORY_PROVENANCE_MAX_RECEIPT_BYTES,
} from "@/node/services/historyAppendProvenance";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import {
  historyWriteLockPath,
  workspaceRemovalTombstonePath,
} from "@/node/services/workspaceRemoval";
import type { TaskService } from "@/node/services/taskService";
import { createRolloverPrefix } from "@/node/services/contextWindowRollover";
import { hasRawResetMarker, type BoundedHistoryScanResult } from "@/node/services/historyScanner";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import {
  SESSION_HISTORY_MAX_RESULT_BYTES,
  SESSION_HISTORY_MAX_ID_CHARS,
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_MAX_SCAN_ROWS,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
  SESSION_HISTORY_ANCHOR_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_TOOL_DEADLINE_MS,
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
let restoreScanBudget: () => void;
const workspaceId = "history-browser";
let chatPath: string;
let archivePath: string;
let call: (input: SessionHistoryArgs, abortSignal?: AbortSignal) => Promise<SessionHistoryResult>;
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
// Malformed-row fixtures intentionally use the same cooperative append receipt
// contract as production while bypassing message-shape normalization only.
async function appendTrackedHistory(filePath: string, data: string | Buffer): Promise<void> {
  const store = new HistoryAppendProvenance(path.dirname(filePath));
  await using _lock = await acquireProcessFileLock({
    lockPath: historyWriteLockPath(fixture.config.rootDir, workspaceId),
    timeoutMs: 5000,
    label: "test history append",
  });
  await store.runMutation(() => store.appendChat(Buffer.isBuffer(data) ? data : Buffer.from(data)));
}

/**
 * One complete call. Asserts the result envelope: success (or read_item's clean
 * item_not_found), the 16 KiB cap, representable IDs and, unless the caller expects
 * more, that the read left nothing behind (has_more: false).
 */
async function complete(
  input: SessionHistoryArgs,
  options?: { hasMore?: boolean }
): Promise<SessionHistoryResult> {
  const result = await call(input);
  if (input.action === "read_item") {
    expect(result.has_more).toBeUndefined();
    if (result.error === "item_not_found")
      expect(result).toEqual({ success: false, error: "item_not_found" });
    else expect(result.success).toBe(true);
  } else {
    expect(result.success).toBe(true);
    expect(result.has_more).toBe(options?.hasMore ?? false);
  }
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    SESSION_HISTORY_MAX_RESULT_BYTES
  );
  for (const item of result.items ?? []) {
    expect(item.itemId.length).toBeLessThanOrEqual(SESSION_HISTORY_MAX_ID_CHARS);
    expect(item.windowId.length).toBeLessThanOrEqual(SESSION_HISTORY_MAX_ID_CHARS);
  }
  for (const window of result.windows ?? []) {
    expect(window.windowId.length).toBeLessThanOrEqual(SESSION_HISTORY_MAX_ID_CHARS);
  }
  return result;
}
const itemsOf = async (input: SessionHistoryArgs, options?: { hasMore?: boolean }) =>
  (await complete(input, options)).items ?? [];
const textsOf = async (input: SessionHistoryArgs, options?: { hasMore?: boolean }) =>
  (await itemsOf(input, options)).map((item) => item.text);
const windowsOf = async (input: SessionHistoryArgs, options?: { hasMore?: boolean }) =>
  (await complete(input, options)).windows ?? [];
const windowIdsOf = async (input: SessionHistoryArgs, options?: { hasMore?: boolean }) =>
  (await windowsOf(input, options)).map((window) => window.windowId);
const readError = async (item_id: string) =>
  (await complete({ action: "read_item", item_id })).error;
/** A tracked (cooperatively receipted) raw append, as another local writer would produce. */
const appendRawRows = (rows: Array<MuxMessage | string>) =>
  appendTrackedHistory(
    chatPath,
    rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n"
  );
/**
 * Enough small tracked rows that a read of this history needs several protected chunks under
 * the clamped test budget (SESSION_HISTORY_MAX_SCAN_ROWS rows per chunk), so between-chunk
 * hooks land on an intermediate chunk. Filler never matches the "facts"/"match" queries.
 */
const filler = (count = SESSION_HISTORY_MAX_SCAN_ROWS, prefix = "filler") =>
  Array.from({ length: count }, (_, index) =>
    createMuxMessage(`${prefix}-${index}`, "assistant", `${prefix} ${index}`)
  );
const seedFiller = (count?: number, prefix?: string) => appendRawRows(filler(count, prefix));
const manualReset = (id = "manual-reset") =>
  createMuxMessage(id, "assistant", "", { contextBoundaryKind: "reset" });
// Every scan the tool issues (auth or target), in order, and optional per-scan hooks. Hooks run
// UNDER both history locks: they may observe or advance the fake clock, never mutate history.
let scanned: string[];
let beforeScan: ((workspace: string) => void) | undefined;
let afterScan: ((workspace: string, page: BoundedHistoryScanResult) => void) | undefined;
/**
 * Between-chunk seam: run `hook(chunk)` after the `chunk`th protected chunk of a read by
 * `caller` has RELEASED its locks (own reads: the target lock is the outermost; descendant
 * reads: the caller lock wraps the nested target lock). Chunks that throw (an invalidated
 * baseline) are not counted, so numbering continues into a restarted attempt. Mutations
 * belong here, never inside the scan spy (it runs under both locks and would deadlock).
 */
function afterChunks(hook: (chunk: number) => Promise<unknown> | void, caller = workspaceId) {
  const real = fixture.historyService.withHistoryScanLocks.bind(fixture.historyService);
  const seam = { chunks: 0, restore: () => spy.mockRestore() };
  const spy = spyOn(fixture.historyService, "withHistoryScanLocks").mockImplementation(
    async (workspace, operation, abortSignal) => {
      const outcome = await real(workspace, operation, abortSignal);
      if (workspace === caller) await hook(++seam.chunks);
      return outcome;
    }
  );
  return seam;
}
/** `mutate` runs once, after intermediate chunk `chunk`; assert with `expectIntermediate`. */
function mutateBetweenChunks(
  mutate: () => Promise<unknown>,
  options?: { chunk?: number; caller?: string }
) {
  const target = options?.chunk ?? 1;
  let runs = 0;
  const seam = afterChunks(async (chunk) => {
    if (chunk !== target) return;
    runs++;
    await mutate();
  }, options?.caller);
  return {
    target,
    restore: seam.restore,
    get runs() {
      return runs;
    },
    get chunks() {
      return seam.chunks;
    },
  };
}
/** The hook ran exactly once, and a later chunk followed it (it was not the final chunk). */
function expectIntermediate(seam: ReturnType<typeof mutateBetweenChunks>) {
  expect(seam.runs).toBe(1);
  expect(seam.chunks).toBeGreaterThan(seam.target);
}
/**
 * "Direct and between-chunk" privacy checks: seed filler so the search needs several
 * chunks, run `mutate` after its first (intermediate) chunk, and return the single call's
 * texts. The restarted read must honor whatever `mutate` appended.
 */
async function searchInterleaved(query: string, mutate: () => Promise<unknown>) {
  await seedFiller(undefined, `interleaved-${query.length}`);
  const seam = mutateBetweenChunks(mutate);
  let texts: string[];
  try {
    texts = await textsOf({ action: "search", query });
  } finally {
    seam.restore();
  }
  expectIntermediate(seam);
  return texts;
}
/** Controllable performance.now() shared by the tool and the scanner. Restore in finally. */
function fakeClock(start = 0) {
  let now = start;
  const spy = spyOn(performance, "now").mockImplementation(() => now);
  return {
    set: (ms: number) => {
      now = ms;
    },
    restore: () => spy.mockRestore(),
  };
}
// Data-free error results: the notice tells the model how to recover, nothing else is present.
const TIMEOUT_RESULT = {
  success: false,
  error: "history_timeout",
  notice: expect.stringContaining("narrow") as string,
};
const CHANGED_RESULT = {
  success: false,
  error: "history_changed",
  notice: expect.stringContaining("retry") as string,
};
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
  scanned = [];
  beforeScan = undefined;
  afterScan = undefined;
  // Keep the privacy/race fixtures small while exercising the real scanner. Clamp the
  // shared object so descendant authorization still subtracts from the same chunk budget.
  // Production-budget acceptance lives in session_history.budget.test.ts.
  const scan = fixture.historyService.scanHistoryBoundedUnderLocks.bind(fixture.historyService);
  const budgetSpy = spyOn(
    fixture.historyService,
    "scanHistoryBoundedUnderLocks"
  ).mockImplementation(async (workspace, options) => {
    if (options.budget) {
      options.budget.maxBytes = Math.min(options.budget.maxBytes, SESSION_HISTORY_MAX_SCAN_BYTES);
      options.budget.maxRows = Math.min(options.budget.maxRows, SESSION_HISTORY_MAX_SCAN_ROWS);
    }
    scanned.push(workspace);
    beforeScan?.(workspace);
    const page = await scan(workspace, options);
    afterScan?.(workspace, page);
    return page;
  });
  restoreScanBudget = () => budgetSpy.mockRestore();
  chatPath = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
  archivePath = path.join(fixture.config.sessionsDir, workspaceId, "chat-archive.jsonl");
  call = async (input, abortSignal) => {
    const config = createTestToolConfig(fixture.tempDir, { workspaceId });
    config.historyService = fixture.historyService;
    const tool = createSessionHistoryTool(config);
    return TOOL_DEFINITIONS.session_history.resultSchema.parse(
      await tool.execute!(input, { ...mockToolCallOptions, abortSignal })
    );
  };
  await append("first", "opening facts");
});
afterEach(async () => {
  restoreScanBudget();
  await fixture.cleanup();
});

describe("session_history project skill provenance", () => {
  test("taints the window of a row skipped as oversized", async () => {
    // A near-cap skill read serializes past the line cap: the scanner skips the
    // row unparsed, so it can never be classified. The rows after it in the
    // same window are treated like rows after a classified source.
    await appendRawRows([
      JSON.stringify({
        ...createMuxMessage("oversized-read", "assistant", "read something", { timestamp: 2 }),
        padding: "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES),
      }),
    ]);
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("after-oversized", "assistant", "Applying what was read", { timestamp: 3 })
    );
    const runAll = async (excludeProjectSkillContent: boolean) => {
      const config = createTestToolConfig(fixture.tempDir, { workspaceId });
      config.historyService = fixture.historyService;
      config.excludeProjectSkillContent = excludeProjectSkillContent;
      const tool = createSessionHistoryTool(config);
      const page = TOOL_DEFINITIONS.session_history.resultSchema.parse(
        await tool.execute!({ action: "list_items", role: "assistant" }, mockToolCallOptions)
      );
      expect(page.success).toBe(true);
      return {
        texts: (page.items ?? []).map((item) => item.text),
        carries: page.carriesProjectSkillContent === true,
        withheld: page.withheldProjectSkillRows ?? 0,
        oversized: page.warnings?.includes("oversized_rows_skipped") === true,
      };
    };
    const open = await runAll(false);
    expect(open.oversized).toBe(true);
    expect(open.texts).toEqual(["opening facts", "Applying what was read"]);
    expect(open.carries).toBe(true);

    const excluding = await runAll(true);
    expect(excluding.texts).toEqual(["opening facts"]);
    expect(excluding.withheld).toBe(1);
  });

  test("stamps results carrying a project skill read and leaves such rows out when excluded", async () => {
    // A rollover hides earlier rows from the request's own filter; the tool
    // can still reach them. A returned row carrying a project skill read
    // stamps the result (the consent gate arms on it); a turn that must not
    // read project content never receives the row.
    await fixture.historyService.appendToHistory(workspaceId, {
      id: "skill-read-row",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "skill-1",
          toolName: "agent_skill_read",
          state: "output-available",
          input: { name: "repo-conventions" },
          output: {
            success: true,
            skill: { name: "repo-conventions", scope: "project", body: "PROJECT SKILL BODY" },
          },
        },
      ],
      metadata: { timestamp: 2, historySequence: 2 },
    });
    // A later reply in the same context window can quote the read: tainted too.
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("downstream-reply", "assistant", "Applying the conventions", {
        timestamp: 3,
      })
    );
    const run = async (excludeProjectSkillContent: boolean) => {
      const config = createTestToolConfig(fixture.tempDir, { workspaceId });
      config.historyService = fixture.historyService;
      config.excludeProjectSkillContent = excludeProjectSkillContent;
      const tool = createSessionHistoryTool(config);
      return TOOL_DEFINITIONS.session_history.resultSchema.parse(
        await tool.execute!(
          { action: "list_items", tool_name: "agent_skill_read" },
          mockToolCallOptions
        )
      );
    };
    const open = await run(false);
    expect(open.success).toBe(true);
    expect(open.items).toHaveLength(1);
    expect(open.items?.[0].text).toContain("repo-conventions");
    expect(open.carriesProjectSkillContent).toBe(true);
    const excluded = await run(true);
    expect(excluded.success).toBe(true);
    expect(excluded.items).toEqual([]);
    expect(excluded.carriesProjectSkillContent).toBeUndefined();
    // The read AND the downstream reply of its window are withheld.
    expect(excluded.withheldProjectSkillRows).toBe(2);

    // The downstream reply alone (no tool filter) is withheld/stamped through
    // its window's taint, and a routed turn cannot browse recent-first.
    const config = createTestToolConfig(fixture.tempDir, { workspaceId });
    config.historyService = fixture.historyService;
    config.projectSkillContentStillReadable = () => Promise.resolve(true);
    const routedTool = createSessionHistoryTool(config);
    const stamped = TOOL_DEFINITIONS.session_history.resultSchema.parse(
      await routedTool.execute!(
        { action: "search", query: "Applying the conventions" },
        mockToolCallOptions
      )
    );
    expect(stamped.items).toHaveLength(1);
    expect(stamped.carriesProjectSkillContent).toBe(true);
    const refused = TOOL_DEFINITIONS.session_history.resultSchema.parse(
      await routedTool.execute!({ action: "list_items", recent_first: true }, mockToolCallOptions)
    );
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toBe("recent_first_unavailable");
  });
});

describe("session_history tool wiring", () => {
  test("the tool requires the persistent HistoryService", () => {
    const config = createTestToolConfig(fixture.tempDir, { workspaceId });
    config.historyService = undefined;
    expect(() => createSessionHistoryTool(config)).toThrow();
  });
});

describe("session_history real disk recovery", () => {
  test("an interior same-length rewrite between chunks restarts once; a repeat is history_changed", async () => {
    const victim = JSON.stringify(createMuxMessage("rewrite-victim", "assistant", "x".repeat(600)));
    const offset = (await fs.stat(chatPath)).size;
    await fs.appendFile(
      chatPath,
      victim +
        "\n" +
        [
          createMuxMessage("private-after-victim", "assistant", "private facts"),
          createMuxMessage("anchor-padding", "assistant", "z".repeat(500)),
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") +
        "\n"
    );
    await seedFiller();
    const reset = JSON.stringify(manualReset("new-manual-reset"));
    // An untracked writer turns the victim into a reset in place and appends a row.
    const rewriteAndAppend = async (id: string) => {
      const handle = await fs.open(chatPath, "r+");
      try {
        await handle.write(Buffer.from(reset.padEnd(victim.length)), 0, victim.length, offset);
      } finally {
        await handle.close();
      }
      await fs.appendFile(
        chatPath,
        JSON.stringify(createMuxMessage(id, "assistant", "new row")) + "\n"
      );
    };
    const once = mutateBetweenChunks(() => rewriteAndAppend("untracked-append"));
    try {
      // The fresh baseline honors the rewritten reset: rows before it are gone.
      expect(await textsOf({ action: "search", query: "facts" })).toEqual(["private facts"]);
    } finally {
      once.restore();
    }
    expectIntermediate(once);
    const twice = afterChunks(async (chunk) => {
      if (chunk <= 2) await rewriteAndAppend(`untracked-${chunk}`);
    });
    try {
      expect(await call({ action: "search", query: "facts" })).toEqual(CHANGED_RESULT);
    } finally {
      twice.restore();
    }
    expect(twice.chunks).toBe(2);
  });

  for (const targetArtifact of ["active", "archive"] as const) {
    for (const resetPosition of ["before", "after"] as const) {
      test.each([false, true])(
        `${targetArtifact} edit/fork (keep target: %s) preserves a fragmented reset ${resetPosition} the cut`,
        async (keepTargetMessage) => {
          const privateBoundary = await append("private-summary", "private summary", {
            compacted: true,
            compactionBoundary: true,
            compactionEpoch: 1,
          });
          await append("manual-reset", "", { contextBoundaryKind: "reset" });
          const target = await append("cut-target", "target facts");
          const tail = await append("cut-tail", "tail facts");
          // Standalone JSON strings parse, but are still unreadable reset fragments.
          const reset = Buffer.concat([
            Buffer.from(' {\n"contextBoundaryKind"\n:\n"reset"\n'),
            Buffer.from([0xff]),
            Buffer.from("\r\n}\n"),
          ]);
          const targetLine = Buffer.from(JSON.stringify(target) + "\n");
          const tailLine = Buffer.from(JSON.stringify(tail) + "\n");
          await fs.writeFile(
            chatPath,
            Buffer.concat(
              resetPosition === "before"
                ? [reset, targetLine, tailLine]
                : [targetLine, reset, tailLine]
            )
          );
          if (targetArtifact === "archive") {
            await append("later-boundary", "public summary", {
              compacted: true,
              compactionBoundary: true,
              compactionEpoch: 2,
            });
          }
          const result = await fixture.historyService.truncateAfterMessage(workspaceId, target.id, {
            keepTargetMessage,
          });
          expect(result.success).toBe(true);
          if (!result.success) throw new Error(result.error);
          expect(result.data.removedMessages.some((row) => row.id === target.id)).toBe(
            !keepTargetMessage
          );
          expect(result.data.removedMessages.some((row) => row.id === tail.id)).toBe(true);
          const retained = Buffer.concat([
            targetArtifact === "archive" ? Buffer.alloc(0) : await fs.readFile(archivePath),
            await fs.readFile(chatPath),
          ]);
          expect(retained.includes(reset)).toBe(true);
          expect(retained.includes(Buffer.from("opening facts"))).toBe(true);
          expect(await itemsOf({ action: "search", query: "opening facts" })).toEqual([]);
          expect((await complete({ action: "read_item", item_id: "0" })).error).toBe(
            "item_not_found"
          );
          expect(
            (await windowsOf({ action: "list_windows" })).some(
              (window) =>
                window.windowId === `w:${String(privateBoundary.metadata!.historySequence)}`
            )
          ).toBe(false);
        }
      );
    }
  }

  test.each([false, true])(
    "archived edit/fork (keep target: %s) retains an unreadable floor from the discarded active epoch",
    async (keepTargetMessage) => {
      const target = await append("archived-cut", "target facts");
      await append("later-boundary", "public summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const reset = Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},broken\n');
      await fs.writeFile(chatPath, reset);
      await append("discarded-active", "public facts");
      const result = await fixture.historyService.truncateAfterMessage(workspaceId, target.id, {
        keepTargetMessage,
      });
      expect(result.success).toBe(true);
      const retained = await fs.readFile(chatPath);
      expect(retained.includes(reset)).toBe(true);
      expect(retained.includes(Buffer.from("opening facts"))).toBe(true);
      expect(retained.includes(Buffer.from("discarded-active"))).toBe(false);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
    }
  );

  test("archived fork keeps an unterminated target separate from retained active reset fragments", async () => {
    const target = await append("unterminated-target", "retained target facts");
    await append("later-boundary", "public summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const archived = await fs.readFile(archivePath);
    expect(archived.at(-1)).toBe(10);
    await fs.writeFile(archivePath, archived.subarray(0, -1));
    await fs.writeFile(chatPath, '{"metadata":{"contextBoundaryKind":"reset"},broken\n');
    expect(
      (
        await fixture.historyService.truncateAfterMessage(workspaceId, target.id, {
          keepTargetMessage: true,
        })
      ).success
    ).toBe(true);
    const retained = await fixture.historyService.getLastMessages(workspaceId, 10);
    expect(retained.success).toBe(true);
    if (!retained.success) throw new Error(retained.error);
    expect(retained.data.map((row) => row.id)).toContain(target.id);
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  test.each([
    '{"id":"bad","role":"user"}',
    '{"id":"bad","role":"user","parts":[null]}',
    '{"id":"bad","role":"user","parts":[{"type":"text","text":42}]}',
  ])(
    "percentage truncation keeps invalid parsed rows raw without typed admission: %s",
    async (row) => {
      const invalid = Buffer.from(row + "\n");
      await fs.writeFile(chatPath, Buffer.concat([invalid, await fs.readFile(chatPath)]));
      await append("last", "retained facts");
      const result = await fixture.historyService.truncateHistory(workspaceId, 0.2);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.data.length).toBeGreaterThan(0);
      expect((await fs.readFile(chatPath)).includes(invalid)).toBe(true);
      expect((await itemsOf({ action: "search", query: "retained facts" })).length).toBe(1);
    }
  );

  test.each(["active", "archive"])(
    "partial truncation delimits an unterminated %s floor before future appends",
    async (artifact) => {
      const reset = Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},torn');
      if (artifact === "active") {
        const target = await append("cut-target", "discarded");
        await fs.appendFile(chatPath, reset);
        expect(
          (await fixture.historyService.truncateAfterMessage(workspaceId, target.id)).success
        ).toBe(true);
      } else {
        await fs.writeFile(archivePath, Buffer.concat([await fs.readFile(chatPath), reset]));
        const rows = [
          createMuxMessage("large-first", "user", "public context ".repeat(2000)),
          createMuxMessage("large-last", "user", "public context ".repeat(2000)),
        ];
        await fs.writeFile(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
        expect((await fixture.historyService.truncateHistory(workspaceId, 0.5)).success).toBe(true);
      }
      const rewritten = await fs.readFile(artifact === "active" ? chatPath : archivePath);
      expect(rewritten.includes(reset)).toBe(true);
      const accepted = createMuxMessage("accepted-after-rewrite", "user", "accepted facts");
      expect((await fixture.historyService.appendToHistory(workspaceId, accepted)).success).toBe(
        true
      );
      if (artifact === "archive") {
        await append("next-boundary", "new summary", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
        });
        const archived = await fs.readFile(archivePath, "utf8");
        expect(archived.split("\n").some((line) => line.startsWith('{"id":"large-last"'))).toBe(
          true
        );
      }
      expect((await itemsOf({ action: "search", query: "accepted facts" })).length).toBe(1);
      expect(
        (
          await itemsOf({
            action: "read_item",
            item_id: String(accepted.metadata!.historySequence),
          })
        ).map((item) => item.text)
      ).toEqual(["accepted facts"]);
    }
  );

  test("partial percentage truncation keeps an archive containing only unreadable reset fragments", async () => {
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const reset = Buffer.from(' {\n"contextBoundaryKind"\n:\n"reset"\n}\n');
    await fs.writeFile(chatPath, reset);
    await append("later-boundary", "public summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    await append("large-first", "public context ".repeat(2000));
    await append("large-last", "public context ".repeat(2000));
    const result = await fixture.historyService.truncateHistory(workspaceId, 0.5);
    expect(result.success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    expect((await itemsOf({ action: "search", query: "public" })).length).toBeGreaterThan(0);
  });

  test("truncation recovery hashes preserved invalid UTF-8 as bytes before retiring its tombstone", async () => {
    const reset = Buffer.concat([
      Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},'),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]);
    const active = Buffer.from(
      JSON.stringify(createMuxMessage("public", "assistant", "public facts")) + "\n"
    );
    await fs.writeFile(archivePath, reset);
    await fs.writeFile(chatPath, active);
    await fs.writeFile(
      `${archivePath}.truncate`,
      JSON.stringify(createMuxMessage("private", "assistant", "private facts")) + "\n"
    );
    await fs.writeFile(
      `${archivePath}.truncate.json`,
      JSON.stringify({
        finalArchiveHash: createHash("sha256").update(reset.toString("utf8")).digest("hex"),
        finalChatHash: createHash("sha256").update(active.toString("utf8")).digest("hex"),
        rawHashes: {
          version: 1,
          finalArchiveHash: createHash("sha256").update(reset).digest("hex"),
          finalChatHash: createHash("sha256").update(active).digest("hex"),
        },
      })
    );
    expect((await fixture.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    expect(await itemsOf({ action: "search", query: "private facts" })).toEqual([]);
    expect(
      await fs.stat(`${archivePath}.truncate`).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test.each(["active", "archive"])(
    "partial percentage truncation preserves malformed reset bytes in %s history",
    async (resetArtifact) => {
      for (let index = 0; index < 12; index++)
        await append(`private-${index}`, "old context ".repeat(40));
      const secret = await append("private-secret", "private facts");
      await append("manual-reset", "", { contextBoundaryKind: "reset" });
      const reset = Buffer.concat([
        Buffer.from(' {"metadata":{"contextBoundaryKind"\n:\n"reset"},'),
        Buffer.from([0xff]),
        Buffer.from("\r\n"),
      ]);
      await fs.writeFile(chatPath, reset);
      for (let index = 0; index < 8; index++)
        await append(`public-${index}`, "public facts ".repeat(40));
      if (resetArtifact === "archive") {
        await append("later-boundary", "public summary", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
        });
      }
      const result = await fixture.historyService.truncateHistory(workspaceId, 0.05);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.data.length).toBeGreaterThan(0);
      const retained = Buffer.concat([await fs.readFile(archivePath), await fs.readFile(chatPath)]);
      expect(retained.includes(reset)).toBe(true);
      expect(retained.includes(Buffer.from("private facts"))).toBe(true);
      expect(await itemsOf({ action: "search", query: "private facts" })).toEqual([]);
      expect(
        (await complete({ action: "read_item", item_id: String(secret.metadata!.historySequence) }))
          .error
      ).toBe("item_not_found");
      expect((await itemsOf({ action: "search", query: "public facts" })).length).toBeGreaterThan(
        0
      );
      expect((await fixture.historyService.clearHistory(workspaceId)).success).toBe(true);
      expect(await itemsOf({ action: "search", query: "facts" })).toEqual([]);
    }
  );

  test.each([
    "stream update",
    "partial commit",
    "boundary update",
    "boundary append",
    "single cleanup",
    "batch cleanup",
    "archive cleanup",
    "workspace migration",
    "rotation",
  ])("automatic %s preserves unreadable reset bytes and archive privacy", async (operation) => {
    const privateBoundary = await append("private-summary", "private summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const cleanup = await append("cleanup", "temporary payload");
    const reply = await append("reply", "public facts");
    const raw = await fs.readFile(chatPath);
    const malformed = Buffer.concat([
      Buffer.from(' \t{"metadata":{"contextBoundaryKind"\n:\n"reset"},'),
      Buffer.from([0xff]),
      Buffer.from(" \r\n\n"),
      // Parseable but unreadable as a history message; migration must not normalize it.
      Buffer.from(' {"role":"assistant", "metadata":{"contextBoundaryKind":"reset"}} \r\n'),
      // JSON.parse succeeds but drops the first metadata field and its reset evidence.
      Buffer.from(
        '{"id":"duplicate","role":"assistant","parts":[],"metadata":{"contextBoundaryKind":"reset"},"metadata":{}}\n'
      ),
    ]);
    await fs.writeFile(chatPath, Buffer.concat([malformed, raw.subarray(raw.indexOf(10) + 1)]));
    const boundary = createMuxMessage("summary", "assistant", "public summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    if (operation === "stream update") {
      expect((await fixture.historyService.updateHistory(workspaceId, reply)).success).toBe(true);
    } else if (operation === "partial commit") {
      await fixture.historyService.writePartial(workspaceId, reply);
      expect((await fixture.historyService.commitPartial(workspaceId)).success).toBe(true);
    } else if (operation === "boundary update" || operation === "boundary append") {
      const updateExisting = operation === "boundary update";
      if (updateExisting) {
        boundary.id = reply.id;
        boundary.metadata = {
          ...boundary.metadata,
          historySequence: reply.metadata!.historySequence,
        };
      }
      expect(
        (
          await fixture.historyService.persistBoundaryWithTailCopies(
            workspaceId,
            boundary,
            [createMuxMessage("tail", "user", "public tail")],
            updateExisting
          )
        ).success
      ).toBe(true);
    } else if (operation === "batch cleanup") {
      expect((await fixture.historyService.deleteMessages(workspaceId, [cleanup.id])).success).toBe(
        true
      );
    } else if (operation === "single cleanup" || operation === "archive cleanup") {
      if (operation === "archive cleanup") {
        expect((await fixture.historyService.appendToHistory(workspaceId, boundary)).success).toBe(
          true
        );
      }
      expect((await fixture.historyService.deleteMessage(workspaceId, cleanup.id)).success).toBe(
        true
      );
    } else if (operation === "workspace migration") {
      expect(
        (await fixture.historyService.migrateWorkspaceId("previous-id", workspaceId)).success
      ).toBe(true);
    } else {
      expect((await fixture.historyService.appendToHistory(workspaceId, boundary)).success).toBe(
        true
      );
    }
    const retained = Buffer.concat([await fs.readFile(archivePath), await fs.readFile(chatPath)]);
    expect(retained.includes(malformed)).toBe(true);
    expect(await itemsOf({ action: "search", query: "opening facts" })).toEqual([]);
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
    expect(
      (await windowsOf({ action: "list_windows" })).every(
        (window) => window.windowId !== `w:${String(privateBoundary.metadata!.historySequence)}`
      )
    ).toBe(true);
    expect((await itemsOf({ action: "search", query: "public" })).length).toBeGreaterThan(0);
  });

  test.each([
    "stream update",
    "boundary update",
    "budget rejection",
    "single cleanup",
    "batch cleanup",
  ])("a targeted %s cannot normalize away hidden reset evidence", async (operation) => {
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const trigger = createMuxMessage("trigger", "user", "Request");
    expect((await fixture.historyService.appendToHistory(workspaceId, trigger)).success).toBe(true);
    const raw = Buffer.from(
      JSON.stringify(trigger).replace(
        '"metadata":',
        '"metadata":{"contextBoundaryKind":"reset"},"metadata":'
      ) + "\n"
    );
    await fs.writeFile(chatPath, raw);
    const result =
      operation === "stream update"
        ? await fixture.historyService.updateHistory(workspaceId, trigger)
        : operation === "boundary update"
          ? await fixture.historyService.persistBoundaryWithTailCopies(
              workspaceId,
              {
                ...trigger,
                role: "assistant",
                metadata: {
                  ...trigger.metadata,
                  compacted: true,
                  compactionBoundary: true,
                  compactionEpoch: 1,
                },
              },
              [],
              true
            )
          : operation === "single cleanup"
            ? await fixture.historyService.deleteMessage(workspaceId, trigger.id)
            : operation === "batch cleanup"
              ? await fixture.historyService.deleteMessages(workspaceId, [trigger.id])
              : await fixture.historyService.rejectContextBudgetRequest(workspaceId, trigger);
    expect(result.success).toBe(false);
    expect(await fs.readFile(chatPath)).toEqual(raw);
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  test("budget rejection preserves unreadable reset floors and unrelated raw bytes", async () => {
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const payload = createMuxMessage("rejected-payload", "assistant", "Rejected payload", {
      synthetic: true,
    });
    const trigger = createMuxMessage("rejected-trigger", "user", "Rejected request", {
      requestPreludeMessageIds: [payload.id],
    });
    expect(
      (await fixture.historyService.appendManyToHistory(workspaceId, [payload, trigger])).success
    ).toBe(true);
    const raw = await fs.readFile(chatPath);
    const boundaryEnd = raw.indexOf(10) + 1;
    expect(boundaryEnd).toBeGreaterThan(0);
    const malformed = Buffer.concat([
      Buffer.from('{"role":"assistant","metadata":{"contextBoundaryKind":"reset"},'),
      Buffer.from([0xff]),
      Buffer.from("\n\n"),
    ]);
    await fs.writeFile(chatPath, Buffer.concat([malformed, raw.subarray(boundaryEnd)]));
    expect(await itemsOf({ action: "search", query: "opening facts" })).toEqual([]);
    expect(
      (await fixture.historyService.rejectContextBudgetRequest(workspaceId, trigger)).success
    ).toBe(true);
    const after = await fs.readFile(chatPath);
    expect(after.subarray(0, malformed.length)).toEqual(malformed);
    expect(await itemsOf({ action: "search", query: "opening facts" })).toEqual([]);
    expect(await itemsOf({ action: "search", query: "Rejected" })).toEqual([]);
    const read = await complete({ action: "read_item", item_id: "0" });
    expect(read.error).toBe("item_not_found");
  });

  for (const scenario of [
    { name: "oversized legacy ID", id: "x".repeat(20 * 1024), sequence: undefined },
    {
      name: "oversized ID with an invalid sequence",
      id: "x".repeat(20 * 1024),
      sequence: Number.MAX_SAFE_INTEGER + 1,
    },
    { name: "JSON-expanded control-character ID", id: "\u0000".repeat(1000), sequence: undefined },
  ]) {
    test(`search and exact read recover ${scenario.name} without prefix aliasing`, async () => {
      const addressablePrefix = scenario.id.slice(0, 100);
      await appendTrackedHistory(
        chatPath,
        [
          createMuxMessage(scenario.id, "assistant", "match unaddressable", {
            historySequence: scenario.sequence,
          }),
          createMuxMessage(addressablePrefix, "assistant", "match addressable prefix"),
          createMuxMessage("later", "assistant", "match later"),
        ]
          .map((message) => JSON.stringify(message))
          .join("\n") + "\n"
      );
      const result = await itemsOf({ action: "search", query: "match" });
      expect(result.map((item) => item.text)).toEqual([
        "match unaddressable",
        "match addressable prefix",
        "match later",
      ]);
      expect(
        await textsOf({
          action: "read_item",
          item_id: result[0].itemId,
          window_id: result[0].windowId,
        })
      ).toEqual(["match unaddressable"]);
      expect(
        (await itemsOf({ action: "read_item", item_id: `m:${addressablePrefix}` })).map(
          (item) => item.text
        )
      ).toEqual(["match addressable prefix"]);
      expect(
        (await itemsOf({ action: "read_item", item_id: "0" })).map((item) => item.text)
      ).toEqual(["opening facts"]);
    });
  }

  test.each([
    { manualReset: false, id: "b".repeat(20 * 1024) },
    { manualReset: true, id: "b".repeat(20 * 1024) },
    { manualReset: false, id: "\u0000".repeat(1000) },
    { manualReset: true, id: "\u0000".repeat(1000) },
  ])(
    "unaddressable legacy window IDs are consumed without crossing a reset",
    async ({ manualReset, id }) => {
      const boundary = createMuxMessage(
        id,
        "assistant",
        "",
        manualReset
          ? { contextBoundaryKind: "reset", synthetic: true }
          : { compacted: true, compactionBoundary: true, compactionEpoch: 1 }
      );
      const rows = [
        boundary,
        ...Array.from({ length: 650 }, (_, i) =>
          createMuxMessage(
            `unaddressable-window-${i}`,
            "assistant",
            "facts in unaddressable window"
          )
        ),
        createMuxMessage("addressable-boundary", "assistant", "", rollover),
        createMuxMessage("public", "assistant", "public facts"),
      ];
      await appendTrackedHistory(
        chatPath,
        rows.map((message) => JSON.stringify(message)).join("\n") + "\n"
      );
      expect(await windowIdsOf({ action: "list_windows" })).toEqual(
        manualReset ? ["w:m:addressable-boundary"] : ["w:0", "w:m:addressable-boundary"]
      );
      // 650 unaddressable rows exceed one chunk's row allowance.
      expect(scanned.length).toBeGreaterThan(1);
      expect(await textsOf({ action: "search", query: "facts" })).toEqual(
        manualReset ? ["public facts"] : ["opening facts", "public facts"]
      );
      const older = await complete({ action: "read_item", item_id: "0" });
      if (manualReset) expect(older.error).toBe("item_not_found");
      else expect(older.items?.map((item) => item.text)).toEqual(["opening facts"]);
    }
  );

  test("negative persisted sequences use legacy IDs with distinct row references", async () => {
    await appendTrackedHistory(
      chatPath,
      [
        createMuxMessage("negative-sequence", "assistant", "match negative", {
          historySequence: -1,
        }),
        createMuxMessage("after-negative", "assistant", "match after"),
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n"
    );
    const found = await itemsOf({ action: "search", query: "match" });
    expect(found.map((item) => item.text)).toEqual(["match negative", "match after"]);
    expect(found[0].itemId).not.toBe(found[1].itemId);
    for (const [id, text] of [
      ["negative-sequence", "match negative"],
      ["after-negative", "match after"],
    ]) {
      expect((await call({ action: "read_item", item_id: `m:${id}` })).items?.[0]?.text).toBe(text);
    }
  });

  test("oversized persisted IDs remain addressable through safe sequences", async () => {
    const id = "s".repeat(20 * 1024);
    await appendTrackedHistory(
      chatPath,
      [
        createMuxMessage(id, "assistant", "", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
          historySequence: 42,
        }),
        createMuxMessage(id + "-item", "assistant", "sequenced facts", { historySequence: 43 }),
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n"
    );
    expect((await windowsOf({ action: "list_windows" })).map((window) => window.windowId)).toEqual([
      "w:0",
      "w:42",
    ]);
    expect(await itemsOf({ action: "read_item", item_id: "43" })).toMatchObject([
      { windowId: "w:42", role: "assistant", text: "sequenced facts" },
    ]);
  });

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
    // The tool restarts once, then reports the unresolved recovery without data.
    await fs.writeFile(`${archivePath}.truncate`, "pending transaction");
    expect(await call({ action: "search", query: "opening facts" })).toEqual(CHANGED_RESULT);
  });

  test("a large append between chunks is validated in-process without exposing its rows", async () => {
    await append("one", "match one");
    await seedFiller();
    await append("two", "match two");
    // 2.6 MiB of appended rows: the append check itself spans several chunks.
    const seam = mutateBetweenChunks(() =>
      appendRawRows(
        Array.from({ length: 650 }, (_, i) =>
          createMuxMessage(`append-${i}`, "assistant", "match" + "z".repeat(4096))
        )
      )
    );
    try {
      expect(await textsOf({ action: "search", query: "match" })).toEqual([
        "match one",
        "match two",
      ]);
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
    expect(seam.chunks).toBeGreaterThan(3);
    // A fresh read sees the appended rows.
    expect(
      await textsOf({ action: "search", query: "match", limit: 3 }, { hasMore: true })
    ).toEqual(["match one", "match two", expect.stringMatching(/^matchz+$/) as string]);
  });

  test("malformed lines do not hide surviving rows and a legacy reset still protects older IDs", async () => {
    await appendTrackedHistory(chatPath, "not-json\nnull\n");
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("legacy-reset", "assistant", "", { contextBoundaryKind: "reset" })
      ) + "\n"
    );
    await appendTrackedHistory(
      chatPath,
      "broken-json\n" +
        JSON.stringify(createMuxMessage("after-legacy-reset", "assistant", "recoverable")) +
        "\n"
    );
    const result = await call({ action: "search", query: "recoverable" });
    expect(result.items?.[0]).toMatchObject({
      windowId: "w:m:legacy-reset",
    });
    expect(
      (await call({ action: "read_item", item_id: "m:after-legacy-reset" })).items?.[0]?.text
    ).toBe("recoverable");
    expect(result.warnings).toEqual(["malformed_rows_skipped"]);
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
    await appendTrackedHistory(chatPath, resetLine + "\n");
    const publicBoundary = createMuxMessage("public-boundary", "assistant", "", {
      ...rollover,
      historySequence: 100,
    });
    await appendTrackedHistory(
      chatPath,
      [
        JSON.stringify(publicBoundary),
        "unrelated malformed row",
        JSON.stringify(
          createMuxMessage("public-item", "assistant", "public facts", { historySequence: 101 })
        ),
      ].join("\n") + "\n"
    );
    const windows = await windowsOf({ action: "list_windows" });
    expect(windows.map((window) => window.windowId)).toEqual(["w:100"]);
    expect(
      windows.some(
        (window) => window.windowId === `w:${String(olderWindow.metadata!.historySequence)}`
      )
    ).toBe(false);
    expect(await itemsOf({ action: "search", query: "private" })).toEqual([]);
    expect(
      (await complete({ action: "read_item", item_id: String(hidden.metadata!.historySequence) }))
        .error
    ).toBe("item_not_found");
    expect(
      (await itemsOf({ action: "search", query: "public facts" })).map((item) => item.text)
    ).toEqual(["public facts"]);
  });

  const validRollover = {
    type: "context-window-rollover" as const,
    rolloverId: "validated-rollover",
    reason: "on-send" as const,
    previousWindowId: "w:0",
    flushOpportunity: false,
    contextTokens: 5000,
    maxTokens: 6000,
  };
  const resetCandidates = [
    { name: "user-role reset", role: "user", metadata: { contextBoundaryKind: "reset" } },
    {
      name: "user-role rollover",
      role: "user",
      metadata: { contextBoundaryKind: "reset", muxMetadata: validRollover },
    },
    { name: "invalid-role reset", role: "damaged", metadata: { contextBoundaryKind: "reset" } },
    {
      name: "array-shaped reset metadata",
      role: "assistant",
      metadata: [{ contextBoundaryKind: "reset" }],
    },
    {
      name: "type-only rollover",
      role: "assistant",
      metadata: { contextBoundaryKind: "reset", muxMetadata: { type: "context-window-rollover" } },
    },
    ...[
      { contextBudgetRejected: true },
      { contextBudgetRejected: "damaged" },
      { contextBudgetRejectedMessage: {} },
      { rlmPreservedTailCopy: true },
      { partial: true },
    ].map((conflict) => ({
      name: `rollover with conflicting ${Object.keys(conflict)[0]}`,
      role: "assistant",
      metadata: { contextBoundaryKind: "reset", muxMetadata: validRollover, ...conflict },
    })),
    ...Object.keys(validRollover).map((field) => {
      const partial: Record<string, unknown> = { ...validRollover };
      delete partial[field];
      return {
        name: `rollover missing ${field}`,
        role: "assistant",
        metadata: { contextBoundaryKind: "reset", muxMetadata: partial },
      };
    }),
    ...[
      { rolloverId: "" },
      { previousWindowId: "" },
      { reason: "unexpected" },
      { flushOpportunity: "yes" },
      { contextTokens: -1 },
      { contextTokens: "5000" },
      { maxTokens: 0 },
    ].map((invalid) => ({
      name: `rollover with invalid ${Object.keys(invalid)[0]}`,
      role: "assistant",
      metadata: { contextBoundaryKind: "reset", muxMetadata: { ...validRollover, ...invalid } },
    })),
  ];
  for (const candidate of resetCandidates) {
    test(`${candidate.name} remains a privacy floor for direct and between-chunk scans`, async () => {
      const privateBoundary = await append("private-boundary", "summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const hidden = await append("private-item", "private facts");
      // Decoded JSON keys/values must agree with compact raw-marker detection,
      // including when malformed message/metadata shape makes the row unreadable.
      const resetLine = JSON.stringify({ id: "candidate-reset", parts: [], ...candidate }).replace(
        '"contextBoundaryKind":"reset"',
        '"contextBoundary\\u004bind" \t: "r\\u0065set"'
      );
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows([
            resetLine,
            createMuxMessage("after-candidate", "assistant", "public facts"),
          ])
        )
      ).toEqual(["public facts"]);
      expect(await textsOf({ action: "search", query: "facts" })).toEqual(["public facts"]);
      expect(
        (await complete({ action: "read_item", item_id: String(hidden.metadata!.historySequence) }))
          .error
      ).toBe("item_not_found");
      expect(
        (await windowsOf({ action: "list_windows" })).some(
          (window) => window.windowId === `w:${String(privateBoundary.metadata!.historySequence)}`
        )
      ).toBe(false);
    });
  }

  test("genuine persisted rollovers retain their exemption with writer-added envelope metadata", async () => {
    await append("private-before-genuine", "earlier facts");
    const [boundary, leadIn] = createRolloverPrefix(validRollover);
    boundary.metadata = {
      ...boundary.metadata,
      model: "openai:gpt-4o",
      partial: false,
      rlmPreservedTailCopy: false,
    };
    expect(
      (await fixture.historyService.appendManyToHistory(workspaceId, [boundary, leadIn])).success
    ).toBe(true);
    expect((await fs.readFile(chatPath, "utf8")).includes('"workspaceId":')).toBe(true);
    expect(boundary.metadata?.historySequence).toBeNumber();
    const found = await itemsOf({ action: "search", query: "facts" });
    expect(found.map((item) => item.text)).toEqual(["opening facts", "earlier facts"]);
  });

  test("deep parseable reset metadata cannot lose privacy during canonicalization", async () => {
    const resetLine =
      '{"id":"deep-reset","role":"user","parts":[],"metadata":{"contextBoundary\\u004bind":"reset"},"extra":' +
      "[".repeat(10000) +
      "0" +
      "]".repeat(10000) +
      "}";
    await appendTrackedHistory(chatPath, resetLine + "\n");
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  test("a populated reset row cannot impersonate a complete rollover boundary", async () => {
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("populated-rollover", "assistant", "not a boundary-only row", {
          contextBoundaryKind: "reset",
          muxMetadata: validRollover,
        })
      ) + "\n"
    );
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  test("complete production rollover boundaries remain traversable in initial and appended scans", async () => {
    await append("private-item", "older facts");
    const [boundary, leadIn] = createRolloverPrefix(validRollover);
    // A tracked rollover appended between chunks is an ordinary append: the pinned snapshot
    // is kept, so the in-flight read excludes the newer rows without restarting.
    expect(
      await searchInterleaved("facts", () =>
        appendRawRows([
          boundary,
          leadIn,
          createMuxMessage("after-rollover", "assistant", "newer facts"),
        ])
      )
    ).toEqual(["opening facts", "older facts"]);
    expect(await textsOf({ action: "search", query: "facts" })).toEqual([
      "opening facts",
      "older facts",
      "newer facts",
    ]);
  });

  test("a malformed reset appended between chunks restarts the read behind it", async () => {
    await append("one", "match one");
    await append("two", "match two");
    expect(
      await searchInterleaved("match", () =>
        appendRawRows([
          '{"metadata":{"contextBoundaryKind":"reset"},"parts":[',
          createMuxMessage("after", "assistant", "match after"),
        ])
      )
    ).toEqual(["match after"]);
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
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(legacy) +
        "\n" +
        JSON.stringify(createMuxMessage("legacy-item", "assistant", "legacy facts")) +
        "\n"
    );
    const windows = await windowsOf({ action: "list_windows" });
    // Visible boundary rows (compaction summaries) count toward their own window; the empty
    // rollover row does not.
    expect(windows).toEqual([
      { windowId: "w:0", boundaryKind: "root", itemCount: 1 },
      {
        windowId: `w:${String(compact.metadata!.historySequence)}`,
        boundaryKind: "compaction",
        itemCount: 1,
      },
      {
        windowId: `w:${String(heartbeat.metadata!.historySequence)}`,
        boundaryKind: "compaction",
        itemCount: 1,
      },
      {
        windowId: `w:${String(roll.metadata!.historySequence)}`,
        boundaryKind: "reset",
        itemCount: 1,
      },
      { windowId: "w:m:legacy-boundary", boundaryKind: "compaction", itemCount: 2 },
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

  for (const readable of [true, false]) {
    test.each([1, SESSION_HISTORY_MAX_SCAN_ROWS - 2])(
      `post-reset windows retain only verified boundary metadata (readable: ${readable}, rows: %s)`,
      async (tailLength) => {
        const reset = readable
          ? JSON.stringify(
              createMuxMessage("manual-reset", "assistant", "", {
                contextBoundaryKind: "reset",
                historySequence: 42,
              })
            )
          : '{"metadata":{"contextBoundaryKind":"reset"},broken';
        await appendTrackedHistory(
          chatPath,
          [
            reset,
            ...Array.from({ length: tailLength }, (_, index) =>
              JSON.stringify(createMuxMessage(`post-reset-${index}`, "assistant", "public facts"))
            ),
            JSON.stringify(
              createMuxMessage("later-compaction", "assistant", "public summary", {
                compacted: true,
                compactionBoundary: true,
                compactionEpoch: 1,
                historySequence: 1000,
              })
            ),
          ].join("\n") + "\n"
        );
        const listed = await windowsOf({ action: "list_windows" });
        // The reverse scan reaches its row cap at the floor; its boundary metadata must
        // survive the chunk boundary before any browse row runs.
        if (tailLength > 1) expect(scanned.length).toBeGreaterThan(1);
        expect(listed).toEqual([
          {
            windowId: readable ? "w:42" : "w:0",
            boundaryKind: readable ? "reset" : "root",
            itemCount: tailLength,
          },
          { windowId: "w:1000", boundaryKind: "compaction", itemCount: 1 },
        ]);
        expect((await complete({ action: "read_item", item_id: "0" })).error).toBe(
          "item_not_found"
        );
        expect(await itemsOf({ action: "search", query: "opening facts" })).toEqual([]);
      }
    );
  }

  test("plain manual reset is a privacy floor even for arbitrary IDs and multi-chunk floor discovery", async () => {
    const hidden = await append("hidden", "private-before-reset");
    await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
    const tail = Array.from({ length: 650 }, (_, i) =>
      createMuxMessage(`tail-${i}`, "assistant", `public-${i}`, { historySequence: 1000 + i })
    );
    await appendRawRows(tail);
    // Floor discovery alone needs more than one chunk; the answer is still one clean miss.
    expect(await readError(String(hidden.metadata!.historySequence))).toBe("item_not_found");
    expect(scanned.length).toBeGreaterThan(1);
    expect(
      await itemsOf({ action: "search", query: "private-before-reset", window_id: "w:0" })
    ).toEqual([]);
  });

  test("search and read retain media-shaped ordinary tool JSON and literal data URLs", async () => {
    const records = ["file", "image", "image_url", "audio", "video", "media"].map((type) => ({
      type,
      content: `ordinary-${type} facts 🧭`,
    }));
    const input = {
      type: "file",
      mediaType: "text/plain",
      data: "ordinary input facts",
      example: { type: "media", mediaType: "image/png", data: "ordinary argument bytes" },
    };
    const output = {
      nested: records,
      image: { type: "image", image: "ordinary image payload" },
      file: { type: "file", mediaType: "image/png", url: "data:image/png;base64,ordinary literal" },
    };
    const message = await append("media-lookalikes", "", undefined, [
      {
        type: "dynamic-tool",
        toolCallId: "ordinary-json",
        toolName: "bash",
        state: "output-available",
        input,
        output,
      },
    ]);
    for (const query of [
      ...records.map((record) => record.content),
      input.data,
      input.example.data,
      output.file.url,
    ]) {
      const found = await itemsOf({ action: "search", query });
      expect(found).toHaveLength(1);
      expect(found[0].text).toContain(query);
    }
    let offset: number | undefined = 0;
    const chunks: string[] = [];
    while (offset !== undefined) {
      const read = await call({
        action: "read_item",
        item_id: String(message.metadata!.historySequence),
        offset_chars: offset,
        limit_chars: 37,
      });
      expect(read.success).toBe(true);
      expect(read.has_more).toBeUndefined();
      const item = read.items![0];
      expect(Buffer.from(item.text).toString("utf8")).toBe(item.text);
      chunks.push(item.text);
      offset = item.nextCharOffset;
      expect(chunks.length).toBeLessThan(40);
    }
    expect(JSON.parse(chunks.join(""))).toMatchObject({ input, output });
  });

  test.each([false, true])(
    "missing item references fail only after scan exhaustion (stale physical reference: %s)",
    async (stale) => {
      const target = await append("reference-target", "before rewrite");
      const reference = await call({
        action: "read_item",
        item_id: String(target.metadata!.historySequence),
      });
      expect(reference.success).toBe(true);
      const itemId = stale ? reference.items![0].itemId : "m:missing";
      const raw = await fs.readFile(chatPath, "utf8");
      await fs.writeFile(chatPath, raw.replace("before rewrite", "after rewriting"));
      await appendTrackedHistory(
        chatPath,
        Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 1 }, (_, index) =>
          JSON.stringify(createMuxMessage(`padding-${index}`, "assistant", "padding"))
        ).join("\n") + "\n"
      );
      // The miss is reported once, after the whole (multi-chunk) history was scanned.
      expect(await readError(itemId)).toBe("item_not_found");
      expect(scanned.length).toBeGreaterThan(1);
    }
  );

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
        nestedCalls: [
          {
            toolCallId: "nested-media",
            toolName: "attach_file",
            state: "output-available",
            input: { type: "file", content: "nested ordinary needle" },
            output: { type: "media", mediaType: "image/png", data: "private needle" },
          },
        ],
        output: {
          nestedCalls: [
            { toolName: "session_history", output: "private needle" },
            {
              toolName: "attach_file",
              output: {
                type: "content",
                value: [
                  { type: "media", mediaType: "image/png", data: "private needle" },
                  { type: "display_file", mediaType: "application/zip", data: "private needle" },
                ],
              },
            },
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
    expect(read.items?.[0]?.text).toContain("nested ordinary needle");
    expect(read.items?.[0]?.text).not.toContain("private needle");
  });

  test("search is literal, lists matches without duplicates, and read_item pages characters", async () => {
    const first = await append("literal", "A [x].* literal");
    await append("other", "another [X].* value");
    await append("regex-decoy", "xZZZ value");
    const all = await itemsOf({ action: "search", query: "[x].*" });
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

  test.each([false, true])(
    "same-window duplicate sequences expose exact row IDs (same message ID: %s)",
    async (sameId) => {
      const first = createMuxMessage("duplicate-first", "assistant", "needle first payload", {
        historySequence: 7,
      });
      const text = "needle second payload " + "distinct second-row content ".repeat(400);
      const second = createMuxMessage(sameId ? first.id : "duplicate-second", "assistant", text, {
        historySequence: 7,
      });
      await appendTrackedHistory(
        chatPath,
        [first, second].map((row) => JSON.stringify(row)).join("\n") + "\n"
      );
      const found = await itemsOf({ action: "search", query: "needle" });
      expect(found).toHaveLength(2);
      expect(found[0].windowId).toBe(found[1].windowId);
      expect(found[0].itemId).not.toBe(found[1].itemId);
      const chunks: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const result = await call({
          action: "read_item",
          item_id: found[1].itemId,
          window_id: found[1].windowId,
          offset_chars: offset,
          limit_chars: 4000,
        });
        expect(result.success).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items![0].itemId).toBe(found[1].itemId);
        chunks.push(result.items![0].text);
        const previousOffset = offset;
        offset = result.items![0].nextCharOffset;
        if (offset !== undefined) {
          expect(offset).toBeGreaterThan(previousOffset);
          expect(chunks.length).toBeLessThan(10);
          // An ordinary append must not move the physical identity between read pages.
          await append(`after-page-${chunks.length}`, "later unrelated row");
        }
      }
      expect(chunks.join("")).toBe(text);
      const legacy = await call({ action: "read_item", item_id: "7" });
      expect(legacy.items?.[0]?.text).toBe("needle first payload");
    }
  );

  test("an exact row ID does not resolve to a rewritten payload or cross a later reset", async () => {
    const original = createMuxMessage("original", "assistant", "needle before rewrite", {
      historySequence: 8,
    });
    await appendTrackedHistory(chatPath, JSON.stringify(original) + "\n");
    const found = (await itemsOf({ action: "search", query: "needle" }))[0];
    const raw = await fs.readFile(chatPath, "utf8");
    await fs.writeFile(chatPath, raw.replace("needle before rewrite", "needle after rewriting"));
    expect((await complete({ action: "read_item", item_id: found.itemId })).error).toBe(
      "item_not_found"
    );
    const current = (await itemsOf({ action: "search", query: "needle" }))[0];
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("manual-reset", "assistant", "", { contextBoundaryKind: "reset" })
      ) + "\n"
    );
    expect((await complete({ action: "read_item", item_id: current.itemId })).error).toBe(
      "item_not_found"
    );
  });

  test("identical physical copies have distinct references that expire after a rewrite", async () => {
    const row =
      JSON.stringify(
        createMuxMessage("identical", "assistant", "needle identical payload", {
          historySequence: 9,
        })
      ) + "\n";
    await fs.writeFile(chatPath, row + row);
    const found = await itemsOf({ action: "search", query: "needle" });
    expect(found).toHaveLength(2);
    expect(found[0].itemId).not.toBe(found[1].itemId);
    for (const item of found) {
      expect((await call({ action: "read_item", item_id: item.itemId })).items?.[0]?.text).toBe(
        "needle identical payload"
      );
    }
    // Removing the first physical copy moves identical bytes onto its old offset.
    await fs.writeFile(chatPath, row);
    for (const item of found) {
      expect((await complete({ action: "read_item", item_id: item.itemId })).error).toBe(
        "item_not_found"
      );
    }
    const current = (await itemsOf({ action: "search", query: "needle" }))[0];
    expect((await call({ action: "read_item", item_id: current.itemId })).items?.[0]?.text).toBe(
      "needle identical payload"
    );
  });

  test("rotation expires exact references without hiding the relocated row from a new search", async () => {
    await append("relocated", "needle archived payload");
    const previous = (await itemsOf({ action: "search", query: "needle" }))[0];
    await append("rotate", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    expect((await complete({ action: "read_item", item_id: previous.itemId })).error).toBe(
      "item_not_found"
    );
    const current = (await itemsOf({ action: "search", query: "needle" }))[0];
    expect((await call({ action: "read_item", item_id: current.itemId })).items?.[0]?.text).toBe(
      "needle archived payload"
    );
  });

  test("empty queries are rejected and zero-width regexp syntax remains literal", async () => {
    expect((await call({ action: "search", query: "" })).error).toBe("query_required");
    await append("literal-zero-width", "literal ^ $ (?=x) \\b markers");
    await append("zero-width-decoy", "x ordinary text");
    for (const query of ["^", "$", "(?=x)", "\\b"]) {
      expect((await itemsOf({ action: "search", query })).map((item) => item.text)).toEqual([
        "literal ^ $ (?=x) \\b markers",
      ]);
    }
  });

  test("literal case-insensitive snippets use original offsets after expanding Unicode lowercases", async () => {
    const query = "[NeEdLe].*\\(x)?";
    const text = "İ".repeat(300) + query + " trailing context";
    await append("unicode-prefix", text);
    await append("regex-decoy", "İ".repeat(300) + "needleZZZx");
    const found = await itemsOf({ action: "search", query: query.toLowerCase() });
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain(query);
    expect(found[0].text).toBe(text.slice(180));
  });

  test.each([1, 2, 3])(
    "UTF-16 character pages preserve astral pairs with limit %s",
    async (limit) => {
      const text = "😀A🧑B🚀C😀";
      const message = await append("astral-pages", text);
      let offset: number | undefined = 0;
      let recovered = "";
      let count = 0;
      while (offset !== undefined) {
        const page = await call({
          action: "read_item",
          item_id: String(message.metadata!.historySequence),
          offset_chars: offset,
          limit_chars: limit,
        });
        expect(page.success).toBe(true);
        expect(page.items).toHaveLength(1);
        const item = page.items![0];
        expect(Buffer.from(item.text, "utf8").toString("utf8")).toBe(item.text);
        expect(item.text.length).toBeGreaterThan(0);
        recovered += item.text;
        if (item.nextCharOffset !== undefined) {
          expect(item.nextCharOffset).toBeGreaterThan(offset);
          expect(item.nextCharOffset).toBe(recovered.length);
        }
        offset = item.nextCharOffset;
        expect(++count).toBeLessThan(20);
      }
      expect(recovered).toBe(text);
    }
  );

  test("manual offsets inside a surrogate pair round back and EOF offsets finish", async () => {
    const message = await append("manual-astral-offset", "A😀B");
    const inside = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      offset_chars: 2,
      limit_chars: 1,
    });
    expect(inside.items?.[0]?.text).toBe("😀");
    expect(inside.items?.[0]?.nextCharOffset).toBe(3);
    for (const offset of [4, 100]) {
      const end = await call({
        action: "read_item",
        item_id: String(message.metadata!.historySequence),
        offset_chars: offset,
        limit_chars: 1,
      });
      expect(end.items?.[0]?.text).toBe("");
      expect(end.items?.[0]?.nextCharOffset).toBeUndefined();
      expect(end.has_more).toBeUndefined();
    }
    const empty = await append("empty-page", "");
    const end = await call({
      action: "read_item",
      item_id: String(empty.metadata!.historySequence),
      limit_chars: 1,
    });
    expect(end).toEqual({ success: false, error: "item_not_found" });
  });

  test("JSON-budget shrinking preserves emoji pairs and exact continuation offsets", async () => {
    const text = '"\\'.repeat(100) + "😀".repeat(4501);
    const message = await append("budget-astral", text);
    let offset: number | undefined = 0;
    let recovered = "";
    let shrank = false;
    while (offset !== undefined) {
      const page = await call({
        action: "read_item",
        item_id: String(message.metadata!.historySequence),
        offset_chars: offset,
        limit_chars: 16000,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        SESSION_HISTORY_MAX_RESULT_BYTES
      );
      const item = page.items![0];
      expect(Buffer.from(item.text, "utf8").toString("utf8")).toBe(item.text);
      expect(item.text.length).toBeGreaterThan(0);
      recovered += item.text;
      shrank ||= page.truncated === true;
      if (item.nextCharOffset !== undefined) {
        expect(item.nextCharOffset).toBeGreaterThan(offset);
        expect(item.nextCharOffset).toBe(recovered.length);
      }
      offset = item.nextCharOffset;
    }
    expect(shrank).toBe(true);
    expect(recovered).toBe(text);
  });

  test("search snippet boundaries cannot split surrogate pairs", async () => {
    const starts = "x".repeat(100) + "😀" + "x".repeat(119) + "needle";
    const ends = "needle" + "x".repeat(493) + "😀tail";
    await append("astral-snippet-start", starts);
    await append("astral-snippet-end", ends);
    const found = await itemsOf({ action: "search", query: "needle" });
    expect(found).toHaveLength(2);
    for (const item of found) {
      expect(Buffer.from(item.text, "utf8").toString("utf8")).toBe(item.text);
      expect(item.text).toContain("needle");
    }
    expect(found[0].text).toBe(starts.slice(100));
    expect(found[1].nextCharOffset).toBe(499);
    expect(
      (
        await call({
          action: "read_item",
          item_id: found[1].itemId,
          offset_chars: found[1].nextCharOffset,
          limit_chars: 1,
        })
      ).items?.[0]?.text
    ).toBe("😀");
  });

  test("already-unpaired stored surrogates are replaced only in output without shifting offsets", async () => {
    const message = await append("unpaired-source", "\ud800A\udc00😀");
    const before = await fs.readFile(chatPath);
    const page = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      limit_chars: 3,
    });
    expect(page.items?.[0]?.text).toBe("\ufffdA\ufffd");
    expect(page.items?.[0]?.nextCharOffset).toBe(3);
    expect(await fs.readFile(chatPath)).toEqual(before);
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
      limit: null,
    });
    expect(first.items?.[0]?.text).toBe(text.slice(0, 8000));
    expect(first.items?.[0]?.nextCharOffset).toBe(8000);
    expect(first.has_more).toBeUndefined();
    expect(first.warnings).toBeUndefined();
    const second = await call({
      action: "read_item",
      item_id: first.items![0].itemId,
      window_id: first.items![0].windowId,
      offset_chars: first.items![0].nextCharOffset,
    });
    expect(second.items?.[0]?.text).toBe(text.slice(8000));
    expect(second.items?.[0]?.nextCharOffset).toBeUndefined();
    expect(second.has_more).toBeUndefined();
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
    await appendTrackedHistory(
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
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(createMuxMessage("after", "assistant", "recover me")) + "\n"
    );
    const all = await complete({ action: "search", query: "recover me" });
    // The 5 MiB row is skipped mid-line across several 2 MiB chunks, once per direction.
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    expect(all.warnings).toEqual(["oversized_rows_skipped"]);
    expect(all.items?.map((item) => item.text)).toEqual(["recover me"]);
    expect(
      (await itemsOf({ action: "search", query: "opening facts" })).map((item) => item.text)
    ).toEqual(["opening facts"]);
  });

  for (const junk of [
    "X",
    "???/#",
    "unexpected words",
    "[]{}=,",
    "😀",
    "printable-junk".repeat(200000),
  ]) {
    test(`malformed separator ${junk.slice(0, 24)} preserves initial and appended reset privacy`, async () => {
      await append("private", "private facts");
      const key =
        junk.length > 1000 ? unicodeEscapes("contextBoundaryKind") : "contextBoundaryKind";
      const value = junk.length > 1000 ? unicodeEscapes("reset") : "reset";
      // Appended between chunks (a multi-megabyte junk row needs several append-check
      // chunks of its own), the malformed reset restarts the read behind itself.
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows([
            `{"id":"junk-reset","role":"assistant","metadata":{"${key}"${junk}:${junk}"${value}"},"parts":[]}`,
            createMuxMessage("after-junk-reset", "assistant", "public facts"),
          ])
        )
      ).toEqual(["public facts"]);
      expect(await textsOf({ action: "search", query: "facts" })).toEqual(["public facts"]);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
    });
  }

  test("valid non-reset fields cannot be joined by the malformed-token recognizer", async () => {
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("not-a-reset", "assistant", "facts remain readable", {
          contextBoundaryKind: undefined,
        })
      ).replace('"metadata":{}', '"metadata":{"contextBoundaryKind":"normal","other":"reset"}') +
        "\n"
    );
    expect((await itemsOf({ action: "read_item", item_id: "0" })).map((item) => item.text)).toEqual(
      ["opening facts"]
    );
  });

  test.each([
    '"reset" junk : junk "contextBoundaryKind"',
    '"contextBoundaryKinds" junk : junk "reset"',
    '"contextBoundaryKind" junk : junk "resume"',
  ])("unrelated malformed tokens do not create a reset: %s", async (fragment) => {
    await appendTrackedHistory(chatPath, fragment + "\n");
    expect((await itemsOf({ action: "read_item", item_id: "0" })).map((item) => item.text)).toEqual(
      ["opening facts"]
    );
  });

  for (const separator of [
    String.fromCharCode(0),
    String.fromCharCode(11),
    String.fromCharCode(12),
    String.fromCharCode(31),
    String.fromCharCode(127),
    "\\u0000",
  ]) {
    test(`control separator ${separator.charCodeAt(0)} cannot hide a reset in initial or appended scans`, async () => {
      await append("private", "private facts");
      const marker = `"contextBoundaryKind"${separator}:${separator}"reset"`;
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows([
            `{"id":"control-reset","role":"assistant","parts":[],"metadata":{${marker}}}`,
            createMuxMessage("public", "assistant", "public facts"),
          ])
        )
      ).toEqual(["public facts"]);
      expect(await textsOf({ action: "search", query: "facts" })).toEqual(["public facts"]);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
    });
  }

  test.each([String.fromCharCode(0), "\\u0000"])(
    "oversized control separators retain a bounded reset probe across chunks",
    async (separator) => {
      await append("private", "private facts");
      const marker =
        '"contextBoundaryKind"' +
        separator.repeat(Math.ceil(SESSION_HISTORY_MAX_SCAN_BYTES / separator.length)) +
        ':"' +
        unicodeEscapes("reset") +
        '"';
      // The 4 MiB reset row spans several append-check chunks; its probe state must
      // survive each chunk boundary so the read restarts behind it.
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows([
            `{"id":"giant-control-reset","role":"assistant","parts":[],"metadata":{${marker}},"padding":"${"x".repeat(SESSION_HISTORY_MAX_SCAN_BYTES)}"}`,
          ])
        )
      ).toEqual([]);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
    }
  );

  test("rotation does not normalize away raw reset evidence in a sequence-covered row", async () => {
    await append("private", "private facts");
    await append("sealed-boundary", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const original = (await fs.readFile(archivePath, "utf8")).split("\n")[0];
    const repaired = original.replace(
      '"metadata":',
      '"metadata":{"contextBoundaryKind":"reset"},"metadata":'
    );
    await appendTrackedHistory(chatPath, repaired + "\n");
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
    await fixture.historyService.appendToHistory(
      workspaceId,
      createRolloverPrefix(validRollover)[0]
    );
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  for (const mode of ["append", "batch", "lazy", "update"] as const) {
    test(`${mode} rotation preserves a manual reset below the archive sequence watermark`, async () => {
      await append("private", "private facts");
      await append("sealed-boundary", "summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const reset = createMuxMessage(
        mode === "batch" ? "first" : "repaired-reset",
        "assistant",
        "",
        {
          contextBoundaryKind: "reset",
          historySequence: 0,
        }
      );
      await appendTrackedHistory(chatPath, JSON.stringify(reset) + "\n");
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
      const [boundary, leadIn] = createRolloverPrefix(validRollover);
      if (mode === "append") await fixture.historyService.appendToHistory(workspaceId, boundary);
      else if (mode === "batch")
        await fixture.historyService.appendManyToHistory(workspaceId, [boundary, leadIn]);
      else if (mode === "lazy") {
        boundary.metadata = { ...boundary.metadata, historySequence: 3 };
        await appendTrackedHistory(chatPath, JSON.stringify(boundary) + "\n");
        expect(
          (await fixture.historyService.getHistoryFromLatestBoundary(workspaceId)).success
        ).toBe(true);
      } else {
        const pending = await append("pending-boundary", "pending");
        expect(
          (
            await fixture.historyService.updateHistory(workspaceId, {
              ...boundary,
              id: pending.id,
              metadata: {
                ...boundary.metadata,
                historySequence: pending.metadata!.historySequence,
              },
            })
          ).success
        ).toBe(true);
      }
      await append("public-after-rotation", "public facts");
      const archivedRows = (await fs.readFile(archivePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as MuxMessage);
      expect(
        archivedRows.find(
          (row) => row.id === reset.id && row.metadata?.contextBoundaryKind === "reset"
        )
      ).toMatchObject(reset);
      expect(
        (await itemsOf({ action: "search", query: "facts" })).map((item) => item.text)
      ).toEqual(["public facts"]);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
    });
  }

  for (const [name, marker] of [
    ["value", '"contextBoundaryKind":"res\\x65t"'],
    ["key", '"\\x63ontextBoundaryKind":"reset"'],
    ["colon", '"contextBoundaryKind"\\x3a"reset"'],
    ["quotes", "\\x22contextBoundaryKind\\x22:\\x22reset\\x22"],
    ["mixed escapes", '\\x22context\\u0042oundaryKind\\x22\\x3A"res\\x65t"'],
    ["whitespace", '"contextBoundaryKind"\\x20:\\x09"res\\x65t"'],
  ]) {
    test(`hex-escaped reset ${name} protects direct/between-chunk retrieval and raw rewrites`, async () => {
      await append("private", "private facts");
      const raw = Buffer.from(
        `{"id":"hex-reset","role":"assistant","parts":[],"metadata":{${marker}}}\n`
      );
      let current!: MuxMessage;
      let cut!: MuxMessage;
      expect(
        await searchInterleaved("facts", async () => {
          await appendTrackedHistory(chatPath, raw);
          current = await append("public", "public facts");
          cut = await append("cut", "discarded tail");
        })
      ).toEqual(["public facts"]);
      expect(await textsOf({ action: "search", query: "facts" })).toEqual(["public facts"]);
      expect(hasRawResetMarker(raw.toString("utf8"))).toBe(true);
      expect((await fixture.historyService.updateHistory(workspaceId, current)).success).toBe(true);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
      expect((await fixture.historyService.truncateAfterMessage(workspaceId, cut.id)).success).toBe(
        true
      );
      expect((await fs.readFile(chatPath)).includes(raw)).toBe(true);
      expect(
        (await itemsOf({ action: "search", query: "facts" })).map((item) => item.text)
      ).toEqual(["public facts"]);
    });
  }

  test.each([
    '"contextBoundaryKinds":"res\\x65t"',
    '"contextBoundaryKind":"re\\x73ume"',
    `"contextBoundaryKind":${JSON.stringify(String.raw`res\x65t`)}`,
  ])("non-reset hex data remains traversable: %s", async (marker) => {
    const row = `{"id":"not-reset","role":"assistant","parts":[],"metadata":{${marker}}}\n`;
    await appendTrackedHistory(chatPath, row);
    expect(hasRawResetMarker(row)).toBe(false);
    expect((await itemsOf({ action: "read_item", item_id: "0" })).map((item) => item.text)).toEqual(
      ["opening facts"]
    );
  });

  const fragmentedResetMarkers = [
    { name: "after the key", marker: '"contextBoundaryKind"\n:"reset"' },
    { name: "after the colon", marker: '"contextBoundaryKind":\n"reset"' },
    { name: "at both lexical gaps", marker: '"contextBoundaryKind"\r\n \t:\r\n "reset"' },
    {
      name: "with escaped tokens",
      marker: `"${unicodeEscapes("contextBoundaryKind")}"\n:\n"${unicodeEscapes("reset")}"`,
    },
    {
      name: "with hex-escaped fragments",
      marker: '"\\x63ontextBoundaryKind"\n\\x3A\n"res\\x65t"',
    },
    {
      name: "across a row-budget page",
      marker:
        '"contextBoundaryKind"\n' + " \t\n".repeat(SESSION_HISTORY_MAX_SCAN_ROWS + 3) + ':"reset"',
    },
    {
      name: "across a byte-budget page",
      marker:
        `"${unicodeEscapes("contextBoundaryKind")}"\n` +
        " ".repeat(SESSION_HISTORY_MAX_SCAN_BYTES + 256) +
        `:\n"${unicodeEscapes("reset")}"`,
    },
  ];
  for (const fragment of fragmentedResetMarkers) {
    test(`reset fragmented ${fragment.name} blocks initial and between-chunk recovery`, async () => {
      const hidden = await append("private", "private facts");
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows([
            `{"id":"fragmented-reset","role":"assistant","parts":[],"metadata":{${fragment.marker}}}`,
            createMuxMessage("public-after-fragments", "assistant", "public facts"),
          ])
        )
      ).toEqual(["public facts"]);
      expect(
        (await itemsOf({ action: "search", query: "facts" })).map((item) => item.text)
      ).toEqual(["public facts"]);
      expect(
        (await complete({ action: "read_item", item_id: String(hidden.metadata!.historySequence) }))
          .error
      ).toBe("item_not_found");
    });
  }

  test("valid-row isolation does not discard a raw reset hidden by duplicate keys", async () => {
    await appendTrackedHistory(
      chatPath,
      '{"id":"duplicate-reset","role":"assistant","parts":[],"metadata":{"contextBoundaryKind":"reset","contextBoundaryKind":"normal"}}\n'
    );
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  const rolloverJson = JSON.stringify(rollover);
  const rolloverDetailsJson = JSON.stringify(rollover.muxMetadata);
  for (const [name, metadataFields] of [
    [
      "duplicate root metadata",
      `"metadata":{"contextBoundaryKind":"reset"},"metadata":${rolloverJson}`,
    ],
    [
      "escaped equivalent root key",
      `"metadata":{"contextBoundaryKind":"reset"},"${unicodeEscapes("metadata")}":${rolloverJson}`,
    ],
    [
      "duplicate nested metadata",
      `"metadata":{"contextBoundaryKind":"reset","muxMetadata":{"type":"manual"},"muxMetadata":${rolloverDetailsJson}}`,
    ],
    [
      "duplicate nested leaf",
      `"metadata":${rolloverJson.replace('"maxTokens":6000', '"maxTokens":0,"maxTokens":6000')}`,
    ],
    [
      "escaped equivalent nested key",
      `"metadata":${rolloverJson.replace('"reason":"on-send"', `"reason":"manual","${unicodeEscapes("reason")}":"on-send"`)}`,
    ],
  ]) {
    test(`${name} cannot disguise a manual reset as a rollover in direct or between-chunk recovery`, async () => {
      await append("private", "private facts");
      const ambiguousRow = `{"id":"ambiguous-reset","role":"assistant","parts":[],${metadataFields}}\n`;
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows([
            ambiguousRow.trimEnd(),
            createMuxMessage("public-after-ambiguous", "assistant", "public facts"),
          ])
        )
      ).toEqual(["public facts"]);
      const direct = await complete({ action: "search", query: "facts" });
      expect(direct.items?.map((item) => item.text)).toEqual(["public facts"]);
      expect(direct.warnings).toEqual(["malformed_rows_skipped"]);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
      // Rewriting metadata must not turn the same raw floor into a valid rollover.
      expect((await fixture.historyService.migrateWorkspaceId("old-id", workspaceId)).success).toBe(
        true
      );
      expect((await fs.readFile(chatPath)).includes(Buffer.from(ambiguousRow))).toBe(true);
      expect(await itemsOf({ action: "search", query: "private facts" })).toEqual([]);
    });
  }

  test("valid rollovers allow repeated key names in distinct objects and string values", async () => {
    await append("private", "private facts");
    // A tracked rollover appended between chunks is no privacy floor: no restart, the
    // pinned snapshot is delivered.
    expect(
      await searchInterleaved("facts", () =>
        appendRawRows([
          JSON.stringify({
            id: "unambiguous-rollover",
            role: "assistant",
            parts: [],
            metadata: {
              ...rollover,
              probes: [{ metadata: 1, "\\u006detadata": 2 }, { metadata: 2 }],
              quoted: '"metadata":0,"metadata":1',
            },
          }),
        ])
      )
    ).toEqual(["opening facts", "private facts"]);
    expect((await itemsOf({ action: "read_item", item_id: "0" })).map((item) => item.text)).toEqual(
      ["opening facts"]
    );
  });

  test("a fully pretty-printed reset still protects the earlier transcript", async () => {
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("pretty-reset", "assistant", "", { contextBoundaryKind: "reset" }),
        null,
        2
      ) +
        "\n" +
        JSON.stringify(createMuxMessage("after-pretty-reset", "assistant", "public facts")) +
        "\n"
    );
    expect((await itemsOf({ action: "search", query: "facts" })).map((item) => item.text)).toEqual([
      "public facts",
    ]);
    expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  test("an append that completes an older malformed reset restarts the read behind it", async () => {
    await append("private", "private facts");
    await seedFiller();
    await appendTrackedHistory(
      chatPath,
      '{"id":"cross-snapshot-reset","role":"assistant","parts":[],"metadata":{"contextBoundaryKind"\n'
    );
    // The append check continues through the pinned snapshot's malformed tail, so the
    // fragment completed by this append is recognized and the read restarts behind it.
    const seam = mutateBetweenChunks(() =>
      appendRawRows([':"reset"}}', createMuxMessage("public", "assistant", "public facts")])
    );
    try {
      expect(await textsOf({ action: "search", query: "facts" })).toEqual(["public facts"]);
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
    expect(await readError("0")).toBe("item_not_found");
  });

  test.each([false, true])(
    "valid rows break malformed-fragment continuity (rollover: %s)",
    async (useRollover) => {
      await append("private", "private facts");
      const separatingRow = useRollover
        ? createRolloverPrefix(validRollover)[0]
        : createMuxMessage("separator", "assistant", "ordinary data");
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows(['"contextBoundaryKind"', separatingRow, ':"reset"'])
        )
      ).toEqual(["opening facts", "private facts"]);
      expect(
        (await itemsOf({ action: "read_item", item_id: "0" })).map((item) => item.text)
      ).toEqual(["opening facts"]);
    }
  );

  function unicodeEscapes(text: string): string {
    return [...text]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
  }

  for (const [name, key, value] of [
    ["escaped key", unicodeEscapes("contextBoundaryKind"), "reset"],
    ["escaped value", "contextBoundaryKind", unicodeEscapes("reset")],
    ["escaped key and value", unicodeEscapes("contextBoundaryKind"), unicodeEscapes("reset")],
    [
      "uppercase hex digits",
      unicodeEscapes("contextBoundaryKind").replace(/[a-f]/g, (hex) => hex.toUpperCase()),
      unicodeEscapes("reset"),
    ],
  ]) {
    test(`oversized ${name} preserves privacy across whitespace and appended chunks`, async () => {
      await append("private", "private facts");
      const marker = `"${key}"` + " \t".repeat(SESSION_HISTORY_MAX_SCAN_BYTES) + ` : "${value}"`;
      const row = `{"id":"escaped-reset","role":"assistant","metadata":{${marker}},"parts":[],"padding":"${"x".repeat(SESSION_HISTORY_MAX_SCAN_BYTES)}"}`;
      expect(
        await searchInterleaved("facts", () =>
          appendRawRows([row, createMuxMessage("after-escaped-reset", "assistant", "public facts")])
        )
      ).toEqual(["public facts"]);
      expect((await complete({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
      expect(
        (await itemsOf({ action: "search", query: "facts" })).map((item) => item.text)
      ).toEqual(["public facts"]);
    });
  }

  for (const [name, key, value] of [
    [
      "different value",
      `"${unicodeEscapes("contextBoundaryKind")}"`,
      `"${unicodeEscapes("resume")}"`,
    ],
    [
      "different key",
      `"${unicodeEscapes("contextBoundaryKinds")}"`,
      `"${unicodeEscapes("reset")}"`,
    ],
    [
      "literal escaped key",
      JSON.stringify(unicodeEscapes("contextBoundaryKind")),
      `"${unicodeEscapes("reset")}"`,
    ],
  ]) {
    test(`oversized Unicode data with ${name} remains traversable`, async () => {
      await appendTrackedHistory(
        chatPath,
        `{"id":"not-reset","role":"assistant","metadata":{${key}:${value}},"parts":[],"padding":"${"x".repeat(2 * SESSION_HISTORY_MAX_LINE_BYTES)}"}\n`
      );
      expect(
        (await itemsOf({ action: "read_item", item_id: "0" })).map((item) => item.text)
      ).toEqual(["opening facts"]);
    });
  }

  for (const mode of ["chunk", "initial page", "appended page"] as const) {
    for (const split of [1, 2, 3, 4, 5]) {
      test.each(
        [
          {
            name: "value",
            prefix: '","metadata":{"contextBoundaryKind":"',
            escape: "\\u0072",
            suffix: 'eset"},"tail":"',
          },
          {
            name: "colon",
            prefix: '","metadata":{"contextBoundaryKind"',
            escape: "\\u003a",
            suffix: '"reset"},"tail":"',
          },
          {
            name: "uppercase colon",
            prefix: '","metadata":{"contextBoundaryKind"',
            escape: "\\u003A",
            suffix: '"reset"},"tail":"',
          },
          {
            name: "hex value",
            prefix: '","metadata":{"contextBoundaryKind":"res',
            escape: "\\x65",
            suffix: 't"},"tail":"',
          },
          {
            name: "hex key",
            prefix: '","metadata":{"',
            escape: "\\x63",
            suffix: 'ontextBoundaryKind":"reset"},"tail":"',
          },
          {
            name: "hex colon",
            prefix: '","metadata":{"contextBoundaryKind"',
            escape: "\\x3A",
            suffix: '"reset"},"tail":"',
          },
          {
            name: "hex quote",
            prefix: '","metadata":{',
            escape: "\\x22",
            suffix: 'contextBoundaryKind":"reset"},"tail":"',
          },
        ]
          .filter((token) => split < token.escape.length)
          .map((token) => [token.name, token] as const)
      )(
        `escaped reset %s split after byte ${split} across a ${mode} boundary remains private`,
        async (_name, token) => {
          const appended = mode === "appended page";
          const saved = appended
            ? (await fixture.historyService.scanHistoryBounded(workspaceId, { visit: () => false }))
                .cursor
            : undefined;
          // Initial scans read one chat snapshot; resumed append checks read four.
          // Verify the resulting cursor offset below so fixture alignment is explicit.
          const distance =
            mode === "chunk"
              ? SESSION_HISTORY_SCAN_CHUNK_BYTES
              : SESSION_HISTORY_MAX_SCAN_BYTES -
                2 * HISTORY_PROVENANCE_MAX_RECEIPT_BYTES -
                SESSION_HISTORY_ANCHOR_BYTES * (appended ? 8 : 2);
          const publicLine =
            JSON.stringify(createMuxMessage("public-after-split", "assistant", "public facts")) +
            "\n";
          const suffix = token.suffix;
          const end = '"}\n' + publicLine;
          const padding = distance - (token.escape.length - split + suffix.length + end.length);
          const row =
            '{"id":"split-reset","role":"assistant","parts":[],"padding":"' +
            "x".repeat(2 * SESSION_HISTORY_MAX_LINE_BYTES) +
            token.prefix +
            token.escape +
            suffix +
            "x".repeat(padding) +
            end;
          await appendTrackedHistory(chatPath, row);
          const emitted: string[] = [];
          const visit = ({ message }: { message: MuxMessage }) => {
            emitted.push(message.id);
            return true;
          };
          const first = await fixture.historyService.scanHistoryBounded(workspaceId, {
            cursor: saved,
            visit,
          });
          expect(first.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
          expect(first.cursor).toBeDefined();
          if (mode === "chunk") expect(first.cursor?.possibleReset).toBe(true);
          else {
            const position = appended ? first.cursor?.appendCheck : first.cursor;
            expect(position?.byteOffset).toBe((await fs.stat(chatPath)).size - distance);
            expect(position?.possibleReset).toBe(false);
          }
          let cursor = first.cursor;
          let stale = false;
          let pageCount = 0;
          while (cursor) {
            try {
              const next = await fixture.historyService.scanHistoryBounded(workspaceId, {
                cursor,
                visit,
              });
              expect(next.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
              expect(next.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
              cursor = next.cursor;
            } catch (error) {
              expect(error).toMatchObject({ message: "stale_cursor" });
              stale = true;
              break;
            }
            expect(++pageCount).toBeLessThan(10);
          }
          expect(stale).toBe(appended);
          expect(emitted).toEqual(appended ? [] : ["public-after-split"]);
        }
      );
    }
  }

  test("oversized reset markers are a privacy floor, regardless of nested rollover metadata", async () => {
    const reset = createMuxMessage("oversized-reset", "assistant", "x".repeat(5 * 1024 * 1024), {
      contextBoundaryKind: "reset",
      muxMetadata: rollover.muxMetadata,
    });
    const raw = JSON.stringify(reset).replace(
      '"contextBoundaryKind":"reset"',
      '"contextBoundaryKind"' + " ".repeat(3 * 1024 * 1024) + '\t:  "reset"'
    );
    await appendTrackedHistory(
      chatPath,
      raw +
        "\n" +
        JSON.stringify(createMuxMessage("new", "assistant", "public after oversized reset")) +
        "\n"
    );
    expect(await readError("0")).toBe("item_not_found");
    expect((await itemsOf({ action: "search", query: "public" })).map((item) => item.text)).toEqual(
      ["public after oversized reset"]
    );
  });

  test("the tool's own result appended between chunks keeps the pinned snapshot; rotation restarts", async () => {
    await append("one", "match one");
    await seedFiller();
    await append("two", "match two");
    const previous = await complete({ action: "search", query: "match" });
    expect(previous.items?.map((item) => item.text)).toEqual(["match one", "match two"]);
    // Persisting a previous history result mid-read is an ordinary tracked append: no
    // restart, and the appended row (which contains "match") is past the pinned snapshot.
    const ownResult = mutateBetweenChunks(() =>
      append("tool-result", "", undefined, [
        {
          type: "dynamic-tool",
          toolCallId: "history",
          toolName: "session_history",
          state: "output-available",
          input: { action: "search" },
          output: previous,
        },
      ])
    );
    try {
      expect(await textsOf({ action: "search", query: "match" })).toEqual([
        "match one",
        "match two",
      ]);
    } finally {
      ownResult.restore();
    }
    expectIntermediate(ownResult);
    // A rollover boundary rotates chat into the archive: one restart from the fresh
    // baseline still answers; only a repeat during the restarted read is history_changed.
    const rotate = mutateBetweenChunks(() => append("roll", "", rollover));
    try {
      expect(await textsOf({ action: "search", query: "match" })).toEqual([
        "match one",
        "match two",
      ]);
    } finally {
      rotate.restore();
    }
    expectIntermediate(rotate);
    const twice = afterChunks(async (chunk) => {
      if (chunk <= 2) {
        await append(`roll-${chunk}`, "", rollover);
        await seedFiller(undefined, `after-roll-${chunk}`);
      }
    });
    try {
      expect(await call({ action: "search", query: "match" })).toEqual(CHANGED_RESULT);
    } finally {
      twice.restore();
    }
    expect(twice.chunks).toBe(2);
  });

  test("an in-place anchor mutation between chunks restarts once from the fresh baseline", async () => {
    await append("one", "match one");
    await seedFiller();
    await append("two", "match two");
    const seam = mutateBetweenChunks(async () => {
      const handle = await fs.open(chatPath, "r+");
      try {
        await handle.write(Buffer.from("!"), 0, 1, 0);
      } finally {
        await handle.close();
      }
    });
    try {
      // The first row ("opening facts") is malformed now; the rest is read from the new baseline.
      const result = await complete({ action: "search", query: "match" });
      expect(result.items?.map((item) => item.text)).toEqual(["match one", "match two"]);
      expect(result.warnings).toEqual(["malformed_rows_skipped"]);
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
  });

  test("a manual reset appended between chunks without rotation restarts behind it", async () => {
    await append("one", "match one");
    await seedFiller();
    await append("two", "match two");
    // Simulate a cross-process append without rotation: the reset must still
    // invalidate privacy, rather than relying on inode replacement as the gate.
    const seam = mutateBetweenChunks(() =>
      appendRawRows([manualReset("reset"), createMuxMessage("after", "assistant", "match after")])
    );
    try {
      expect(await textsOf({ action: "search", query: "match" })).toEqual(["match after"]);
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
  });

  test("below-watermark repaired and imported active rows survive bounded recovery chunks", async () => {
    const archived = await append("repaired-id", "archived facts");
    await append("archive-high", "higher archived facts");
    const boundary = await append("active-boundary", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const repaired = createMuxMessage(archived.id, "assistant", "repaired facts", {
      historySequence: archived.metadata!.historySequence,
    });
    const imported = createMuxMessage("unique-import", "assistant", "imported facts", {
      historySequence: 0,
    });
    await appendTrackedHistory(
      chatPath,
      [repaired, imported].map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    expect(await textsOf({ action: "search", query: "facts" })).toEqual([
      "opening facts",
      "archived facts",
      "higher archived facts",
      "repaired facts",
      "imported facts",
    ]);
    const activeWindow = `w:${String(boundary.metadata!.historySequence)}`;
    for (const [message, expected] of [
      [repaired, "repaired facts"],
      [imported, "imported facts"],
    ] as const) {
      expect(
        await textsOf({
          action: "read_item",
          item_id: String(message.metadata!.historySequence),
          window_id: activeWindow,
        })
      ).toEqual([expected]);
    }
  });

  test.each([false, true])(
    "rotation retries preserve a torn archive tail and every complete row (reset evidence: %s)",
    async (resetEvidence) => {
      await append("sealed", "sealed facts");
      if (resetEvidence) {
        await fs.writeFile(
          archivePath,
          Buffer.concat([
            Buffer.from(
              JSON.stringify(
                createMuxMessage("older-private", "assistant", "private archived facts")
              ) + "\n"
            ),
            Buffer.from(' {"metadata":{"contextBoundaryKind" : "reset"},'),
            Buffer.from([0xff]),
          ])
        );
      }
      const originalOpen = fs.open;
      let crashed = false;
      const writes: Array<{ mockRestore(): void }> = [];
      const opened = spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === archivePath && (args[1] === "a" || args[1] === "a+")) {
          const originalWrite = handle.writeFile.bind(handle);
          writes.push(
            spyOn(handle, "writeFile").mockImplementation(async (data, options) => {
              if (!crashed && Buffer.isBuffer(data)) {
                crashed = true;
                await originalWrite(data.subarray(0, data.indexOf(10) - 1), options);
                throw new Error("simulated partial archive publication");
              }
              return originalWrite(data, options);
            })
          );
        }
        return handle;
      });
      try {
        await append("first-boundary", "summary", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
        });
      } finally {
        for (const write of writes) write.mockRestore();
        opened.mockRestore();
      }
      expect(crashed).toBe(true);
      expect((await fs.readFile(chatPath, "utf8")).includes('"id":"first"')).toBe(true);
      const tornArchive = await fs.readFile(archivePath);
      expect(tornArchive.at(-1)).not.toBe(10);
      await append("retry-boundary", "latest summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 2,
      });
      const archived = await fs.readFile(archivePath);
      expect(archived.subarray(0, tornArchive.length)).toEqual(tornArchive);
      expect((await fs.readFile(chatPath, "utf8")).includes('"id":"first"')).toBe(false);
      expect(
        (await itemsOf({ action: "search", query: "facts" })).map((item) => item.text)
      ).toEqual(["opening facts", "sealed facts"]);
      const full: MuxMessage[] = [];
      expect(
        (
          await fixture.historyService.iterateFullHistory(workspaceId, "forward", (rows) => {
            full.push(...rows);
          })
        ).success
      ).toBe(true);
      for (const id of ["first", "sealed", "first-boundary", "retry-boundary"])
        expect(full.some((row) => row.id === id)).toBe(true);
    }
  );

  test("a readable structured tool result containing reset data does not hide earlier recovery rows", async () => {
    await append("tool-data", "", undefined, [
      {
        type: "dynamic-tool",
        toolCallId: "data",
        toolName: "bash",
        state: "output-available",
        input: {},
        output: { contextBoundaryKind: "reset", value: "tool facts" },
      },
    ]);
    await append("after-tool", "later facts");
    const found = await itemsOf({ action: "search", query: "facts" });
    expect(found.map((item) => item.text)).toContain("opening facts");
    expect(found.some((item) => item.text.includes("tool facts"))).toBe(true);
    expect(found.map((item) => item.text)).toContain("later facts");
  });

  test.each([false, true])(
    "ordinary append retry preserves accepted rows and raw reset privacy (reset: %s)",
    async (reset) => {
      await append("earlier", "earlier facts");
      const originalAppend = fs.appendFile;
      const torn = reset
        ? Buffer.concat([
            Buffer.from('{"metadata":{"contextBoundaryKind" : "reset"},'),
            Buffer.from([0xff]),
          ])
        : Buffer.from('{"id":"failed","role":"user","parts":[');
      const failed = spyOn(fs, "appendFile").mockImplementationOnce(async (target) => {
        await originalAppend(target, torn);
        throw new Error("simulated torn ordinary append");
      });
      try {
        expect(
          (
            await fixture.historyService.appendToHistory(
              workspaceId,
              createMuxMessage("failed", "user", "failed input")
            )
          ).success
        ).toBe(false);
      } finally {
        failed.mockRestore();
      }
      const before = await fs.readFile(chatPath);
      const accepted = createMuxMessage("accepted", "user", "accepted facts");
      expect((await fixture.historyService.appendToHistory(workspaceId, accepted)).success).toBe(
        true
      );
      await append("accepted-result", "result facts");
      expect((await fs.readFile(chatPath)).subarray(0, before.length)).toEqual(before);
      const history = await fixture.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((row) => row.id)).toEqual(
        reset
          ? ["accepted", "accepted-result"]
          : ["first", "earlier", "accepted", "accepted-result"]
      );
      expect(
        (await itemsOf({ action: "search", query: "facts" })).map((item) => item.text)
      ).toEqual(
        reset
          ? ["accepted facts", "result facts"]
          : ["opening facts", "earlier facts", "accepted facts", "result facts"]
      );
    }
  );

  test("potential crash replays remain visible without exact duplicate proof", async () => {
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
    // A sequence watermark cannot prove these are exact replays. Conservatively
    // return both physical copies rather than hiding repaired/imported rows.
    expect(await itemsOf({ action: "search", query: "identical content" })).toHaveLength(4);
  });

  test("aggregate encoded result, Unicode, and markers fit the output budget", async () => {
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
    // 25 escaped 500-character snippets exceed 16 KiB: the response fills before the limit.
    const capped = await complete(
      { action: "search", query: "needle", limit: 25 },
      { hasMore: true }
    );
    expect(capped.items!.length).toBeGreaterThan(1);
    expect(capped.items!.length).toBeLessThan(25);
    expect(
      await itemsOf(
        { action: "search", query: "needle", limit: 25, max_chars_per_item: 20 },
        { hasMore: true }
      )
    ).toHaveLength(25);
    expect(
      await itemsOf(
        { action: "search", query: "needle", limit: 5, max_chars_per_item: 20, recent_first: true },
        { hasMore: true }
      )
    ).toHaveLength(5);
  });
});

describe("session_history item listing and filters", () => {
  const toolPart = (
    toolName: string,
    extra?: {
      input?: unknown;
      output?: unknown;
      nestedCalls?: Array<{ toolCallId: string; toolName: string; state: "output-available" }>;
    }
  ): MuxMessage["parts"][number] => {
    const part: MuxMessage["parts"][number] = {
      type: "dynamic-tool",
      toolCallId: `${toolName}-call`,
      toolName,
      state: "output-available",
      input: extra?.input ?? {},
      output: extra?.output ?? { ok: true },
      nestedCalls: extra?.nestedCalls,
    };
    return part;
  };

  test("unfiltered listing returns rows in persisted order and every ID round-trips", async () => {
    const user = createMuxMessage("ask", "user", "please list");
    expect((await fixture.historyService.appendToHistory(workspaceId, user)).success).toBe(true);
    await append("reply", "listed");
    await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
    await append("after", "post reset");
    const all = await itemsOf({ action: "list_items" });
    // "first" is seeded by beforeEach; the manual reset hides everything before it.
    expect(all.map((item) => item.text)).toEqual(["post reset"]);
    const rooted = await itemsOf({ action: "list_items", window_id: "w:0" });
    expect(rooted).toEqual([]);
    for (const item of all) {
      const read = await call({ action: "read_item", item_id: item.itemId });
      expect(read.items?.[0]).toMatchObject({ itemId: item.itemId, role: item.role });
    }
  });

  test("listing preserves order and roles without a reset", async () => {
    const user = createMuxMessage("ask", "user", "please list");
    expect((await fixture.historyService.appendToHistory(workspaceId, user)).success).toBe(true);
    await append("reply", "listed");
    const all = await itemsOf({ action: "list_items" });
    expect(all.map((item) => [item.role, item.text])).toEqual([
      ["assistant", "opening facts"],
      ["user", "please list"],
      ["assistant", "listed"],
    ]);
  });

  test("role, exact tool name, nested tool and query filters combine with AND semantics", async () => {
    const user = createMuxMessage("ask", "user", "run bash now");
    expect((await fixture.historyService.appendToHistory(workspaceId, user)).success).toBe(true);
    await append("bash-row", "ran bash", undefined, [
      { type: "text", text: "ran bash" },
      toolPart("bash"),
    ]);
    await append("bashful-row", "ran other", undefined, [toolPart("bash_extra")]);
    await append("nested-row", "nested", undefined, [
      toolPart("code_execution", {
        nestedCalls: [{ toolCallId: "n1", toolName: "file_read", state: "output-available" }],
      }),
    ]);
    await append("decoy-row", "decoy", undefined, [
      toolPart("bash_other", {
        input: { toolName: "file_read" },
        output: { nestedCalls: [{ toolName: "file_read" }], value: '{"toolName":"file_read"}' },
      }),
    ]);
    await append("history-row", "", undefined, [toolPart("session_history")]);
    await append("hidden-row", "", { synthetic: true }, [toolPart("bash")]);
    const texts = async (input: SessionHistoryArgs) =>
      (await itemsOf(input)).map((item) => item.text);
    expect(await texts({ action: "list_items", role: "user" })).toEqual(["run bash now"]);
    expect(await texts({ action: "list_items", role: "system" })).toEqual([]);
    const bashRows = await texts({ action: "list_items", tool_name: "bash" });
    expect(bashRows).toHaveLength(1);
    expect(bashRows[0]).toContain("ran bash");
    const nestedRows = await texts({ action: "list_items", tool_name: "file_read" });
    expect(nestedRows).toHaveLength(1);
    expect(nestedRows[0]).toContain("code_execution");
    expect(await texts({ action: "list_items", tool_name: "session_history" })).toEqual([]);
    expect(await texts({ action: "list_items", tool_name: "bash", role: "user" })).toEqual([]);
    const searchedBash = await texts({ action: "search", query: "bash", tool_name: "bash" });
    expect(searchedBash).toHaveLength(1);
    expect(searchedBash[0]).toContain("ran bash");
    expect(await texts({ action: "search", query: "bash", role: "user" })).toEqual([
      "run bash now",
    ]);
    expect(await texts({ action: "search", query: "nested", tool_name: "bash" })).toEqual([]);
  });

  test("max_chars_per_item bounds snippets, keeps matches visible, and continues via read_item", async () => {
    const row = await append("long", `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`);
    const listed = await call({ action: "list_items", max_chars_per_item: 10 });
    expect(listed.items?.map((item) => item.text)).toEqual(["opening fa", "a".repeat(10)]);
    expect(listed.items?.[1]?.nextCharOffset).toBe(10);
    const searched = await call({ action: "search", query: "needle", max_chars_per_item: 8 });
    expect(searched.items).toHaveLength(1);
    expect(searched.items![0].text).toBe("aaaaNEED");
    expect(searched.items![0].nextCharOffset).toBe(304);
    const wide = await call({ action: "search", query: "needle" });
    expect(wide.items![0].text.indexOf("NEEDLE")).toBe(120);
    await append("emoji", "😀".repeat(4));
    // A one-unit allowance at an astral character still returns the whole pair.
    const paired = await call({ action: "list_items", max_chars_per_item: 1 });
    expect(paired.items?.map((item) => item.text)).toEqual(["o", "a", "😀"]);
    expect(paired.items?.at(-1)?.nextCharOffset).toBe(2);
    const rest = await call({
      action: "read_item",
      item_id: String(row.metadata!.historySequence),
      offset_chars: 10,
      limit_chars: 290,
    });
    expect(rest.items?.[0]?.text).toBe("a".repeat(290));
    expect(rest.items?.[0]?.nextCharOffset).toBe(300);
  });

  test("filters are rejected on actions that cannot honor them", async () => {
    for (const input of [
      { action: "list_windows", role: "user" },
      { action: "list_windows", max_chars_per_item: 5 },
      { action: "read_item", item_id: "1", tool_name: "bash" },
      { action: "read_item", item_id: "1", max_chars_per_item: 5 },
    ] as SessionHistoryArgs[]) {
      expect(await call(input)).toMatchObject({ success: false, error: "filters_unsupported" });
    }
    expect(() =>
      TOOL_DEFINITIONS.session_history.schema.parse({ action: "list_items", tool_name: "" })
    ).toThrow();
    expect(() =>
      TOOL_DEFINITIONS.session_history.schema.parse({ action: "list_items", role: "tool" })
    ).toThrow();
  });

  test("sparse filtered matches complete within one call without materializing the rest", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      createMuxMessage(`row-${i}`, i === 1150 ? "user" : "assistant", `row ${i}`, {
        historySequence: 100 + i,
      })
    );
    await appendRawRows(rows);
    // Floor discovery plus browsing 1200 rows spans several chunks; the single filtered
    // match is delivered once, exhaustively.
    expect(await textsOf({ action: "list_items", role: "user" })).toEqual(["row 1150"]);
    expect(scanned.length).toBeGreaterThan(2);
    // has_more is exact: a further match beyond the limit exists here, not in the sparse case.
    expect(
      await textsOf({ action: "list_items", role: "assistant", limit: 2 }, { hasMore: true })
    ).toEqual(["opening facts", "row 0"]);
    expect(
      await textsOf(
        { action: "list_items", role: "assistant", limit: 2, recent_first: true },
        { hasMore: true }
      )
    ).toEqual(["row 1199", "row 1198"]);
    expect(await textsOf({ action: "list_items", tool_name: "bash" })).toEqual([]);
    expect(
      (
        await complete(
          { action: "list_items", role: "assistant", max_chars_per_item: 5, limit: 1 },
          { hasMore: true }
        )
      ).items?.[0]?.text
    ).toBe("openi");
  });
});

describe("session_history newest-first browsing", () => {
  const row = (
    id: string,
    text: string,
    metadata?: MuxMetadata,
    role: "user" | "assistant" = "assistant"
  ) => JSON.stringify(createMuxMessage(id, role, text, metadata));
  const compaction = (epoch: number, sequence?: number): MuxMetadata => ({
    compacted: true,
    compactionBoundary: true,
    compactionEpoch: epoch,
    ...(sequence === undefined ? {} : { historySequence: sequence }),
  });
  /**
   * Archive + active files with a manual reset floor, rollover and compaction
   * boundaries, malformed and oversized rows, an unaddressable window, and a
   * window (C1) that starts in the archive and continues into the active file.
   */
  async function writeMixedFixture() {
    await fs.writeFile(
      archivePath,
      [
        row("private", "private before reset", { historySequence: 1 }),
        row("manual-reset", "", {
          contextBoundaryKind: "reset",
          synthetic: true,
          historySequence: 10,
        }),
        row("a1", "alpha one", { historySequence: 11 }, "user"),
        "{broken",
        row("r1", "", { ...rollover, historySequence: 20 }),
        row("a4", "alpha two", { historySequence: 21 }),
        row("a5", "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 16), { historySequence: 22 }),
        row("c1", "summary one", compaction(1, 30)),
        row("a7", "beta", { historySequence: 31 }, "user"),
      ].join("\n") + "\n"
    );
    await fs.writeFile(
      chatPath,
      [
        row("ch1", "gamma", { historySequence: 32 }),
        row("u".repeat(SESSION_HISTORY_MAX_ID_CHARS + 8), "unaddressable summary", compaction(2)),
        row("hidden", "hidden in unaddressable window", { historySequence: 40 }),
        row("c3", "summary three", compaction(3, 50)),
        row("d1", "delta", { historySequence: 51 }, "user"),
        row("e1", "epsilon", { historySequence: 52 }),
      ].join("\n") +
        "\n" +
        // A torn trailing row (crash mid-append) is malformed in both directions.
        '{"id":"torn","role":"assistant","metadata":{"historySequence":53},"parts":[{"type":"text","text":"to'
    );
  }
  const collect = async (input: SessionHistoryArgs) => {
    const result = await complete(input);
    return { items: result.items ?? [], windows: result.windows ?? [] };
  };

  test("reverse listing, search and windows equal the reversed forward walk on a mixed fixture", async () => {
    await writeMixedFixture();
    const forward = await collect({ action: "list_items" });
    expect(forward.items.map((item) => item.text)).toEqual([
      "alpha one",
      "alpha two",
      "summary one",
      "beta",
      "gamma",
      "summary three",
      "delta",
      "epsilon",
    ]);
    expect(forward.items.map((item) => item.windowId)).toEqual([
      "w:10",
      "w:20",
      "w:30",
      "w:30",
      "w:30",
      "w:50",
      "w:50",
      "w:50",
    ]);
    const reverse = await collect({ action: "list_items", recent_first: true });
    expect(reverse.items).toEqual([...forward.items].reverse());
    // Floor discovery, span discovery and delivery each re-read the oversized row.
    expect(scanned.length).toBeGreaterThan(1);
    const forwardWindows = await collect({ action: "list_windows" });
    const reverseWindows = await collect({ action: "list_windows", recent_first: true });
    // Counts skip the hidden reset/rollover rows, the malformed and oversized rows, and the
    // unaddressable window; w:30 spans the archive/chat seam as one run.
    expect(forwardWindows.windows).toEqual([
      { windowId: "w:10", boundaryKind: "reset", itemCount: 1 },
      { windowId: "w:20", boundaryKind: "reset", itemCount: 1 },
      { windowId: "w:30", boundaryKind: "compaction", itemCount: 3 },
      { windowId: "w:50", boundaryKind: "compaction", itemCount: 3 },
    ]);
    expect(reverseWindows.windows).toEqual([...forwardWindows.windows].reverse());
    const forwardSearch = await collect({ action: "search", query: "a", role: "user" });
    const reverseSearch = await collect({
      action: "search",
      query: "a",
      role: "user",
      recent_first: true,
    });
    expect(reverseSearch.items).toEqual([...forwardSearch.items].reverse());
    expect(reverseSearch.items.map((item) => item.text)).toEqual(["delta", "beta", "alpha one"]);
    const scoped = await collect({ action: "list_items", window_id: "w:30", recent_first: true });
    expect(scoped.items.map((item) => item.text)).toEqual(["gamma", "beta", "summary one"]);
    for (const item of reverse.items) {
      const read = (await collect({ action: "read_item", item_id: item.itemId })).items;
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({ itemId: item.itemId, windowId: item.windowId });
    }
    expect(
      (await collect({ action: "search", query: "private", recent_first: true })).items
    ).toEqual([]);
    expect(
      (await collect({ action: "search", query: "hidden in", recent_first: true })).items
    ).toEqual([]);
  });

  test("a window larger than one scan chunk is discovered before any of its rows are delivered", async () => {
    const boundary = createMuxMessage("big-window", "assistant", "big summary", compaction(1, 100));
    const tail = Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 100 }, (_, i) =>
      createMuxMessage(`tail-${i}`, "assistant", `public-${i}`, { historySequence: 101 + i })
    );
    await appendTrackedHistory(
      chatPath,
      [boundary, ...tail].map((message) => JSON.stringify(message)).join("\n") + "\n"
    );
    const items = await itemsOf(
      { action: "list_items", limit: 25, recent_first: true },
      { hasMore: true }
    );
    // Floor discovery and span discovery each need more than one chunk before delivery starts;
    // every delivered row is attributed to the fully discovered window.
    expect(scanned.length).toBeGreaterThan(2);
    expect(items).toHaveLength(25);
    expect(items[0]).toMatchObject({ text: `public-${tail.length - 1}`, windowId: "w:100" });
    expect(items.every((item) => item.windowId === "w:100")).toBe(true);
    expect(await textsOf({ action: "list_items", window_id: "w:0", recent_first: true })).toEqual([
      "opening facts",
    ]);
    expect(
      await itemsOf({ action: "search", query: "big summary", recent_first: true })
    ).toMatchObject([{ text: "big summary", windowId: "w:100" }]);
    const windows = await windowsOf({ action: "list_windows", recent_first: true });
    expect(windows).toEqual([
      { windowId: "w:100", boundaryKind: "compaction", itemCount: tail.length + 1 },
      { windowId: "w:0", boundaryKind: "root", itemCount: 1 },
    ]);
  });

  test("reverse reads keep the pinned snapshot across appends and restart on resets, rewrites and rotation", async () => {
    await append("two", "ordinal second");
    await append("three", "ordinal third");
    await seedFiller();
    const reverse = { action: "search", query: "ordinal", recent_first: true } as const;
    // Ordinary appends keep the retrieval snapshot fixed: the new row is not exposed.
    const appended = mutateBetweenChunks(() => append("four", "ordinal fourth"));
    try {
      expect(await textsOf(reverse)).toEqual(["ordinal third", "ordinal second"]);
    } finally {
      appended.restore();
    }
    expectIntermediate(appended);
    // A fresh newest-first scan sees the appended row first.
    expect(await textsOf(reverse)).toEqual(["ordinal fourth", "ordinal third", "ordinal second"]);
    const reset = mutateBetweenChunks(async () => {
      await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
      await append("five", "ordinal fifth");
      await seedFiller(undefined, "after-reset");
    });
    try {
      expect(await textsOf(reverse)).toEqual(["ordinal fifth"]);
    } finally {
      reset.restore();
    }
    expectIntermediate(reset);
    const rotated = mutateBetweenChunks(async () => {
      await append("six", "ordinal sixth");
      await append("rotate", "summary", compaction(1));
    });
    try {
      expect(await textsOf(reverse)).toEqual(["ordinal sixth", "ordinal fifth"]);
    } finally {
      rotated.restore();
    }
    expectIntermediate(rotated);
    const rewritten = mutateBetweenChunks(async () => {
      const handle = await fs.open(chatPath, "r+");
      try {
        await handle.write(Buffer.from("!"), 0, 1, 0);
      } finally {
        await handle.close();
      }
    });
    try {
      expect(await textsOf(reverse)).toEqual(["ordinal sixth", "ordinal fifth"]);
    } finally {
      rewritten.restore();
    }
    expectIntermediate(rewritten);
    expect(await call({ action: "read_item", item_id: "1", recent_first: true })).toMatchObject({
      success: false,
      error: "filters_unsupported",
    });
  });
});

describe("session_history descendant task history", () => {
  const childId = "child-task";
  const grandchildId = "grandchild-task";
  const removedChildId = "removed-child";
  // Ancestry itself is TaskService's contract; the tool must consult it on every foreign
  // call, treat anything but a live branch as denied/unavailable, and then prove that the
  // caller's current privacy segment created the branch root.
  const relation = (ancestor: string, task: string) => {
    if (ancestor !== workspaceId) return { status: "unrelated" as const };
    if (task === childId || task === grandchildId)
      return { status: "live" as const, branchRootTaskId: childId };
    if (task === removedChildId) return { status: "removed" as const };
    return { status: "unrelated" as const };
  };
  const taskService = {
    resolveDescendantAgentTaskBranchRoot: (ancestor: string, task: string) =>
      Promise.resolve(relation(ancestor, task)),
  } as unknown as TaskService;
  const callAs = async (
    input: SessionHistoryArgs,
    options?: { caller?: string; taskService?: TaskService | null }
  ) => {
    const config = createTestToolConfig(fixture.tempDir, {
      workspaceId: options?.caller ?? workspaceId,
    });
    config.historyService = fixture.historyService;
    if (options?.taskService !== null) config.taskService = options?.taskService ?? taskService;
    const tool = createSessionHistoryTool(config);
    return TOOL_DEFINITIONS.session_history.resultSchema.parse(
      await tool.execute!(input, mockToolCallOptions)
    );
  };
  const appendTo = async (workspace: string, id: string, text: string, metadata?: MuxMetadata) => {
    const message = createMuxMessage(id, "assistant", text, metadata);
    expect((await fixture.historyService.appendToHistory(workspace, message)).success).toBe(true);
    return message;
  };
  const appendChild = (id: string, text: string, metadata?: MuxMetadata) =>
    appendTo(childId, id, text, metadata);
  const taskPart = (
    toolName: string,
    output: unknown,
    nested = false
  ): MuxMessage["parts"][number] =>
    nested
      ? {
          type: "dynamic-tool",
          toolCallId: "ptc",
          toolName: "code_execution",
          state: "output-available",
          input: {},
          output: {},
          nestedCalls: [{ toolCallId: "nested", toolName, state: "output-available", output }],
        }
      : {
          type: "dynamic-tool",
          toolCallId: `${toolName}-call`,
          toolName,
          state: "output-available",
          input: {},
          output,
        };
  // A canonical `task` creation receipt in the caller's transcript.
  const appendSpawnPart = async (part: MuxMessage["parts"][number], workspace = workspaceId) => {
    const message = createMuxMessage(`spawn-${Math.random()}`, "assistant", "", undefined, [part]);
    expect((await fixture.historyService.appendToHistory(workspace, message)).success).toBe(true);
  };
  const spawn = (taskIds: string[], nested = false, workspace = workspaceId) =>
    appendSpawnPart(
      taskPart("task", { status: "completed", taskIds, note: "done" }, nested),
      workspace
    );
  const sessionDir = (id: string) => path.join(fixture.config.sessionsDir, id);
  const expectNoSession = async (id: string) =>
    expect(
      await fs.stat(sessionDir(id)).then(
        () => "exists",
        (error: NodeJS.ErrnoException) => error.code
      )
    ).toBe("ENOENT");

  const childReads = () => scanned.filter((scan) => scan === childId).length;
  const completeAs = async (input: SessionHistoryArgs, hasMore = false) => {
    const result = await callAs(input);
    expect(result).toMatchObject({ success: true, has_more: hasMore });
    return result;
  };
  // Untracked bulk rows in the target: a fresh target read spans several chunks.
  const seedChildFiller = (prefix: string) =>
    fs.appendFile(
      path.join(sessionDir(childId), "chat.jsonl"),
      filler(undefined, prefix)
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n"
    );
  const largeCallerAppend = () =>
    appendRawRows(
      Array.from({ length: 650 }, (_, index) =>
        createMuxMessage(`later-${index}`, "assistant", "later " + "z".repeat(4096))
      )
    );

  test("rows the caller authorization scan had to skip are reported as warnings", async () => {
    await appendRawRows([
      "not-json",
      createMuxMessage("huge", "assistant", "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 10)),
    ]);
    await spawn([childId]);
    await appendChild("child-one", "child one");
    const result = await completeAs({ action: "list_items", task_id: childId });
    expect(result.items?.map((item) => item.text)).toEqual(["child one"]);
    expect(result.warnings?.toSorted()).toEqual([
      "malformed_rows_skipped",
      "oversized_rows_skipped",
    ]);
    // The target itself is clean; the codes came from the caller's authorization scan.
    expect((await completeAs({ action: "list_items" })).warnings?.toSorted()).toEqual([
      "malformed_rows_skipped",
      "oversized_rows_skipped",
    ]);
    await appendChild("child-two", "child two");
    expect(
      (await completeAs({ action: "list_items", task_id: childId, role: "user" })).warnings
    ).toContain("oversized_rows_skipped");
  });

  test("a receipt found in a chunk with an unfinished caller scan authorizes that same chunk", async () => {
    // The caller's floor discovery needs a second chunk; the receipt is browsed in chunk 2
    // with rows still ahead of it, so the caller scan stays resumable (auth.cursor set).
    await spawn([childId]);
    await seedFiller();
    await appendChild("child-one", "child one");
    expect(
      (await completeAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child one"]);
    // Chunk 1 ended inside discovery and read no target rows; chunk 2 proved and read.
    expect(scanned).toEqual([workspaceId, workspaceId, childId]);
  });

  test("a proven authorization whose append check is unfinished reads no target rows that chunk", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await seedChildFiller("bulk");
    await appendChild("child-two", "child two");
    const seam = mutateBetweenChunks(largeCallerAppend);
    let result: SessionHistoryResult;
    try {
      result = await completeAs(
        { action: "list_items", task_id: childId, role: "assistant", limit: 25 },
        true
      );
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
    expect(result.items?.[0]?.text).toBe("child one");
    // Chunk 1: proof + target. Chunk 2: the 2.6 MiB append check exhausts the chunk budget, no
    // target read. Chunk 3: the check completes, then the target read resumes.
    expect(scanned.slice(0, 5)).toEqual([workspaceId, childId, workspaceId, workspaceId, childId]);
  });

  test("a caller reset appended between chunks denies the read after the restart", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await seedChildFiller("bulk");
    const seam = mutateBetweenChunks(() =>
      append("caller-reset", "", { contextBoundaryKind: "reset", synthetic: true })
    );
    try {
      expect(await callAs({ action: "list_items", task_id: childId })).toEqual({
        success: false,
        error: "task_not_found",
      });
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
    expect(childReads()).toBe(1);
  });

  test("target rotation between chunks restarts once, then reports history_changed", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await seedChildFiller("bulk");
    const rotate = (id: string) => appendChild(id, "", rollover);
    const once = mutateBetweenChunks(() => rotate("roll-once"));
    try {
      expect(
        (await completeAs({ action: "search", query: "child one", task_id: childId })).items?.map(
          (item) => item.text
        )
      ).toEqual(["child one"]);
    } finally {
      once.restore();
    }
    expectIntermediate(once);
    await seedChildFiller("bulk-more");
    const twice = afterChunks(async (chunk) => {
      if (chunk > 2) return;
      await rotate(`roll-${chunk}`);
      // Keep the restarted read multi-chunk so the second rotation lands between its chunks.
      await seedChildFiller(`bulk-after-${chunk}`);
    });
    try {
      expect(await callAs({ action: "search", query: "child one", task_id: childId })).toEqual(
        CHANGED_RESULT
      );
    } finally {
      twice.restore();
    }
    expect(twice.chunks).toBe(2);
  });

  test("a caller append check unfinished at the deadline is history_timeout", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await seedChildFiller("bulk");
    const clock = fakeClock();
    const seam = afterChunks(async (chunk) => {
      if (chunk === 1) await largeCallerAppend();
      if (chunk === 2) clock.set(SESSION_HISTORY_TOOL_DEADLINE_MS + 1);
    });
    try {
      expect(await callAs({ action: "list_items", task_id: childId })).toEqual(TIMEOUT_RESULT);
    } finally {
      seam.restore();
      clock.restore();
    }
    expect(seam.chunks).toBe(2);
    expect(scanned).toEqual([workspaceId, childId, workspaceId]);
  });

  test("reads a descendant's retained history behind its own reset floor and never the caller's rows", async () => {
    await spawn([childId]);
    await appendChild("child-private", "child private facts");
    await appendChild("child-reset", "", { contextBoundaryKind: "reset", synthetic: true });
    const visible = await appendChild("child-public", "child public facts");
    const listed = await callAs({ action: "list_items", task_id: childId });
    expect(listed.success).toBe(true);
    expect(listed.items?.map((item) => item.text)).toEqual(["child public facts"]);
    expect(
      (await callAs({ action: "search", query: "facts", task_id: childId })).items
    ).toHaveLength(1);
    expect(
      (await callAs({ action: "search", query: "child private", task_id: childId })).items
    ).toEqual([]);
    const read = await callAs({
      action: "read_item",
      task_id: childId,
      item_id: String(visible.metadata!.historySequence),
    });
    expect(read.items?.[0]?.text).toBe("child public facts");
    expect(
      (await callAs({ action: "list_items", task_id: childId, recent_first: true })).items?.map(
        (item) => item.text
      )
    ).toEqual(["child public facts"]);
    // The caller's own history is unaffected by the target parameter.
    const own = (await callAs({ action: "list_items" })).items?.map((item) => item.text);
    expect(own).toEqual(["opening facts", expect.stringContaining("child-task")]);
    expect(
      (await callAs({ action: "list_items", task_id: workspaceId })).items?.map((item) => item.text)
    ).toEqual(own);
  });

  test("a caller reset revokes earlier branches; grandchildren and PTC-nested receipts are covered", async () => {
    await appendChild("child-row", "child facts from the old segment");
    await appendTo(grandchildId, "grandchild-row", "grandchild facts");
    await spawn([childId]);
    expect((await callAs({ action: "list_items", task_id: childId })).success).toBe(true);
    // Grandchild: only the branch root (the child) needs a receipt in the caller's transcript.
    expect(
      (await callAs({ action: "list_items", task_id: grandchildId })).items?.map((i) => i.text)
    ).toEqual(["grandchild facts"]);
    await append("caller-reset", "", { contextBoundaryKind: "reset", synthetic: true });
    for (const target of [childId, grandchildId])
      expect(await callAs({ action: "list_items", task_id: target })).toMatchObject({
        success: false,
        error: "task_not_found",
      });
    // Mentions that are not creation receipts never authorize.
    await append("mention", `see ${childId}`);
    await appendSpawnPart(taskPart("task_list", { tasks: [{ taskId: childId }] }));
    await appendSpawnPart(taskPart("task_await", { results: [{ taskId: childId }] }));
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
    await spawn(["other-task", childId], true);
    expect(
      (await callAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child facts from the old segment"]);
    // Archive-only retained history is still readable.
    await fs.rename(
      path.join(sessionDir(childId), "chat.jsonl"),
      path.join(sessionDir(childId), "chat-archive.jsonl")
    );
    expect(
      (await callAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child facts from the old segment"]);
  });

  test("authorization is proven across chunks and revalidated before later target chunks", async () => {
    await seedFiller(SESSION_HISTORY_MAX_SCAN_ROWS + 50);
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await seedChildFiller("bulk");
    await appendChild("child-two", "child two");
    // The caller's floor discovery and receipt search need more than one chunk, and the
    // target read spans chunks too; the call still answers completely.
    const listed = await completeAs({ action: "search", query: "child", task_id: childId });
    expect(listed.items?.map((item) => item.text)).toEqual(["child one", "child two"]);
    expect(scanned.slice(0, 2)).toEqual([workspaceId, workspaceId]);
    expect(childReads()).toBeGreaterThan(1);
    // A proven authorization keeps working across ordinary caller appends between chunks
    // (re-checked before every later target chunk), but a caller reset appended between
    // chunks restarts the read, which is then denied; so is a fresh call.
    const later = mutateBetweenChunks(() => append("caller-later", "later caller row"));
    try {
      expect(
        (await completeAs({ action: "search", query: "child", task_id: childId })).items?.map(
          (item) => item.text
        )
      ).toEqual(["child one", "child two"]);
    } finally {
      later.restore();
    }
    expectIntermediate(later);
    const reset = mutateBetweenChunks(() =>
      append("caller-reset", "", { contextBoundaryKind: "reset", synthetic: true })
    );
    try {
      expect(await callAs({ action: "search", query: "child", task_id: childId })).toEqual({
        success: false,
        error: "task_not_found",
      });
    } finally {
      reset.restore();
    }
    expectIntermediate(reset);
    expect(await callAs({ action: "list_items", task_id: childId })).toEqual({
      success: false,
      error: "task_not_found",
    });
  });

  test("partial receipts wait for settlement; legacy PTC and deeply nested receipts are bounded", async () => {
    await appendChild("child-row", "child facts");
    // Same-turn spawn: the receipt lives only in the caller's partial message until stream end.
    const inFlight = createMuxMessage("in-flight", "assistant", "", undefined, [
      taskPart("task", { status: "running", taskId: childId, note: "await it" }),
    ]);
    await fixture.historyService.writePartial(workspaceId, inFlight);
    // The partial is never read (unbounded, not a settled receipt): denied until the turn ends.
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
    await appendChild("child-two", "child two");
    await fixture.historyService.deletePartial(workspaceId);
    await appendSpawnPart(inFlight.parts[0]);
    expect(
      (await callAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child facts", "child two"]);
    await append("caller-reset", "", { contextBoundaryKind: "reset", synthetic: true });
    // Legacy PTC persistence: nested calls only inside code_execution's output.toolCalls.
    await appendSpawnPart(
      taskPart("code_execution", {
        toolCalls: [
          { toolName: "task", duration_ms: 3, result: { status: "completed", taskId: childId } },
        ],
      })
    );
    expect(
      (await callAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child facts", "child two"]);
    // A pathologically nested row neither authorizes nor crashes the scan.
    let deep: Record<string, unknown> = { toolName: "task", output: { taskId: grandchildId } };
    for (let i = 0; i < 200; i++)
      deep = {
        toolCallId: `n${i}`,
        toolName: "code_execution",
        state: "output-available",
        nestedCalls: [deep],
      };
    await appendSpawnPart(deep as unknown as MuxMessage["parts"][number]);
    await appendTo(grandchildId, "grandchild-row", "grandchild facts");
    // grandchild resolves to the child branch root, which IS proven; the deep row is just skipped.
    expect(
      (await callAs({ action: "list_items", task_id: grandchildId })).items?.map((i) => i.text)
    ).toEqual(["grandchild facts"]);
    expect((await callAs({ action: "list_items", task_id: childId })).success).toBe(true);
  });

  test("foreign toolCalls never authorize and a racing caller reset waits for the chunk", async () => {
    await appendChild("child-row", "child facts");
    // Legacy toolCalls only count inside code_execution results; other tools' output is data.
    await appendSpawnPart(
      taskPart("mcp_structured", {
        toolCalls: [{ toolName: "task", duration_ms: 1, result: { taskId: childId } }],
      })
    );
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
    // A caller reset racing the read (another backend) cannot slip between the authorization
    // scan and the target scan: the caller's history locks are held across both, so the reset
    // is serialized after the page and the NEXT call is denied.
    await spawn([childId]);
    let resetSettled = false;
    let pendingReset: Promise<unknown> | undefined;
    beforeScan = (workspace) => {
      // Started while the caller's locks are held: the writer must wait for the chunk.
      if (workspace === childId && !pendingReset)
        pendingReset = append("foreign-reset", "", {
          contextBoundaryKind: "reset",
          synthetic: true,
        }).then(() => {
          resetSettled = true;
        });
    };
    try {
      const raced = await callAs({ action: "list_items", task_id: childId });
      expect(resetSettled).toBe(false);
      expect(raced.items?.map((item) => item.text)).toEqual(["child facts"]);
    } finally {
      beforeScan = undefined;
    }
    await pendingReset;
    expect(resetSettled).toBe(true);
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
  });

  test("large caller appends between proven chunks are re-checked in-process before publication", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await seedChildFiller("bulk");
    await appendChild("child-two", "child two");
    // SESSION_HISTORY_MAX_SCAN_ROWS + 100 appended caller rows: the append check needs more
    // than one chunk (by rows), none of which reads the target.
    const seam = mutateBetweenChunks(() =>
      appendRawRows(
        Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 100 }, (_, i) =>
          createMuxMessage(`later-${i}`, "assistant", `later ${i}`, { historySequence: 5000 + i })
        )
      )
    );
    try {
      expect(
        (await completeAs({ action: "search", query: "child", task_id: childId })).items?.map(
          (item) => item.text
        )
      ).toEqual(["child one", "child two"]);
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
    expect(scanned.slice(0, 5)).toEqual([workspaceId, childId, workspaceId, workspaceId, childId]);
  });

  test("unauthorized, unknown and unavailable targets fail closed without creating sessions", async () => {
    await spawn([childId, removedChildId, "sibling-workspace", "unknown"]);
    await appendChild("child-row", "child facts");
    for (const target of ["sibling-workspace", "unknown"]) {
      expect(await callAs({ action: "list_items", task_id: target })).toMatchObject({
        success: false,
        error: "task_not_found",
      });
      await expectNoSession(target);
    }
    // A sibling caller cannot use the parent's descendant, and no taskService means no access.
    expect(
      await callAs({ action: "list_items", task_id: childId }, { caller: "sibling-workspace" })
    ).toMatchObject({ success: false, error: "task_not_found" });
    expect(
      await callAs({ action: "list_items", task_id: childId }, { taskService: null })
    ).toMatchObject({ success: false, error: "task_not_found" });
    const failing = {
      resolveDescendantAgentTaskBranchRoot: () => Promise.reject(new Error("config unavailable")),
    } as unknown as TaskService;
    expect(
      await callAs({ action: "list_items", task_id: childId }, { taskService: failing })
    ).toMatchObject({ success: false, error: "task_not_found" });
    // Removed descendant (tombstone/report evidence only): distinguishable, never created.
    expect(await callAs({ action: "list_items", task_id: removedChildId })).toMatchObject({
      success: false,
      error: "session_unavailable",
    });
    await expectNoSession(removedChildId);
    // A live descendant whose files are gone is unavailable too, and never created.
    await fs.rm(sessionDir(grandchildId), { recursive: true, force: true });
    expect(await callAs({ action: "list_items", task_id: grandchildId })).toMatchObject({
      success: false,
      error: "session_unavailable",
    });
    await expectNoSession(grandchildId);
  });

  test("removal between chunks fails closed without data or a created session", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await seedChildFiller("bulk");
    await appendChild("child-two", "child two");
    expect(
      (await completeAs({ action: "search", query: "child", task_id: childId })).items?.map(
        (item) => item.text
      )
    ).toEqual(["child one", "child two"]);
    // Removal publishes its tombstone under the history lock before deleting files; a read
    // that already delivered rows internally discards them.
    const readsBefore = childReads();
    const seam = mutateBetweenChunks(async () => {
      await fs.mkdir(path.dirname(workspaceRemovalTombstonePath(fixture.config.rootDir, childId)), {
        recursive: true,
      });
      await fs.writeFile(
        workspaceRemovalTombstonePath(fixture.config.rootDir, childId),
        JSON.stringify({ workspaceId: childId, removedAt: Date.now(), attemptId: "test" })
      );
    });
    try {
      expect(await callAs({ action: "search", query: "child", task_id: childId })).toEqual({
        success: false,
        error: "session_unavailable",
      });
    } finally {
      seam.restore();
    }
    // The chunk after the tombstone failed (a failed chunk is not counted), so the second
    // target read is the one that observed the removal.
    expect(seam.runs).toBe(1);
    expect(childReads() - readsBefore).toBe(2);
    await fs.rm(sessionDir(childId), { recursive: true, force: true });
    expect(await callAs({ action: "list_items", task_id: childId })).toEqual({
      success: false,
      error: "session_unavailable",
    });
    await expectNoSession(childId);
  });
});

describe("session_history complete results", () => {
  const readsOf = (workspace: string) => scanned.filter((scan) => scan === workspace).length;

  test("has_more reports a proven further match beyond limit, not an exactly-limit result", async () => {
    await append("second", "second facts");
    await append("third", "third facts");
    const capped = await complete(
      { action: "search", query: "facts", limit: 2 },
      { hasMore: true }
    );
    expect(capped.items?.map((item) => item.text)).toEqual(["opening facts", "second facts"]);
    expect(await textsOf({ action: "search", query: "facts", limit: 3 })).toEqual([
      "opening facts",
      "second facts",
      "third facts",
    ]);
    // Narrowing instead of paging: newest-first with a small limit reaches the tail directly.
    expect(
      await textsOf({ action: "list_items", recent_first: true, limit: 1 }, { hasMore: true })
    ).toEqual(["third facts"]);
    expect(await textsOf({ action: "list_items", role: "user" })).toEqual([]);
  });

  test("has_more is set when the response budget pops an item; a smaller snippet completes the read", async () => {
    for (const id of ["a", "b", "c"]) await append(`big-${id}`, `${id}`.repeat(7_000));
    const popped = await complete(
      { action: "list_items", role: "assistant", max_chars_per_item: 8_000 },
      { hasMore: true }
    );
    expect(popped.items?.map((item) => item.text.length)).toEqual([13, 7_000, 7_000]);
    expect(popped.truncated).toBeUndefined();
    expect(
      (
        await complete({ action: "list_items", role: "assistant", max_chars_per_item: 100 })
      ).items?.map((item) => item.text.length)
    ).toEqual([13, 100, 100, 100]);
  });

  test("list_windows has_more: a further window beyond limit, or a window that does not fit", async () => {
    const compaction = (epoch: number) => ({
      compacted: true as const,
      compactionBoundary: true as const,
      compactionEpoch: epoch,
    });
    const one = await append("compact-one", "summary", compaction(1));
    const two = await append("compact-two", "summary", compaction(2));
    const ids = ["w:0", ...[one, two].map((row) => `w:${String(row.metadata!.historySequence)}`)];
    expect(await windowIdsOf({ action: "list_windows", limit: 2 }, { hasMore: true })).toEqual(
      ids.slice(0, 2)
    );
    expect(await windowIdsOf({ action: "list_windows", limit: 3 })).toEqual(ids);
    // Legacy boundary rows (no sequence) carry their long IDs into the window list.
    const legacy = Array.from({ length: 20 }, (_, index) => `legacy-${index}-${"x".repeat(900)}`);
    await appendRawRows(legacy.map((id) => createMuxMessage(id, "assistant", "", compaction(3))));
    // 23 windows with ~1 KiB IDs exceed the 16 KiB response before the 50-window limit.
    const popped = await complete({ action: "list_windows", limit: 50 }, { hasMore: true });
    expect(popped.windows!.length).toBeGreaterThan(10);
    expect(popped.windows!.length).toBeLessThan(23);
    expect(Buffer.byteLength(JSON.stringify(popped))).toBeGreaterThan(14 * 1024);
    expect(
      await windowIdsOf({ action: "list_windows", recent_first: true, limit: 2 }, { hasMore: true })
    ).toEqual([`w:m:${legacy[19]}`, `w:m:${legacy[18]}`]);
  });

  test("warnings name skipped oversized and malformed rows once each, and are absent otherwise", async () => {
    expect((await complete({ action: "search", query: "facts" })).warnings).toBeUndefined();
    await appendRawRows([
      "not-json",
      createMuxMessage("huge", "assistant", "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 10)),
      "{broken",
      createMuxMessage("after", "assistant", "later facts"),
    ]);
    const result = await complete({ action: "search", query: "facts" });
    expect(result.items?.map((item) => item.text)).toEqual(["opening facts", "later facts"]);
    expect(result.warnings?.toSorted()).toEqual([
      "malformed_rows_skipped",
      "oversized_rows_skipped",
    ]);
    // The scan skips those rows whatever the action asks for.
    expect((await complete({ action: "list_windows" })).warnings?.toSorted()).toEqual([
      "malformed_rows_skipped",
      "oversized_rows_skipped",
    ]);
  });

  test("a read spanning several chunks returns its rows in one call", async () => {
    await append("one", "match one");
    await seedFiller();
    await append("two", "match two");
    await seedFiller(undefined, "later");
    await append("three", "match three");
    expect(await textsOf({ action: "search", query: "match" })).toEqual([
      "match one",
      "match two",
      "match three",
    ]);
    expect(readsOf(workspaceId)).toBeGreaterThanOrEqual(3);
    expect(await textsOf({ action: "search", query: "match", recent_first: true })).toEqual([
      "match three",
      "match two",
      "match one",
    ]);
  });

  test("the deadline between chunks returns history_timeout without data", async () => {
    await append("one", "match one");
    await seedFiller();
    const clock = fakeClock();
    const seam = mutateBetweenChunks(() => {
      clock.set(SESSION_HISTORY_TOOL_DEADLINE_MS + 1);
      return Promise.resolve();
    });
    try {
      expect(await call({ action: "search", query: "match" })).toEqual(TIMEOUT_RESULT);
    } finally {
      seam.restore();
      clock.restore();
    }
    expect(seam.runs).toBe(1);
    expect(readsOf(workspaceId)).toBe(1);
    expect(await textsOf({ action: "search", query: "match" })).toEqual(["match one"]);
  });

  test("an unfinished append check at the deadline discards rows accumulated earlier", async () => {
    await append("one", "match one");
    await seedFiller();
    await append("two", "match two");
    const clock = fakeClock();
    let accumulatedChunks = 0;
    const seam = afterChunks(async (chunk) => {
      if (chunk === 2) {
        // Chunk 2 browsed "match one"; a large tracked append now needs its own append check.
        await appendRawRows(
          Array.from({ length: 650 }, (_, index) =>
            createMuxMessage(`tail-${index}`, "assistant", "match " + "z".repeat(4096))
          )
        );
      }
      if (chunk === 3) {
        accumulatedChunks = scanned.length;
        clock.set(SESSION_HISTORY_TOOL_DEADLINE_MS + 1);
      }
    });
    try {
      expect(await call({ action: "search", query: "match" })).toEqual(TIMEOUT_RESULT);
    } finally {
      seam.restore();
      clock.restore();
    }
    expect(seam.chunks).toBe(3);
    expect(accumulatedChunks).toBe(3);
    // The pinned snapshot excludes the appended rows; the rows before it are still readable.
    expect(
      await textsOf({ action: "search", query: "match", limit: 2 }, { hasMore: true })
    ).toEqual(["match one", "match two"]);
  });

  test("a history mutex held past the deadline yields history_timeout after acquisition, without a read", async () => {
    const clock = fakeClock();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = fixture.historyService.withHistoryScanLocks(workspaceId, async () => {
      held();
      await released;
      clock.set(SESSION_HISTORY_TOOL_DEADLINE_MS + 1);
    });
    await holding;
    const real = fixture.historyService.withHistoryScanLocks.bind(fixture.historyService);
    let waits = 0;
    const spy = spyOn(fixture.historyService, "withHistoryScanLocks").mockImplementation(
      (workspace, operation, abortSignal) => {
        // The tool is about to wait behind the holder; let the holder finish past the deadline.
        if (workspace === workspaceId && ++waits === 1) release();
        return real(workspace, operation, abortSignal);
      }
    );
    try {
      expect(await call({ action: "list_items" })).toEqual(TIMEOUT_RESULT);
      await holder;
    } finally {
      spy.mockRestore();
      clock.restore();
    }
    expect(waits).toBe(1);
    expect(scanned).toEqual([]);
    expect(await textsOf({ action: "list_items" })).toEqual(["opening facts"]);
  });

  test("a final chunk validated after the deadline still publishes; cancellation wins over both", async () => {
    await append("one", "match one");
    await seedFiller();
    const clock = fakeClock();
    afterScan = (_workspace, page) => {
      if (!page.cursor) clock.set(SESSION_HISTORY_TOOL_DEADLINE_MS + 1);
    };
    try {
      expect(await textsOf({ action: "search", query: "match" })).toEqual(["match one"]);
      expect(readsOf(workspaceId)).toBeGreaterThan(1);
      const controller = new AbortController();
      const reason = new Error("cancel late");
      afterScan = (_workspace, page) => {
        if (!page.cursor) {
          clock.set(SESSION_HISTORY_TOOL_DEADLINE_MS * 2);
          controller.abort(reason);
        }
      };
      expect(
        await call({ action: "search", query: "match" }, controller.signal).catch(
          (error: unknown) => error
        )
      ).toBe(reason);
    } finally {
      clock.restore();
    }
  });

  test("a manual reset appended between chunks restarts the read from the new floor", async () => {
    await append("one", "match one");
    await seedFiller();
    const seam = mutateBetweenChunks(async () => {
      await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
      await append("after", "match after reset");
    });
    try {
      expect(await textsOf({ action: "search", query: "match" })).toEqual(["match after reset"]);
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
    expect(await textsOf({ action: "search", query: "match" })).toEqual(["match after reset"]);
  });

  test("a second invalidation during the restarted read returns history_changed without data", async () => {
    await append("one", "match one");
    await seedFiller();
    const seam = afterChunks(async (chunk) => {
      if (chunk > 2) return;
      await append(`reset-${chunk}`, "", { contextBoundaryKind: "reset", synthetic: true });
      await append(`after-${chunk}`, `match after reset ${chunk}`);
      // Keep the restarted read multi-chunk so the second reset lands between its chunks.
      await seedFiller(undefined, `filler-${chunk}`);
    });
    try {
      expect(await call({ action: "search", query: "match" })).toEqual(CHANGED_RESULT);
    } finally {
      seam.restore();
    }
    expect(seam.chunks).toBe(2);
    expect(await textsOf({ action: "search", query: "match" })).toEqual(["match after reset 2"]);
  });

  test("one in-place rewrite between chunks restarts once from the fresh baseline", async () => {
    await append("one", "match one");
    await seedFiller();
    const seam = mutateBetweenChunks(async () => {
      const handle = await fs.open(chatPath, "r+");
      try {
        await handle.write(Buffer.from("!"), 0, 1, 0);
      } finally {
        await handle.close();
      }
    });
    try {
      // The first row is now malformed; the rest of the fresh baseline is delivered.
      const result = await complete({ action: "search", query: "match" });
      expect(result.items?.map((item) => item.text)).toEqual(["match one"]);
      expect(result.warnings).toEqual(["malformed_rows_skipped"]);
    } finally {
      seam.restore();
    }
    expectIntermediate(seam);
  });

  test("a first invalidation with no time left is history_timeout, not history_changed", async () => {
    await append("one", "match one");
    await seedFiller();
    const clock = fakeClock();
    const seam = mutateBetweenChunks(async () => {
      await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
      // The clock crosses the deadline inside the chunk whose validation detects the reset.
      beforeScan = () => clock.set(SESSION_HISTORY_TOOL_DEADLINE_MS + 1);
    });
    try {
      expect(await call({ action: "search", query: "match" })).toEqual(TIMEOUT_RESULT);
    } finally {
      seam.restore();
      clock.restore();
    }
    expect(seam.runs).toBe(1);
    expect(readsOf(workspaceId)).toBe(2);
  });

  test("an unresolved truncate marker is history_changed after the single restart", async () => {
    await fs.writeFile(`${archivePath}.truncate`, "pending transaction");
    expect(await call({ action: "search", query: "opening facts" })).toEqual(CHANGED_RESULT);
  });
});

describe("session_history window counts", () => {
  const compaction = (epoch: number, sequence?: number): MuxMetadata => ({
    compacted: true,
    compactionBoundary: true,
    compactionEpoch: epoch,
    ...(sequence === undefined ? {} : { historySequence: sequence }),
  });
  const counts = async (input: Omit<SessionHistoryArgs, "action">, hasMore = false) =>
    (await windowsOf({ ...input, action: "list_windows" }, { hasMore })).map((window) => [
      window.windowId,
      window.itemCount,
    ]);

  test("itemCount is the exact visible row count in both directions, beyond limit and payload caps", async () => {
    await append("second", "second facts");
    const big = await append("big-boundary", "big summary", compaction(1));
    // 60 rows of 400 characters: more than the 25-row search limit and more than 16 KiB of text.
    for (let index = 0; index < 60; index++)
      await append(`big-${index}`, `${index} `.padEnd(400, "x"));
    const small = await append("small-boundary", "", compaction(2));
    await append("small-one", "small one");
    await append("small-two", "small two");
    const bigId = `w:${String(big.metadata!.historySequence)}`;
    const smallId = `w:${String(small.metadata!.historySequence)}`;
    const expected = [
      ["w:0", 2],
      [bigId, 61],
      [smallId, 2],
    ];
    expect(await counts({})).toEqual(expected);
    expect(await counts({ recent_first: true })).toEqual(expected.toReversed());
    expect(await counts({ window_id: bigId })).toEqual([[bigId, 61]]);
    expect(await counts({ window_id: bigId, recent_first: true })).toEqual([[bigId, 61]]);
    // list_items cannot return 61 rows in one response; the count still is exact.
    expect(
      await itemsOf({ action: "list_items", window_id: bigId, limit: 25 }, { hasMore: true })
    ).toHaveLength(25);
    // A boundary with no rows after it is an empty window.
    const empty = await append("empty", "", rollover);
    expect((await counts({ recent_first: true }))[0]).toEqual([
      `w:${String(empty.metadata!.historySequence)}`,
      0,
    ]);
  });

  test("hidden rows are not counted and a manual reset floors the counts", async () => {
    await append("hidden", "private needle", { synthetic: true });
    await append("visible-synthetic", "visible", { synthetic: true, uiVisible: true });
    await append("rejected", "private", { contextBudgetRejected: true });
    expect(await counts({})).toEqual([["w:0", 2]]);
    await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
    const reset = await fixture.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(reset.success).toBe(true);
    await append("after-one", "after one");
    await append("after-two", "after two");
    const resetWindow = (await windowsOf({ action: "list_windows" }))[0];
    expect(resetWindow.boundaryKind).toBe("reset");
    // The reset row itself is hidden; only the two rows behind it count, w:0 is gone.
    expect(await counts({})).toEqual([[resetWindow.windowId, 2]]);
    expect(await counts({ recent_first: true })).toEqual([[resetWindow.windowId, 2]]);
  });

  test("a window spanning the archive/chat seam is one run in both directions", async () => {
    const root = createMuxMessage("root", "assistant", "root row", { historySequence: 1 });
    const boundary = createMuxMessage(
      "seam-boundary",
      "assistant",
      "seam summary",
      compaction(1, 10)
    );
    const archived = createMuxMessage("archived", "assistant", "archived row", {
      historySequence: 11,
    });
    const active = [12, 13].map((sequence) =>
      createMuxMessage(`active-${sequence}`, "assistant", `active row ${sequence}`, {
        historySequence: sequence,
      })
    );
    await fs.writeFile(
      archivePath,
      [root, boundary, archived].map((row) => JSON.stringify(row) + "\n").join("")
    );
    await fs.writeFile(chatPath, active.map((row) => JSON.stringify(row) + "\n").join(""));
    const expected = [
      ["w:0", 1],
      ["w:10", 4],
    ];
    expect(await counts({})).toEqual(expected);
    expect(await counts({ recent_first: true })).toEqual(expected.toReversed());
    expect(await textsOf({ action: "list_items", window_id: "w:10" })).toEqual([
      "seam summary",
      "archived row",
      "active row 12",
      "active row 13",
    ]);
  });

  test("limit keeps returned counts exact and has_more proves a further matching window", async () => {
    const one = await append("one", "one", compaction(1));
    await append("one-row", "row");
    const two = await append("two", "two", compaction(2));
    const oneId = `w:${String(one.metadata!.historySequence)}`;
    const twoId = `w:${String(two.metadata!.historySequence)}`;
    expect(await counts({ limit: 2 }, true)).toEqual([
      ["w:0", 1],
      [oneId, 2],
    ]);
    expect(await counts({ limit: 3 })).toEqual([
      ["w:0", 1],
      [oneId, 2],
      [twoId, 1],
    ]);
    expect(await counts({ limit: 1, recent_first: true }, true)).toEqual([[twoId, 1]]);
    // Runs A, B filtered to A with limit 1: B's rows finalize A but do not prove another A.
    expect(await counts({ window_id: "w:0", limit: 1 })).toEqual([["w:0", 1]]);
    expect(await counts({ window_id: twoId, limit: 1, recent_first: true })).toEqual([[twoId, 1]]);
  });

  test("a window that does not fit is popped, also when it is finalized at the end of history", async () => {
    // Entries of ~1 KiB: w:0 plus 15 of these fit the 16 KiB response; the last one, which is
    // only finalized at the end of history, does not.
    const ids = Array.from({ length: 16 }, (_, index) => `legacy-${index}-${"x".repeat(950)}`);
    await appendRawRows(ids.map((id) => createMuxMessage(id, "assistant", "", compaction(1))));
    const atEof = await complete({ action: "list_windows", limit: 50 }, { hasMore: true });
    expect(atEof.windows!.map((window) => window.windowId)).toEqual([
      "w:0",
      ...ids.slice(0, 15).map((id) => `w:m:${id}`),
    ]);
    expect(
      atEof.windows!.every((window) => window.itemCount === (window.windowId === "w:0" ? 1 : 0))
    ).toBe(true);
    // The remaining windows are reachable by narrowing.
    expect(await counts({ recent_first: true, limit: 2 }, true)).toEqual([
      [`w:m:${ids[15]}`, 0],
      [`w:m:${ids[14]}`, 0],
    ]);
    await appendRawRows(
      ids
        .slice(14)
        .map((id) => createMuxMessage(`${id}-again`, "assistant", "later", compaction(2)))
    );
    // Now the pop happens mid-scan; the published entries are unchanged.
    const midScan = await complete({ action: "list_windows", limit: 50 }, { hasMore: true });
    expect(midScan.windows).toEqual(atEof.windows);
  });

  test("a recurring window ID is one entry per contiguous run, in both directions and filtered", async () => {
    const a = (id: string, text: string) =>
      createMuxMessage(id, "assistant", text, compaction(1, 100));
    await appendRawRows([
      a("a-one", "summary A1"),
      createMuxMessage("a-one-row", "assistant", "row a1"),
      a("a-two", "summary A2"),
      createMuxMessage("a-two-row", "assistant", "row a2"),
      createMuxMessage("b", "assistant", "summary B", compaction(2, 200)),
      createMuxMessage("b-row", "assistant", "row b"),
      a("a-three", "summary A3"),
      createMuxMessage("a-three-row-1", "assistant", "row a3.1"),
      createMuxMessage("a-three-row-2", "assistant", "row a3.2"),
    ]);
    const forward = [
      ["w:0", 1],
      ["w:100", 4],
      ["w:200", 2],
      ["w:100", 3],
    ];
    expect(await counts({})).toEqual(forward);
    expect(await counts({ recent_first: true })).toEqual(forward.toReversed());
    expect(await counts({ window_id: "w:100" })).toEqual([
      ["w:100", 4],
      ["w:100", 3],
    ]);
    expect(await counts({ window_id: "w:100", recent_first: true })).toEqual([
      ["w:100", 3],
      ["w:100", 4],
    ]);
    expect(await counts({ window_id: "w:100", limit: 1 }, true)).toEqual([["w:100", 4]]);
    expect(await counts({ window_id: "w:100", limit: 1, recent_first: true }, true)).toEqual([
      ["w:100", 3],
    ]);
    // Exhaustive run counts sum to the unfiltered per-window listing.
    expect(await itemsOf({ action: "list_items", window_id: "w:100" })).toHaveLength(7);
  });
});
