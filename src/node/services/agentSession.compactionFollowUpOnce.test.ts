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
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
import type { CompactionMonitor } from "./compactionMonitor";
import { HistoryService } from "./historyService";
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
