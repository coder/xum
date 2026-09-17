import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  SESSION_HISTORY_MAX_ID_CHARS,
  SESSION_HISTORY_MAX_RESULT_BYTES,
} from "@/common/constants/contextBudget";
import type { TaskService } from "@/node/services/taskService";
import { createRolloverPrefix } from "@/node/services/contextWindowRollover";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { createSessionHistoryTool, type SessionHistoryArgs } from "./session_history";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";

/** Production chunk budgets apply here; record every scan the tool issues, in order. */
let scanned: string[];
// Runs under both history locks after each scan; never mutates history (Bun's spyOn returns
// the same mock for an already-spied method, so tests hook here instead of nesting spies).
let afterScan: ((workspace: string) => void) | undefined;

let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
const workspaceId = "budget-history";
const serialize = (messages: MuxMessage[]) =>
  messages.map((row) => JSON.stringify(row) + "\n").join("");

beforeEach(async () => {
  fixture = await createTestHistoryService();
  scanned = [];
  afterScan = undefined;
  const scan = fixture.historyService.scanHistoryBoundedUnderLocks.bind(fixture.historyService);
  spyOn(fixture.historyService, "scanHistoryBoundedUnderLocks").mockImplementation(
    async (workspace, options) => {
      scanned.push(workspace);
      const page = await scan(workspace, options);
      afterScan?.(workspace);
      return page;
    }
  );
});
afterEach(async () => {
  await fixture.cleanup();
});

async function seed(chat: MuxMessage[], archive: MuxMessage[] = [], workspace = workspaceId) {
  const dir = path.join(fixture.config.sessionsDir, workspace);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "chat.jsonl"), serialize(chat));
  await fs.writeFile(path.join(dir, "chat-archive.jsonl"), serialize(archive));
}

async function call(args: SessionHistoryArgs, abortSignal?: AbortSignal) {
  const config = createTestToolConfig(fixture.tempDir, { workspaceId });
  config.historyService = fixture.historyService;
  config.taskService = {
    resolveDescendantAgentTaskBranchRoot: () =>
      Promise.resolve({ status: "live", branchRootTaskId: "child" }),
  } as unknown as TaskService;
  return TOOL_DEFINITIONS.session_history.resultSchema.parse(
    await createSessionHistoryTool(config).execute!(args, { ...mockToolCallOptions, abortSignal })
  );
}

test("a 15.5MiB rollover-only archive needs no discovery-page chase", async () => {
  const prefixAt = (index: number) => {
    const prefix = createRolloverPrefix({
      type: "context-window-rollover",
      rolloverId: `rollover-${index}`,
      reason: "on-send",
      previousWindowId: index === 0 ? "w:0" : `w:${(index - 248) * 3}`,
      flushOpportunity: false,
      contextTokens: 150_000,
      maxTokens: 200_000,
    });
    prefix.forEach((row, offset) => {
      row.id = `prefix-${index}-${offset}`;
      row.metadata = { ...row.metadata, timestamp: 1, historySequence: index * 3 + offset };
    });
    return prefix;
  };
  const archive: MuxMessage[] = [];
  for (let index = 0; index < 1240; index++) {
    if (index % 248 === 0) archive.push(...prefixAt(index));
    archive.push(
      createMuxMessage(
        `archive-${index}`,
        index % 40 === 0 ? "user" : "assistant",
        "x".repeat(13_000),
        {
          timestamp: 1,
          historySequence: index * 3 + 2,
        }
      )
    );
  }
  const bytes = Buffer.byteLength(serialize(archive));
  expect(bytes).toBeGreaterThan(15 * 1024 * 1024);
  expect(bytes).toBeLessThan(16 * 1024 * 1024);
  const recent = ["first recent request", "second recent request", "latest request"];
  await seed(
    [
      ...prefixAt(1240),
      ...recent.map((text, index) =>
        createMuxMessage(`recent-${index}`, "user", text, {
          timestamp: 1,
          historySequence: 3722 + index,
        })
      ),
    ],
    archive
  );

  const windows = await call({ action: "list_windows" });
  expect(windows).toMatchObject({ success: true, has_more: false });
  expect(windows.windows?.map((window) => window.windowId)).toEqual([
    "w:0",
    "w:744",
    "w:1488",
    "w:2232",
    "w:2976",
    "w:3720",
  ]);
  expect(scanned).toHaveLength(1);
  const messages = await call({ action: "list_items", role: "user", recent_first: true, limit: 3 });
  expect(messages).toMatchObject({ success: true, has_more: true });
  expect(messages.items?.map((item) => item.text)).toEqual(recent.toReversed());
});

test("a target window behind 40 MiB of earlier rows is listed in one call across chunks", async () => {
  // The reported failure: the first 32 MiB chunk stopped inside an early window and the
  // model was handed an empty "scanning" page for the window it asked about.
  const bulk = Array.from({ length: 3_300 }, (_, index) =>
    createMuxMessage(`bulk-${index}`, "assistant", "b".repeat(13_000), {
      timestamp: 1,
      historySequence: index,
    })
  );
  expect(Buffer.byteLength(serialize(bulk))).toBeGreaterThan(40 * 1024 * 1024);
  const prefix = createRolloverPrefix({
    type: "context-window-rollover",
    rolloverId: "rollover-target",
    reason: "on-send",
    previousWindowId: "w:0",
    flushOpportunity: false,
    contextTokens: 150_000,
    maxTokens: 200_000,
  });
  prefix.forEach((row, offset) => {
    row.id = `prefix-${offset}`;
    row.metadata = { ...row.metadata, timestamp: 1, historySequence: 5_000 + offset };
  });
  const targetWindow = `w:${String(prefix[0].metadata!.historySequence)}`;
  const requests = ["first request after rollover", "second request after rollover"];
  await seed(
    [
      ...prefix,
      ...requests.map((text, index) =>
        createMuxMessage(`request-${index}`, "user", text, {
          timestamp: 1,
          historySequence: 6_000 + index,
        })
      ),
      createMuxMessage("reply", "assistant", "assistant reply", {
        timestamp: 1,
        historySequence: 7_000,
      }),
    ],
    bulk
  );
  const listed = await call({ action: "list_items", window_id: targetWindow, role: "user" });
  expect(listed).toMatchObject({ success: true, has_more: false });
  expect(listed.items?.map((item) => item.text)).toEqual(requests);
  expect(scanned.length).toBeGreaterThanOrEqual(2);
  expect(await call({ action: "list_windows" })).toMatchObject({
    success: true,
    has_more: false,
    // The rollover boundary and its hidden lead-in are not visible rows.
    windows: [
      { windowId: "w:0", boundaryKind: "root", itemCount: bulk.length },
      { windowId: targetWindow, boundaryKind: "reset", itemCount: requests.length + 1 },
    ],
  });
});

test.each([false, true])(
  "production row exhaustion and sparse filtering preserve exact order (reverse=%s)",
  async (recentFirst) => {
    const rows = Array.from({ length: 10_040 }, (_, index) =>
      createMuxMessage(`row-${index}`, index % 1000 === 0 ? "user" : "assistant", `row ${index}`)
    );
    await seed(rows);
    const result = await call({
      action: "list_items",
      role: "user",
      recent_first: recentFirst,
      limit: 25,
    });
    expect(result).toMatchObject({ success: true, has_more: false });
    // 10,040 rows exceed one chunk's row allowance twice over (floor pass, then browse).
    expect(scanned.length).toBeGreaterThanOrEqual(2);
    const expected = rows
      .filter((row) => row.role === "user")
      .map((row) => row.parts[0])
      .map((part) => (part.type === "text" ? part.text : ""));
    expect(result.items?.map((item) => item.text)).toEqual(
      recentFirst ? expected.toReversed() : expected
    );
  }
);

test.each([false, true])(
  "production byte exhaustion preserves sparse results (reverse=%s)",
  async (recentFirst) => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      createMuxMessage(
        `large-${index}`,
        index % 39 === 0 ? "user" : "assistant",
        index % 39 === 0 ? `request ${index}` : "x".repeat(450_000)
      )
    );
    await seed(rows);
    const result = await call({ action: "list_items", role: "user", recent_first: recentFirst });
    expect(result).toMatchObject({ success: true, has_more: false });
    // ~34 MiB of rows exceed one chunk's byte allowance.
    expect(scanned.length).toBeGreaterThanOrEqual(2);
    expect(result.items?.map((item) => item.text)).toEqual(
      recentFirst
        ? ["request 78", "request 39", "request 0"]
        : ["request 0", "request 39", "request 78"]
    );
  }
);

test("short-token reserve fits worst-case escaped metadata and preserves Unicode character pages", async () => {
  const id = "\u0000".repeat(Math.floor((SESSION_HISTORY_MAX_ID_CHARS - 6) / 6));
  const boundary = createMuxMessage(id, "assistant", "", {
    compactionBoundary: true,
    compacted: true,
    compactionEpoch: 1,
  });
  const text = '🧪\u0000\\"'.repeat(4_000);
  await seed([
    boundary,
    createMuxMessage("large", "user", text),
    createMuxMessage("next", "user", text),
  ]);
  const first = await call({ action: "list_items", max_chars_per_item: 16_000 });
  // The second row did not fit: the model narrows (read_item paging below) instead of paging.
  expect(first).toMatchObject({ success: true, has_more: true, truncated: true });
  expect(first.items).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
    SESSION_HISTORY_MAX_RESULT_BYTES
  );
  // The small envelope reserve leaves most of the 16 KiB for payload.
  expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(8 * 1024);
  expect(first.items?.[0]?.text.length).toBeGreaterThan(0);
  const item = first.items![0];
  expect(item.windowId).toBe(`w:m:${id}`);
  let recovered = item.text;
  let offset = item.nextCharOffset;
  while (offset !== undefined) {
    const page = await call({
      action: "read_item",
      item_id: item.itemId,
      offset_chars: offset,
      limit_chars: 16_000,
    });
    expect(page.success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
    recovered += page.items![0].text;
    offset = page.items![0].nextCharOffset;
  }
  expect(recovered).toBe(text);
});

function receipt() {
  return createMuxMessage("spawn", "assistant", "", undefined, [
    {
      type: "dynamic-tool",
      toolName: "task",
      toolCallId: "spawn-child",
      state: "output-available",
      input: {},
      output: { taskId: "child" },
    },
  ]);
}

test.each(["rows", "bytes"] as const)(
  "descendant authorization and target share the production %s limit",
  async (limit) => {
    const callerCount = limit === "rows" ? 4_000 : 20;
    const targetCount = limit === "rows" ? 3_000 : 50;
    const text = "x".repeat(limit === "rows" ? 10 : 400_000);
    const bulk = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        createMuxMessage(`bulk-${index}`, "assistant", text)
      );
    await seed([...bulk(callerCount), receipt()]);
    await seed(
      [createMuxMessage("wanted", "user", "child request"), ...bulk(targetCount)],
      [],
      "child"
    );
    const result = await call({ action: "list_items", role: "user", task_id: "child" });
    expect(result).toMatchObject({ success: true, has_more: false });
    expect(result.items?.map((item) => item.text)).toEqual(["child request"]);
    // Authorization and target share one chunk allowance: the caller's 4,000 rows (or 8 MiB)
    // plus the target's 3,000 rows (or 20 MiB) cannot fit one chunk, so the target read is
    // deferred to a later chunk, whose authorization re-check precedes it.
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    expect(scanned[0]).toBe(workspaceId);
    expect(scanned.at(-1)).toBe("child");
    expect(scanned[scanned.indexOf("child") - 1]).toBe(workspaceId);
  }
);

test.each(["deadline", "caller abort", "target abort"] as const)(
  "descendant scans share %s without converting cancellation to an error result",
  async (mode) => {
    await seed([receipt()]);
    await seed([createMuxMessage("wanted", "user", "child request")], [], "child");
    const controller = new AbortController();
    const reason = new Error("cancel descendant");
    let now = 0;
    let validations = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    afterScan = () => {
      validations++;
      // The first authorization scan consumes the chunk's 2 s allowance ...
      if (mode === "deadline") {
        if (validations === 1) now = 2_001;
      } else if (validations === (mode === "caller abort" ? 1 : 2)) controller.abort(reason);
    };
    try {
      const operation = call({ action: "list_items", task_id: "child" }, controller.signal);
      if (mode === "deadline") {
        const result = await operation;
        expect(result).toMatchObject({ success: true, has_more: false });
        expect(result.items?.map((item) => item.text)).toEqual(["child request"]);
        // ... so that chunk reads no target; the next chunk re-checks the caller, then reads.
        expect(scanned).toEqual([workspaceId, workspaceId, "child"]);
      } else expect(await operation.catch((error: unknown) => error)).toBe(reason);
    } finally {
      afterScan = undefined;
      clock.mockRestore();
    }
    // Neither authorization nor target cancellation may leak either lock.
    expect(
      (await call({ action: "list_items", task_id: "child" })).items?.map((item) => item.text)
    ).toEqual(["child request"]);
  }
);

test("an already-aborted tool call propagates cancellation rather than history_unavailable", async () => {
  await seed([createMuxMessage("row", "user", "private")]);
  const controller = new AbortController();
  const reason = new Error("cancel history");
  controller.abort(reason);
  expect(
    await call({ action: "list_items" }, controller.signal).catch((error: unknown) => error)
  ).toBe(reason);
  expect((await call({ action: "list_items" })).items?.[0]?.text).toBe("private");
});

test("a read that never completes a chunk before the tool deadline is history_timeout", async () => {
  await seed([createMuxMessage("row", "user", "visible")]);
  let now = 0;
  // Every clock read jumps past the chunk allowance: each chunk validates its snapshot and
  // returns no progress, until the cooperative call deadline ends the loop without data.
  const clock = spyOn(performance, "now").mockImplementation(() => (now += 2_001));
  try {
    expect(await call({ action: "list_items" })).toEqual({
      success: false,
      error: "history_timeout",
      notice: expect.stringContaining("narrow") as string,
    });
  } finally {
    clock.mockRestore();
  }
  expect(scanned.length).toBeGreaterThan(1);
  expect((await call({ action: "list_items" })).items?.map((item) => item.text)).toEqual([
    "visible",
  ]);
});
