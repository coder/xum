/**
 * A compaction's pending follow-up runs at most once. Regression tests for the TLC findings in
 * formal/compaction/ (cases C1-* and C2-* in check.sh; the fixed model is F2).
 *
 * Crash = the session is disposed after a chosen durable step and a fresh AgentSession +
 * HistoryService is created on the same root. A second backend = a second AgentSession +
 * HistoryService on the same root; interleavings are forced with a path-specific spy.
 */
import { afterEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
import type { CompactionMonitor } from "./compactionMonitor";
import { HistoryService } from "./historyService";
import { log } from "./log";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "compaction-follow-up-once";
const options = { model: "openai:gpt-4o", agentId: "exec" };
const FOLLOW_UP = "continue after compaction";
const harnesses: AgentSessionHarness[] = [];
setDefaultTimeout(30_000);

afterEach(async () => {
  mock.restore();
  for (const h of harnesses.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

/** Keep the dispatched send from being turned into another compaction by the budget monitor. */
function quietMonitor(h: AgentSessionHarness): void {
  (
    h.session as unknown as { contextController: { compactionMonitor: CompactionMonitor } }
  ).contextController.compactionMonitor = {
    checkBeforeSend: mock(() => ({
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 10,
      thresholdPercentage: 85,
    })),
    checkMidStream: mock(() => false),
    resetForNewStream: mock(() => undefined),
    noteUserTurn: mock(() => undefined),
    noteAutoCompactionRequested: mock(() => undefined),
    noteAutoCompactionCompleted: mock(() => undefined),
    suppressRepeatedAutoCompaction: mock(() => false),
  } as unknown as CompactionMonitor;
}

async function backend(from?: AgentSessionHarness): Promise<AgentSessionHarness> {
  const h = from
    ? await createAgentSessionHarness({
        workspaceId,
        config: from.config,
        historyService: new HistoryService(from.config),
      })
    : await createAgentSessionHarness({ workspaceId });
  harnesses.push(h);
  quietMonitor(h);
  return h;
}

/** The durable handoff a finished /compact leaves: boundary summary with pendingFollowUp. */
async function seedHandoff(h: AgentSessionHarness): Promise<void> {
  const append = async (message: MuxMessage) =>
    assert((await h.historyService.appendToHistory(workspaceId, message)).success);
  await append(createMuxMessage("u0", "user", "original question"));
  await append(createMuxMessage("a0", "assistant", "original answer"));
  await append(
    createMuxMessage("summary", "assistant", "compacted summary", {
      compactionBoundary: true,
      compacted: "user",
      compactionEpoch: 1,
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: FOLLOW_UP, model: options.model, agentId: "exec" },
      },
    })
  );
}

async function allRows(h: AgentSessionHarness): Promise<MuxMessage[]> {
  const rows: MuxMessage[] = [];
  const result = await h.historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
    rows.push(...chunk);
  });
  assert(result.success);
  return rows;
}

const textOf = (row: MuxMessage) =>
  row.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
const followUpRows = (rows: MuxMessage[]) =>
  rows.filter((row) => row.role === "user" && textOf(row) === FOLLOW_UP);

describe("C1: editing the dispatched follow-up retires the consumed handoff", () => {
  test("a crash between the edit's cut and its new user row does not re-dispatch", async () => {
    const h = await backend();
    await seedHandoff(h);
    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    await h.session.waitForIdle();
    const [dispatched] = followUpRows(await allRows(h));
    assert(dispatched, "follow-up row must exist after the first dispatch");

    // The user edits that follow-up. The edit's first durable step is the cut
    // (truncateAfterMessage); the process dies before the edited user row is appended.
    assert((await h.historyService.truncateAfterMessage(workspaceId, dispatched.id)).success);
    await h.session.dispose();

    const restarted = await backend(h);
    // Startup recovery: the summary is the last visible row again.
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect(followUpRows(await allRows(restarted))).toHaveLength(0);
  });

  test("a failed edit send (no crash) does not re-arm the handoff", async () => {
    const h = await backend();
    await seedHandoff(h);
    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    await h.session.waitForIdle();
    const [dispatched] = followUpRows(await allRows(h));
    assert(dispatched);
    // The edited user row cannot be persisted (e.g. EIO / history lock timeout). It publishes
    // through acceptCompactionReplacement, after the edit's cut already committed.
    const original = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementation(
      (ws, capture, operation, observer) =>
        operation.kind === "append" &&
        operation.messages.some((row) => row.role === "user" && textOf(row) === "edited follow-up")
          ? Promise.resolve(Err("injected append failure"))
          : original(ws, capture, operation, observer)
    );
    const edit = await h.session.sendMessage("edited follow-up", {
      ...options,
      editMessageId: dispatched.id,
    });
    expect(edit.success).toBe(false);
    mock.restore();
    await h.session.dispose();

    const restarted = await backend(h);
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect(followUpRows(await allRows(restarted))).toHaveLength(0);
  });

  test("editing a follow-up that a later compaction archived does not re-dispatch", async () => {
    const h = await backend();
    await seedHandoff(h);
    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    await h.session.waitForIdle();
    const [dispatched] = followUpRows(await allRows(h));
    assert(dispatched);
    // A later compaction seals the summary and the dispatched row into the archive, so the edit's
    // cut goes through truncateAfterArchivedMessageUnlocked instead of the active-epoch branch.
    assert(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("summary-2", "assistant", "second summary", {
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 2,
            muxMetadata: { type: "compaction-summary" },
          })
        )
      ).success
    );
    const active = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(active.success);
    expect(active.data.some((row) => row.id === dispatched.id)).toBe(false);

    assert((await h.historyService.truncateAfterMessage(workspaceId, dispatched.id)).success);
    await h.session.dispose();

    const restarted = await backend(h);
    // The cut re-exposed the first summary as the last visible row.
    expect((await allRows(restarted)).at(-1)?.id).toBe("summary");
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect(followUpRows(await allRows(restarted))).toHaveLength(0);
  });
});

// #5333 item 4: the dispatched user row is the only proof of consumption. The production
// deleteMessage(s) callers remove assistant placeholders (clearFailedAssistantMessage,
// deleteAbortedPlaceholder) or roll back an attempt's own rows before acceptance (the follow-up
// never ran), so none of them can remove that proof once the follow-up turn has started.
describe("deleteMessage paths keep a consumed handoff consumed", () => {
  test("deleting the follow-up's assistant reply does not re-arm the handoff", async () => {
    const h = await backend();
    await seedHandoff(h);
    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    await h.session.waitForIdle();
    // The harness persists no reply, so stand one in: the assistant row a failed or aborted
    // stream leaves after the dispatched user row.
    const reply = createMuxMessage("follow-up-reply", "assistant", "partial reply");
    assert((await h.historyService.appendToHistory(workspaceId, reply)).success);
    // clearFailedAssistantMessage / deleteAbortedPlaceholder delete it by id.
    assert((await h.historyService.deleteMessage(workspaceId, reply.id)).success);
    await h.session.dispose();

    const restarted = await backend(h);
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect(followUpRows(await allRows(restarted))).toHaveLength(1);
  });
});

describe("C2: a second backend's startup dispatch races the first backend", () => {
  test("only one backend dispatches the follow-up", async () => {
    const a = await backend();
    await seedHandoff(a);
    const b = await backend(a); // second backend on the same root, starting up
    // A's unlocked startup read sees the handoff; B dispatches in between.
    const read = a.historyService.getLastMessages.bind(a.historyService);
    let raced = false;
    spyOn(a.historyService, "getLastMessages").mockImplementation(async (ws, count) => {
      const result = await read(ws, count);
      if (!raced) {
        raced = true;
        expect(await b.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
        await b.session.waitForIdle();
      }
      return result;
    });
    await a.session.dispatchPendingCompactionFollowUpIfNeeded();
    await a.session.waitForIdle();
    expect(raced).toBe(true);
    expect(followUpRows(await allRows(a))).toHaveLength(1);
  });

  test("a duplicated summary row refuses the dispatch under its own log reason", async () => {
    const h = await backend();
    await seedHandoff(h);
    // Corrupted history: the summary row (same id and sequence) appears twice, so the locked
    // re-check cannot tell which copy owns the handoff.
    const chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    const summaryLine = (await fs.readFile(chatPath, "utf-8")).trimEnd().split("\n").at(-1) ?? "";
    assert(summaryLine.includes('"summary"'), "the summary is the last chat.jsonl row");
    await fs.appendFile(chatPath, `${summaryLine}\n`);
    const warn = spyOn(log, "warn");
    const info = spyOn(log, "info");
    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    // The refusal is told apart by level and fields, not wording: the "consumed" refusal logs at
    // info, the duplicate one at warn with the summary's sequence.
    const aboutSummary = (spy: typeof warn) =>
      spy.mock.calls.flatMap(([, fields]) => {
        const record = fields as { summaryMessageId?: unknown; historySequence?: unknown };
        return record?.summaryMessageId === "summary" ? [record] : [];
      });
    const warned = aboutSummary(warn);
    expect(warned.map((record) => typeof record.historySequence)).toEqual(["number"]);
    expect(aboutSummary(info)).toHaveLength(0);
    expect(followUpRows(await allRows(h))).toHaveLength(0);
  });

  // TLC also reported a Stop bypass in this race; automatic send admission re-reads the
  // cancellation record and refuses.
  test("the other backend's Stop still blocks the racing dispatch", async () => {
    const a = await backend();
    await seedHandoff(a);
    const b = await backend(a);
    const read = b.historyService.getLastMessages.bind(b.historyService);
    let stopped = false;
    spyOn(b.historyService, "getLastMessages").mockImplementation(async (ws, count) => {
      const result = await read(ws, count);
      if (!stopped) {
        stopped = true;
        expect((await a.session.cancelCompaction()).success).toBe(true);
      }
      return result;
    });
    const dispatch = await b.session
      .dispatchPendingCompactionFollowUpIfNeeded()
      .catch((error: unknown) => String(error));
    await b.session.waitForIdle();
    expect(stopped).toBe(true);
    expect(String(dispatch)).toContain("being cleared or reset");
    expect(followUpRows(await allRows(b))).toHaveLength(0);
  });
});
