import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkflowRunAttention } from "@/node/services/workflowRunAttention";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";

type RecordSettled = TerminalAttentionStore["recordSettled"];
type DeleteMarker = TerminalAttentionStore["delete"];

interface FakeStore {
  recordSettled: ReturnType<typeof mock<RecordSettled>>;
  delete: ReturnType<typeof mock<DeleteMarker>>;
}

function createFakeStore(): FakeStore {
  return {
    recordSettled: mock<RecordSettled>(() => Promise.resolve()),
    delete: mock<DeleteMarker>(() => Promise.resolve()),
  };
}

const OWNER = "owner-workspace";

describe("WorkflowRunAttention", () => {
  let sessionsDir: string;
  let store: FakeStore;
  let attention: WorkflowRunAttention;

  beforeEach(async () => {
    sessionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "workflow-run-attention-"));
    store = createFakeStore();
    attention = new WorkflowRunAttention({
      sessionsDir: () => sessionsDir,
      terminalAttentionStore: () => store as unknown as TerminalAttentionStore,
    });
  });

  afterEach(async () => {
    await fsPromises.rm(sessionsDir, { recursive: true, force: true });
  });

  /** Creates a completed run on disk and returns its terminal generation (updatedAt). */
  async function createCompletedRun(runId: string, ownerWorkspaceId = OWNER): Promise<string> {
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(sessionsDir, ownerWorkspaceId),
    });
    await runStore.createRun({
      id: runId,
      workspaceId: ownerWorkspaceId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    return (await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:02.000Z")).updatedAt;
  }

  function settle(runId: string, runUpdatedAt: string, ownerWorkspaceId = OWNER) {
    return attention.markWorkflowRunTerminalAttentionSettled({
      ownerWorkspaceId,
      runId,
      status: "completed",
      runUpdatedAt,
      settledAs: "delivered",
    });
  }

  describe("queue", () => {
    test("reports only the first queueing of a run and keeps insertion order", () => {
      expect(attention.queueWorkflowRunAttention(OWNER, "wfr_b")).toBe(true);
      expect(attention.queueWorkflowRunAttention(OWNER, "wfr_a")).toBe(true);
      expect(attention.queueWorkflowRunAttention(OWNER, "wfr_b")).toBe(false);
      expect(attention.queuedRunIds(OWNER)).toEqual(["wfr_b", "wfr_a"]);
      expect(attention.queuedRunIds("other-owner")).toEqual([]);
    });

    test("queuedRunIds returns a snapshot the caller can hold across queue changes", () => {
      attention.queueWorkflowRunAttention(OWNER, "wfr_a");
      const snapshot = attention.queuedRunIds(OWNER);
      attention.queueWorkflowRunAttention(OWNER, "wfr_b");
      expect(snapshot).toEqual(["wfr_a"]);
    });

    test("dropRun removes one run and dropOwner removes the whole owner", () => {
      attention.queueWorkflowRunAttention(OWNER, "wfr_a");
      attention.queueWorkflowRunAttention(OWNER, "wfr_b");
      attention.queueWorkflowRunAttention("other-owner", "wfr_c");

      attention.dropRun(OWNER, "wfr_a");
      attention.dropRun("missing-owner", "wfr_a");
      expect(attention.queuedRunIds(OWNER)).toEqual(["wfr_b"]);

      attention.dropOwner(OWNER);
      expect(attention.queuedRunIds(OWNER)).toEqual([]);
      expect(attention.queuedRunIds("other-owner")).toEqual(["wfr_c"]);
      // A dropped owner can be re-queued from scratch.
      expect(attention.queueWorkflowRunAttention(OWNER, "wfr_b")).toBe(true);
    });
  });

  describe("markWorkflowRunTerminalAttentionSettled", () => {
    test("ignores a non-terminal status", async () => {
      attention.queueWorkflowRunAttention(OWNER, "wfr_running");
      await attention.markWorkflowRunTerminalAttentionSettled({
        ownerWorkspaceId: OWNER,
        runId: "wfr_running",
        status: "running",
        runUpdatedAt: "2026-06-19T00:00:01.000Z",
        settledAs: "delivered",
      });
      expect(store.recordSettled).not.toHaveBeenCalled();
      expect(attention.queuedRunIds(OWNER)).toEqual(["wfr_running"]);
    });

    test("writes the stable marker before the generation marker and dequeues the run", async () => {
      const runId = "wfr_current";
      const generation = await createCompletedRun(runId);
      attention.queueWorkflowRunAttention(OWNER, runId);
      attention.queueWorkflowRunAttention(OWNER, "wfr_other");

      await settle(runId, generation);

      const calls = store.recordSettled.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toMatchObject({ sourceId: runId, generationId: generation });
      expect(calls[0][1]).toEqual({ wholeSourceRefresh: true });
      expect(calls[1][0]).toMatchObject({
        ownerWorkspaceId: OWNER,
        sourceKind: "workflow_run",
        sourceId: runId,
        generationId: generation,
        terminalOutcome: "completed",
        status: "delivered",
      });
      expect(calls[1][1]).toBeUndefined();
      expect(store.delete).not.toHaveBeenCalled();
      expect(attention.queuedRunIds(OWNER)).toEqual(["wfr_other"]);
    });

    test("keeps the queue entry and resolves when a marker write fails", async () => {
      const runId = "wfr_write_fails";
      const generation = await createCompletedRun(runId);
      attention.queueWorkflowRunAttention(OWNER, runId);
      store.recordSettled.mockImplementationOnce(() => Promise.reject(new Error("disk full")));

      await settle(runId, generation);

      expect(store.recordSettled).toHaveBeenCalledTimes(1);
      expect(store.delete).not.toHaveBeenCalled();
      expect(attention.queuedRunIds(OWNER)).toEqual([runId]);
    });

    test("clears the stable marker but keeps the queue entry for a newer generation", async () => {
      const runId = "wfr_restarted";
      const generation = await createCompletedRun(runId);
      attention.queueWorkflowRunAttention(OWNER, runId);

      await settle(runId, `${generation}-older`);

      expect(store.delete.mock.calls).toEqual([
        [OWNER, TerminalAttentionStore.notificationId("workflow_run", runId)],
      ]);
      expect(attention.queuedRunIds(OWNER)).toEqual([runId]);
    });

    test("clears the stable marker and dequeues the run when it is unreadable", async () => {
      const runId = "wfr_missing";
      attention.queueWorkflowRunAttention(OWNER, runId);

      await settle(runId, "2026-06-19T00:00:02.000Z");

      expect(store.delete.mock.calls).toEqual([
        [OWNER, TerminalAttentionStore.notificationId("workflow_run", runId)],
      ]);
      expect(attention.queuedRunIds(OWNER)).toEqual([]);
    });

    test("serializes settlements of one run and lets other runs proceed", async () => {
      const runId = "wfr_serialized";
      const otherRunId = "wfr_parallel";
      const generation = await createCompletedRun(runId);
      const otherGeneration = await createCompletedRun(otherRunId);

      // Park every settlement of runId inside its first marker write until released, in order.
      const order: string[] = [];
      const releases: Array<() => void> = [];
      let reached: () => void = () => undefined;
      store.recordSettled.mockImplementation(async (record, options) => {
        if (record.sourceId === runId && options?.wholeSourceRefresh === true) {
          order.push(`start:${record.status}`);
          await new Promise<void>((resolve) => {
            releases.push(resolve);
            reached();
          });
        }
      });
      const nextReached = () =>
        new Promise<void>((resolve) => {
          reached = resolve;
        });

      let parked = nextReached();
      const first = attention.markWorkflowRunTerminalAttentionSettled({
        ownerWorkspaceId: OWNER,
        runId,
        status: "completed",
        runUpdatedAt: generation,
        settledAs: "superseded",
      });
      await parked;
      const second = settle(runId, generation);

      // Another run of the same owner is not blocked by the parked settlement.
      await settle(otherRunId, otherGeneration);
      expect(order).toEqual(["start:superseded"]);

      parked = nextReached();
      releases[0]();
      await first;
      await parked;
      expect(order).toEqual(["start:superseded", "start:delivered"]);

      // A third settlement queues behind the still-parked second one: finishing the first must
      // not have dropped the second one's chain entry.
      const third = settle(runId, generation);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual(["start:superseded", "start:delivered"]);

      parked = nextReached();
      releases[1]();
      await second;
      await parked;
      expect(order).toEqual(["start:superseded", "start:delivered", "start:delivered"]);
      releases[2]();
      await third;
    });

    test("rejects an empty owner or run id and accepts one-character ids", async () => {
      const base = {
        status: "completed",
        runUpdatedAt: "2026-06-19T00:00:02.000Z",
        settledAs: "delivered",
      } as const;
      await expect(
        attention.markWorkflowRunTerminalAttentionSettled({
          ...base,
          ownerWorkspaceId: "",
          runId: "r",
        })
      ).rejects.toThrow();
      await expect(
        attention.markWorkflowRunTerminalAttentionSettled({
          ...base,
          ownerWorkspaceId: "o",
          runId: "",
        })
      ).rejects.toThrow();
      expect(store.recordSettled).not.toHaveBeenCalled();

      await attention.markWorkflowRunTerminalAttentionSettled({
        ...base,
        ownerWorkspaceId: "o",
        runId: "r",
      });
      expect(store.recordSettled).toHaveBeenCalledTimes(2);
    });

    test("reads the store and sessions dir from deps at call time", async () => {
      const runId = "wfr_swapped";
      const generation = await createCompletedRun(runId);
      const swappedStore = createFakeStore();
      let currentStore = store;
      attention = new WorkflowRunAttention({
        sessionsDir: () => sessionsDir,
        terminalAttentionStore: () => currentStore as unknown as TerminalAttentionStore,
      });
      currentStore = swappedStore;
      attention.queueWorkflowRunAttention(OWNER, runId);

      await settle(runId, generation);

      expect(store.recordSettled).not.toHaveBeenCalled();
      expect(swappedStore.recordSettled).toHaveBeenCalledTimes(2);
      expect(attention.queuedRunIds(OWNER)).toEqual([]);
    });
  });

  describe("clearWorkflowRunDowngradeSettlement", () => {
    test("deletes the stable marker and swallows a delete failure", async () => {
      store.delete.mockImplementationOnce(() => Promise.reject(new Error("locked")));

      await attention.clearWorkflowRunDowngradeSettlement({ ownerWorkspaceId: OWNER, runId: "r" });

      expect(store.delete.mock.calls).toEqual([
        [OWNER, TerminalAttentionStore.notificationId("workflow_run", "r")],
      ]);
    });

    test("accepts one-character ids", async () => {
      await attention.clearWorkflowRunDowngradeSettlement({ ownerWorkspaceId: "o", runId: "r" });
      expect(store.delete.mock.calls).toEqual([
        ["o", TerminalAttentionStore.notificationId("workflow_run", "r")],
      ]);
    });

    test("rejects an empty owner or run id", async () => {
      await expect(
        attention.clearWorkflowRunDowngradeSettlement({ ownerWorkspaceId: "", runId: "r" })
      ).rejects.toThrow();
      await expect(
        attention.clearWorkflowRunDowngradeSettlement({ ownerWorkspaceId: OWNER, runId: "" })
      ).rejects.toThrow();
      expect(store.delete).not.toHaveBeenCalled();
    });
  });
});
