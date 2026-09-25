/* eslint-disable @typescript-eslint/await-thenable */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { isPathSafeWorkspaceId, WorkflowRunStore } from "./WorkflowRunStore";

const definition = {
  name: "deep-research",
  description: "Research a topic",
  scope: "built-in" as const,
  executable: true,
};

const source = "export default async function workflow() { return 'ok'; }\n";

/**
 * Hold a store lock the way another live process would: this process's live crossProcessLock
 * record, taken without the store's in-process queue.
 */
async function holdStoreLock(lockPath: string): Promise<() => Promise<void>> {
  return await acquireCrossProcessLock({
    lockPath,
    acquireTimeoutMs: 0,
    staleMs: 1_000,
    timeoutMessage: "test lock busy",
  });
}

/**
 * One-shot pause on a store's next call of private method `method` (a real mutation, holding its
 * locks). In-process holders wake waiters at once, unlike crossProcessLock's 250 ms retry.
 */
function pauseNext(store: WorkflowRunStore, method: "getRunUnlocked" | "writeRunFile") {
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const internals = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = internals[method].bind(store);
  internals[method] = async (...args: unknown[]) => {
    internals[method] = original;
    signalEntered();
    await released;
    return await original(...args);
  };
  return { entered, release };
}

async function createStore(sessionDir: string, staleLeaseMs = 10) {
  const store = new WorkflowRunStore({ sessionDir, staleLeaseMs });
  await store.createRun({
    id: "wfr_123",
    workspaceId: "workspace-1",
    workflow: definition,
    source: source,
    args: { topic: "durable runs" },
    now: "2026-05-29T00:00:00.000Z",
  });
  return store;
}

describe("WorkflowRunStore", () => {
  test("persists captured workflow source and reloads run state", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "status",
      at: "2026-05-29T00:00:01.000Z",
      status: "running",
    });

    const reloadedStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    const run = await reloadedStore.getRun("wfr_123");

    expect(run.source).toBe(source);
    expect(run.sourceHash).toMatch(/^sha256:/);
    expect(run.events.map((event) => event.sequence)).toEqual([1]);
  });

  test("never persists a hydrated phaseManifest into run.json (store boundary)", async () => {
    using tmp = new DisposableTempDir("workflow-runs-phase-manifest-boundary");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    // Simulate a hydrated outbound descriptor accidentally fed back into a write.
    await store.createRun({
      id: "wfr_manifest",
      workspaceId: "workspace-1",
      workflow: {
        ...definition,
        phaseManifest: { provenance: "declared", phases: [{ name: "scope" }] },
      },
      source,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });

    const rawRunFile = await fs.readFile(
      path.join(tmp.path, "workflows", "wfr_manifest", "run.json"),
      "utf-8"
    );
    expect(rawRunFile).not.toContain("phaseManifest");
    // Reads return the stored (non-hydrated) descriptor.
    const run = await store.getRun("wfr_manifest");
    expect(run.workflow.phaseManifest).toBeUndefined();
  });

  test("a malformed persisted phaseManifest never makes run.json unreadable", async () => {
    using tmp = new DisposableTempDir("workflow-runs-malformed-manifest");
    const store = await createStore(tmp.path);
    const runFile = path.join(tmp.path, "workflows", "wfr_123", "run.json");
    const currentRun = JSON.parse(await fs.readFile(runFile, "utf-8")) as {
      workflow: Record<string, unknown>;
    };
    // Derived data with an invalid shape (hand-edited / corrupted): stripped before
    // schema validation, so the durable run still loads and lists.
    currentRun.workflow.phaseManifest = { provenance: "bogus", phases: "not-an-array" };
    await fs.writeFile(runFile, JSON.stringify(currentRun, null, 2), "utf-8");

    const run = await store.getRun("wfr_123");
    expect(run.workflow.phaseManifest).toBeUndefined();
    expect(run.id).toBe("wfr_123");
    expect((await store.listRunStatusSnapshots()).map((snapshot) => snapshot.id)).toContain(
      "wfr_123"
    );
  });

  test("loads legacy workflow source snapshot filenames", async () => {
    using tmp = new DisposableTempDir("workflow-runs-legacy-source-filename");
    const store = await createStore(tmp.path);
    const runDir = path.join(tmp.path, "workflows", "wfr_123");
    await fs.rename(path.join(runDir, "source.js"), path.join(runDir, "definition.js"));

    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ source });
  });

  test("normalizes legacy workflow run record fields before parsing", async () => {
    using tmp = new DisposableTempDir("workflow-runs-legacy-record-fields");
    const store = await createStore(tmp.path);
    const runDir = path.join(tmp.path, "workflows", "wfr_123");
    const runFile = path.join(runDir, "run.json");
    const currentRun = JSON.parse(await fs.readFile(runFile, "utf-8")) as Record<string, unknown>;
    const legacyRun: Record<string, unknown> = {
      ...currentRun,
      definition: currentRun.workflow,
      definitionSource: currentRun.source,
      definitionHash: currentRun.sourceHash,
    };
    delete legacyRun.workflow;
    delete legacyRun.source;
    delete legacyRun.sourceHash;
    await fs.writeFile(runFile, JSON.stringify(legacyRun, null, 2), "utf-8");
    await fs.rename(path.join(runDir, "source.js"), path.join(runDir, "definition.js"));

    await expect(store.getRun("wfr_123")).resolves.toMatchObject({
      workflow: definition,
      source,
    });
  });

  test("lists lightweight run status snapshots without hydrating journals or source", async () => {
    using tmp = new DisposableTempDir("workflow-runs-status-snapshots");
    const store = await createStore(tmp.path);
    await store.createRun({
      id: "wfr_child",
      workspaceId: "workspace-1",
      workflow: definition,
      source: source,
      args: {},
      parentWorkflow: { runId: "wfr_123", stepId: "child", inputHash: "hash", depth: 0 },
      now: "2026-05-29T00:00:01.000Z",
    });
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:02.000Z");

    await fs.writeFile(path.join(tmp.path, "workflows", "wfr_123", "source.js"), "broken");
    await fs.writeFile(
      path.join(tmp.path, "workflows", "wfr_123", "events.jsonl"),
      "{not-json}\n",
      "utf-8"
    );

    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ source: "broken" });
    const snapshots = await store.listRunStatusSnapshots();

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      id: "wfr_123",
      workspaceId: "workspace-1",
      status: "running",
    });
    expect(snapshots[1]?.id).toBe("wfr_child");
    expect(snapshots[1]?.parentWorkflow?.runId).toBe("wfr_123");
  });

  test("reconciles active status snapshots with terminal journal events", async () => {
    using tmp = new DisposableTempDir("workflow-runs-status-reconcile");
    const store = await createStore(tmp.path);
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z");
    await store.appendStatus("wfr_123", "completed", "2026-05-29T00:00:02.000Z");

    const runFile = path.join(tmp.path, "workflows", "wfr_123", "run.json");
    const staleRun = JSON.parse(await fs.readFile(runFile, "utf-8")) as Record<string, unknown>;
    staleRun.status = "running";
    staleRun.updatedAt = "2026-05-29T00:00:01.000Z";
    await fs.writeFile(runFile, JSON.stringify(staleRun, null, 2), "utf-8");

    await expect(store.getRun("wfr_123")).resolves.toMatchObject({
      status: "completed",
      updatedAt: "2026-05-29T00:00:02.000Z",
    });
    await expect(store.getRunStatusSnapshot("wfr_123")).resolves.toMatchObject({
      status: "completed",
      updatedAt: "2026-05-29T00:00:02.000Z",
    });
  });

  test("reconciles inactive status snapshots with resumed journal events", async () => {
    using tmp = new DisposableTempDir("workflow-runs-status-resume-reconcile");
    const store = await createStore(tmp.path);
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:01.000Z");
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:02.000Z", {
      allowInterruptedResume: true,
    });

    const runFile = path.join(tmp.path, "workflows", "wfr_123", "run.json");
    const staleRun = JSON.parse(await fs.readFile(runFile, "utf-8")) as Record<string, unknown>;
    staleRun.status = "interrupted";
    staleRun.updatedAt = "2026-05-29T00:00:01.000Z";
    await fs.writeFile(runFile, JSON.stringify(staleRun, null, 2), "utf-8");

    await expect(store.getRun("wfr_123")).resolves.toMatchObject({
      status: "running",
      updatedAt: "2026-05-29T00:00:02.000Z",
    });
    await expect(store.getRunStatusSnapshot("wfr_123")).resolves.toMatchObject({
      status: "running",
      updatedAt: "2026-05-29T00:00:02.000Z",
    });
  });

  test("rejects invalid run ids before resolving run file paths", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = new WorkflowRunStore({ sessionDir: tmp.path });

    await expect(store.getRun("../wfr_escape")).rejects.toThrow(/runId must match/);
    await expect(store.acquireLease("wfr_../escape", "runner-a", Date.now())).rejects.toThrow(
      /runId must match/
    );
    await expect(
      store.createRun({
        id: "task_123",
        workspaceId: "workspace-1",
        workflow: definition,
        source: source,
        args: {},
        now: "2026-05-29T00:00:00.000Z",
      })
    ).rejects.toThrow(/runId must match/);
  });

  test("createRunIfAbsent recovers an incomplete deterministic run directory", async () => {
    using tmp = new DisposableTempDir("workflow-runs-partial-child");
    const store = new WorkflowRunStore({ sessionDir: tmp.path });
    await fs.mkdir(path.join(tmp.path, "workflows", "wfr_child_partial"), { recursive: true });

    const run = await store.createRunIfAbsent({
      id: "wfr_child_partial",
      workspaceId: "workspace-1",
      workflow: definition,
      source: source,
      args: { topic: "nested" },
      parentWorkflow: {
        runId: "wfr_parent",
        stepId: "child",
        inputHash: "hash:child",
        depth: 0,
      },
      now: "2026-05-29T00:00:00.000Z",
    });

    expect(run.id).toBe("wfr_child_partial");
    await expect(store.getRun("wfr_child_partial")).resolves.toMatchObject({
      id: "wfr_child_partial",
      parentWorkflow: { runId: "wfr_parent" },
    });
  });

  test("createRunIfAbsent reuses a snapshotted child run after workflow source changes", async () => {
    using tmp = new DisposableTempDir("workflow-runs-child-source-change");
    const store = new WorkflowRunStore({ sessionDir: tmp.path });
    const input = {
      id: "wfr_child_source_change",
      workspaceId: "workspace-1",
      workflow: definition,
      args: { topic: "nested" },
      parentWorkflow: {
        runId: "wfr_parent",
        stepId: "child",
        inputHash: "hash:child",
        depth: 0,
      },
      now: "2026-05-29T00:00:00.000Z",
    };
    const created = await store.createRunIfAbsent({ ...input, source: source });

    const reused = await store.createRunIfAbsent({
      ...input,
      source: "export default function workflow() { return { reportMarkdown: 'new' }; }\n",
    });

    expect(reused.id).toBe(created.id);
    expect(reused.source).toBe(source);
  });

  test("ignores malformed journal lines while preserving valid events and steps", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "phase",
      at: "2026-05-29T00:00:01.000Z",
      name: "scope",
    });
    await store.recordStepCompleted("wfr_123", {
      stepId: "scope-task",
      inputHash: "input:1",
      taskId: "task_1",
      result: { reportMarkdown: "done", structuredOutput: { ok: true } },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
    });

    await fs.appendFile(path.join(tmp.path, "workflows", "wfr_123", "events.jsonl"), "not json\n");
    await fs.appendFile(
      path.join(tmp.path, "workflows", "wfr_123", "steps.jsonl"),
      '{"bad":true}\n'
    );

    const run = await store.getRun("wfr_123");
    const completed = await store.getCompletedStep("wfr_123", "scope-task", "input:1");

    expect(run.events).toHaveLength(1);
    expect(run.steps).toHaveLength(1);
    expect(completed?.result?.structuredOutput).toEqual({ ok: true });
  });

  test("rejects duplicate or out-of-order event sequence numbers", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "log",
      at: "2026-05-29T00:00:01.000Z",
      message: "first",
    });

    await expect(
      store.appendEvent("wfr_123", {
        sequence: 1,
        type: "log",
        at: "2026-05-29T00:00:02.000Z",
        message: "duplicate",
      })
    ).rejects.toThrow(/strictly ordered/);
  });

  test("assigns unique event sequences when appending next events concurrently", async () => {
    using tmp = new DisposableTempDir("workflow-runs-append-next");
    const store = await createStore(tmp.path);

    await Promise.all([
      store.appendNextEvent("wfr_123", {
        type: "log",
        at: "2026-05-29T00:00:01.000Z",
        message: "first",
      }),
      store.appendNextEvent("wfr_123", {
        type: "log",
        at: "2026-05-29T00:00:02.000Z",
        message: "second",
      }),
      store.appendNextEvent("wfr_123", {
        type: "log",
        at: "2026-05-29T00:00:03.000Z",
        message: "third",
      }),
    ]);

    const sequences = (await store.getRun("wfr_123")).events.map((event) => event.sequence);

    expect(sequences).toEqual([1, 2, 3]);
  });

  test("records completed steps and task events in the same run snapshot", async () => {
    using tmp = new DisposableTempDir("workflow-runs-step-task-snapshot");
    const store = await createStore(tmp.path);

    await store.recordStepStarted("wfr_123", {
      stepId: "source-a",
      inputHash: "hash:source-a",
      taskId: "task_source-a",
      startedAt: "2026-05-29T00:00:01.000Z",
    });
    await store.recordStepCompletedAndAppendTaskEvent("wfr_123", {
      stepId: "source-a",
      inputHash: "hash:source-a",
      taskId: "task_source-a",
      title: "Extract claims from source 1",
      result: { reportMarkdown: "source-a" },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
    });
    const run = await store.getRun("wfr_123");

    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      stepId: "source-a",
      taskId: "task_source-a",
      status: "completed",
    });
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({
      type: "task",
      stepId: "source-a",
      taskId: "task_source-a",
      status: "completed",
      title: "Extract claims from source 1",
    });
  });

  test("records failed steps and validation task events in the same run snapshot", async () => {
    using tmp = new DisposableTempDir("workflow-runs-step-failed-task-snapshot");
    const store = await createStore(tmp.path);

    await store.recordStepStarted("wfr_123", {
      stepId: "source-b",
      inputHash: "hash:source-b",
      taskId: "task_source-b_bad",
      startedAt: "2026-05-29T00:00:01.000Z",
    });
    await store.recordStepFailedAndAppendTaskEvent("wfr_123", {
      stepId: "source-b",
      inputHash: "hash:source-b",
      taskId: "task_source-b_bad",
      title: "Extract claims from source 2",
      error: "structured output failed schema validation",
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
      validationAt: "2026-05-29T00:00:02.000Z",
      taskFailedAt: "2026-05-29T00:00:02.000Z",
    });
    const run = await store.getRun("wfr_123");

    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      stepId: "source-b",
      taskId: "task_source-b_bad",
      status: "failed",
      error: "structured output failed schema validation",
    });
    expect(run.events).toHaveLength(2);
    expect(run.events[0]).toMatchObject({
      type: "validation",
      stepId: "source-b",
      success: false,
    });
    expect(run.events[1]).toMatchObject({
      type: "task",
      stepId: "source-b",
      taskId: "task_source-b_bad",
      status: "failed",
      title: "Extract claims from source 2",
    });
  });

  test("preserves interrupted runs unless explicit resume is allowed", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:01.000Z");

    await expect(
      store.appendStatus("wfr_123", "running", "2026-05-29T00:00:02.000Z")
    ).rejects.toThrow(/interrupted/);
    await expect(
      store.appendStatus("wfr_123", "completed", "2026-05-29T00:00:02.000Z")
    ).rejects.toThrow(/interrupted/);
    await expect(
      store.appendEvent("wfr_123", {
        sequence: 2,
        type: "log",
        at: "2026-05-29T00:00:02.000Z",
        message: "too late",
      })
    ).rejects.toThrow(/interrupted/);
    await expect(
      store.recordStepCompleted("wfr_123", {
        stepId: "late-step",
        inputHash: "hash:late-step",
        taskId: "task_late",
        result: { reportMarkdown: "late" },
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:02.000Z",
      })
    ).rejects.toThrow(/interrupted/);
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "interrupted" });

    await expect(
      store.appendStatus("wfr_123", "running", "2026-05-29T00:00:03.000Z", {
        allowInterruptedResume: true,
      })
    ).resolves.toMatchObject({ status: "running" });
  });

  test("fences journal and step writes by current lease owner", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z", {
      expectedLeaseOwnerId: "runner-a",
    });
    await expect(store.acquireLease("wfr_123", "runner-b", 1012)).resolves.toBe(true);

    await expect(
      store.appendStatus("wfr_123", "completed", "2026-05-29T00:00:02.000Z", {
        expectedLeaseOwnerId: "runner-a",
      })
    ).rejects.toThrow(/lease lost/);
    await expect(
      store.recordStepCompleted(
        "wfr_123",
        {
          stepId: "read-source",
          inputHash: "source:a",
          taskId: "task_1",
          result: { reportMarkdown: "source summary" },
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:02.000Z",
        },
        { expectedLeaseOwnerId: "runner-a" }
      )
    ).rejects.toThrow(/lease lost/);
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "running" });
  });

  test("fences agent attempt writes to the current started attempt in both directions", async () => {
    using tmp = new DisposableTempDir("workflow-runs-attempt-fence");
    const store = await createStore(tmp.path);
    const attempt = { stepId: "summarize", inputHash: "hash:summarize" };

    // No checkpoint yet: neither terminal write may land.
    await expect(
      store.recordStepCompletedAndAppendTaskEvent("wfr_123", {
        ...attempt,
        taskId: "task_1",
        result: { reportMarkdown: "early" },
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:02.000Z",
      })
    ).rejects.toThrow(/not the current started attempt/);
    await expect(
      store.recordStepFailedIfCurrent("wfr_123", {
        ...attempt,
        taskId: "task_1",
        error: "no report",
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:02.000Z",
      })
    ).rejects.toThrow(/not the current started attempt/);

    await store.recordStepStarted("wfr_123", {
      ...attempt,
      taskId: "task_1",
      startedAt: "2026-05-29T00:00:01.000Z",
    });
    // Replacement attempt supersedes task_1.
    await store.recordStepFailedIfCurrent("wfr_123", {
      ...attempt,
      taskId: "task_1",
      title: "Summarize",
      error: "agent task ended without a report",
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
    });
    await store.recordStepStarted("wfr_123", {
      ...attempt,
      taskId: "task_2",
      startedAt: "2026-05-29T00:00:03.000Z",
    });

    // Obsolete attempt: late success and late failure are both rejected.
    await expect(
      store.recordStepCompletedAndAppendTaskEvent("wfr_123", {
        ...attempt,
        taskId: "task_1",
        result: { reportMarkdown: "late success" },
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:04.000Z",
      })
    ).rejects.toThrow(/not the current started attempt/);
    await expect(
      store.recordStepFailedAndAppendTaskEvent("wfr_123", {
        ...attempt,
        taskId: "task_1",
        error: "late validation failure",
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:04.000Z",
        validationAt: "2026-05-29T00:00:04.000Z",
      })
    ).rejects.toThrow(/not the current started attempt/);
    await expect(
      store.recordStepTimeoutMetadata("wfr_123", {
        ...attempt,
        taskId: "task_1",
        startedAt: "2026-05-29T00:00:01.000Z",
        timeout: { executionStartedAt: "2026-05-29T00:00:04.000Z" },
      })
    ).rejects.toThrow(/not the current started attempt/);
    // A different replay identity for the same step id is a different attempt too.
    await expect(
      store.recordStepCompletedAndAppendTaskEvent("wfr_123", {
        stepId: attempt.stepId,
        inputHash: "hash:other",
        taskId: "task_2",
        result: { reportMarkdown: "wrong identity" },
        startedAt: "2026-05-29T00:00:03.000Z",
        completedAt: "2026-05-29T00:00:04.000Z",
      })
    ).rejects.toThrow(/not the current started attempt/);

    await store.recordStepCompletedAndAppendTaskEvent("wfr_123", {
      ...attempt,
      taskId: "task_2",
      result: { reportMarkdown: "current success" },
      startedAt: "2026-05-29T00:00:03.000Z",
      completedAt: "2026-05-29T00:00:05.000Z",
    });
    // Once settled, even the current attempt cannot be rewritten.
    await expect(
      store.recordStepFailedIfCurrent("wfr_123", {
        ...attempt,
        taskId: "task_2",
        error: "late failure",
        startedAt: "2026-05-29T00:00:03.000Z",
        completedAt: "2026-05-29T00:00:06.000Z",
      })
    ).rejects.toThrow(/not the current started attempt/);

    const run = await store.getRun("wfr_123");
    expect(run.steps).toMatchObject([{ ...attempt, taskId: "task_2", status: "completed" }]);
    expect(run.events.filter((event) => event.type === "task")).toMatchObject([
      { taskId: "task_1", status: "failed", title: "Summarize" },
      { taskId: "task_2", status: "completed" },
    ]);
    expect(run.events.some((event) => event.type === "validation")).toBe(false);
  });

  test("rejects ordinary step writes on terminal runs even with a valid lease", async () => {
    using tmp = new DisposableTempDir("workflow-runs-terminal-fence");
    const store = await createStore(tmp.path);
    const attempt = { stepId: "summarize", inputHash: "hash:summarize", taskId: "task_1" };
    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    const lease = { expectedLeaseOwnerId: "runner-a" };
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z", lease);
    await store.recordStepStarted(
      "wfr_123",
      { ...attempt, startedAt: "2026-05-29T00:00:01.000Z" },
      lease
    );
    // Stop lands while the runner still holds a valid lease.
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:02.000Z");

    const lateCallbackWrites = [
      () =>
        store.recordStepCompletedAndAppendTaskEvent(
          "wfr_123",
          {
            ...attempt,
            result: { reportMarkdown: "late" },
            startedAt: "2026-05-29T00:00:01.000Z",
            completedAt: "2026-05-29T00:00:03.000Z",
          },
          lease
        ),
      () =>
        store.recordStepFailedIfCurrent(
          "wfr_123",
          {
            ...attempt,
            error: "late",
            startedAt: "2026-05-29T00:00:01.000Z",
            completedAt: "2026-05-29T00:00:03.000Z",
          },
          lease
        ),
      () =>
        store.recordStepStarted(
          "wfr_123",
          { stepId: "other", inputHash: "hash:other", startedAt: "2026-05-29T00:00:03.000Z" },
          lease
        ),
      () =>
        store.recordStepFailed(
          "wfr_123",
          {
            stepId: "other",
            inputHash: "hash:other",
            error: "late",
            startedAt: "2026-05-29T00:00:01.000Z",
            completedAt: "2026-05-29T00:00:03.000Z",
          },
          lease
        ),
      () =>
        store.appendTaskEventIfMissing(
          "wfr_123",
          { ...attempt, status: "failed", at: "2026-05-29T00:00:03.000Z" },
          lease
        ),
    ];
    for (const write of lateCallbackWrites) {
      await expect(write()).rejects.toThrow(/interrupted/);
    }

    await store.releaseLease("wfr_123", "runner-a");
    for (const terminal of ["completed", "failed"] as const) {
      using terminalTmp = new DisposableTempDir(`workflow-runs-terminal-fence-${terminal}`);
      const terminalStore = await createStore(terminalTmp.path);
      await terminalStore.recordStepStarted("wfr_123", {
        ...attempt,
        startedAt: "2026-05-29T00:00:01.000Z",
      });
      await terminalStore.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z");
      await terminalStore.appendStatus("wfr_123", terminal, "2026-05-29T00:00:02.000Z");
      await expect(
        terminalStore.recordStepFailedIfCurrent("wfr_123", {
          ...attempt,
          error: "late",
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:03.000Z",
        })
      ).rejects.toThrow(new RegExp(terminal));
      await expect(
        terminalStore.recordStepCompleted("wfr_123", {
          ...attempt,
          result: { reportMarkdown: "late" },
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:03.000Z",
        })
      ).rejects.toThrow(new RegExp(terminal));
      await expect(
        (await terminalStore.getRun("wfr_123")).steps.map((step) => step.status)
      ).toEqual(["started"]);
    }
    await expect((await store.getRun("wfr_123")).steps.map((step) => step.status)).toEqual([
      "started",
    ]);
  });

  test("accepts cancellation settlement only from the draining lease owner on an interrupted run", async () => {
    using tmp = new DisposableTempDir("workflow-runs-cancellation-settlement");
    const store = await createStore(tmp.path);
    const attemptA = { stepId: "a", inputHash: "hash:a", taskId: "task_a" };
    const attemptB = { stepId: "b", inputHash: "hash:b", taskId: "task_b" };
    const attemptC = { stepId: "c", inputHash: "hash:c", taskId: "task_c" };
    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    const lease = { expectedLeaseOwnerId: "runner-a" };
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z", lease);
    for (const attempt of [attemptA, attemptB, attemptC]) {
      await store.recordStepStarted(
        "wfr_123",
        { ...attempt, startedAt: "2026-05-29T00:00:01.000Z" },
        lease
      );
    }
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:02.000Z");

    // Only an aborted runner may open the settlement, and only the current lease owner.
    const liveSignal = new AbortController().signal;
    await expect(
      store.openCancellationSettlement("wfr_123", "runner-a", liveSignal)
    ).rejects.toThrow(/abort/);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      store.openCancellationSettlement("wfr_123", "runner-b", aborted.signal)
    ).rejects.toThrow(/lease lost/);

    using settlement = await store.openCancellationSettlement(
      "wfr_123",
      "runner-a",
      aborted.signal
    );
    const draining = { ...lease, settlement };
    await store.recordStepCompletedAndAppendTaskEvent(
      "wfr_123",
      {
        ...attemptA,
        result: { reportMarkdown: "reported before stop" },
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:03.000Z",
      },
      draining
    );
    await store.recordStepFailedIfCurrent(
      "wfr_123",
      {
        ...attemptB,
        error: "agent task ended without a report",
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:03.000Z",
      },
      draining
    );
    // The capability never authorizes another owner's writes or an obsolete attempt.
    await expect(
      store.recordStepFailedIfCurrent(
        "wfr_123",
        {
          ...attemptC,
          error: "foreign",
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:03.000Z",
        },
        { expectedLeaseOwnerId: "runner-b", settlement }
      )
    ).rejects.toThrow(/lease/);
    await expect(
      store.recordStepFailedIfCurrent(
        "wfr_123",
        {
          ...attemptA,
          error: "obsolete",
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:03.000Z",
        },
        draining
      )
    ).rejects.toThrow(/not the current started attempt/);
    // Ordinary (non-settlement) writes stay rejected while interrupted.
    await expect(
      store.recordStepFailedIfCurrent(
        "wfr_123",
        {
          ...attemptC,
          error: "ordinary",
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:03.000Z",
        },
        lease
      )
    ).rejects.toThrow(/interrupted/);

    const run = await store.getRun("wfr_123");
    expect(run.status).toBe("interrupted");
    expect(run.steps.map((step) => [step.taskId, step.status])).toEqual([
      ["task_a", "completed"],
      ["task_b", "failed"],
      ["task_c", "started"],
    ]);
    expect(run.events.filter((event) => event.type === "task")).toMatchObject([
      { taskId: "task_a", status: "completed" },
      { taskId: "task_b", status: "failed" },
    ]);

    // A closed capability is inert; a re-opened one still cannot touch completed/failed runs.
    settlement.close();
    await expect(
      store.recordStepFailedIfCurrent(
        "wfr_123",
        {
          ...attemptC,
          error: "after close",
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:04.000Z",
        },
        draining
      )
    ).rejects.toThrow(/interrupted/);
    await store.releaseLease("wfr_123", "runner-a");

    // A failed run stays closed to settlement even for its own draining lease owner.
    using failedTmp = new DisposableTempDir("workflow-runs-cancellation-settlement-failed");
    const failedStore = await createStore(failedTmp.path);
    await expect(failedStore.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    await failedStore.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z", lease);
    await failedStore.recordStepStarted(
      "wfr_123",
      { ...attemptC, startedAt: "2026-05-29T00:00:01.000Z" },
      lease
    );
    await failedStore.appendStatus("wfr_123", "failed", "2026-05-29T00:00:02.000Z", lease);
    using reopened = await failedStore.openCancellationSettlement(
      "wfr_123",
      "runner-a",
      aborted.signal
    );
    await expect(
      failedStore.recordStepFailedIfCurrent(
        "wfr_123",
        {
          ...attemptC,
          error: "terminal run",
          startedAt: "2026-05-29T00:00:01.000Z",
          completedAt: "2026-05-29T00:00:03.000Z",
        },
        { ...lease, settlement: reopened }
      )
    ).rejects.toThrow(/failed/);
    await failedStore.releaseLease("wfr_123", "runner-a");
  });

  test("authorizes replay adoption by the current lease during the resume transition only", async () => {
    using tmp = new DisposableTempDir("workflow-runs-replay-adoption");
    const store = await createStore(tmp.path);
    const attempt = { stepId: "summarize", inputHash: "hash:summarize", taskId: "task_prior" };
    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z", {
      expectedLeaseOwnerId: "runner-a",
    });
    await store.recordStepStarted(
      "wfr_123",
      { ...attempt, startedAt: "2026-05-29T00:00:01.000Z" },
      { expectedLeaseOwnerId: "runner-a" }
    );
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:02.000Z");
    await store.releaseLease("wfr_123", "runner-a");

    await expect(store.acquireLease("wfr_123", "runner-b", 2000)).resolves.toBe(true);
    const newLease = { expectedLeaseOwnerId: "runner-b" };
    const adoption = {
      ...attempt,
      result: { reportMarkdown: "prior attempt report" },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:03.000Z",
    };
    // Holding the lease is not enough before the resume transition is durable.
    await expect(
      store.recordStepCompletedAndAppendTaskEvent("wfr_123", adoption, newLease)
    ).rejects.toThrow(/interrupted/);
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:03.000Z", {
      ...newLease,
      allowInterruptedResume: true,
    });
    // The stale original lease cannot adopt; exact checkpoint identity is required.
    await expect(
      store.recordStepCompletedAndAppendTaskEvent("wfr_123", adoption, {
        expectedLeaseOwnerId: "runner-a",
      })
    ).rejects.toThrow(/lease lost/);
    await expect(
      store.recordStepCompletedAndAppendTaskEvent(
        "wfr_123",
        { ...adoption, taskId: "task_other" },
        newLease
      )
    ).rejects.toThrow(/not the current started attempt/);
    await store.recordStepCompletedAndAppendTaskEvent("wfr_123", adoption, newLease);

    const run = await store.getRun("wfr_123");
    expect(run.steps).toMatchObject([{ ...attempt, status: "completed" }]);
    expect(run.events.filter((event) => event.type === "task")).toMatchObject([
      { taskId: "task_prior", status: "completed" },
    ]);
    await store.releaseLease("wfr_123", "runner-b");
  });

  test("replays crash-split journals: task event without step and step without task event", async () => {
    using tmp = new DisposableTempDir("workflow-runs-split-journals");
    const store = await createStore(tmp.path);
    const runDir = path.join(tmp.path, "workflows", "wfr_123");
    await store.recordStepStarted("wfr_123", {
      stepId: "a",
      inputHash: "hash:a",
      taskId: "task_a",
      startedAt: "2026-05-29T00:00:01.000Z",
    });
    await store.recordStepStarted("wfr_123", {
      stepId: "b",
      inputHash: "hash:b",
      taskId: "task_b",
      startedAt: "2026-05-29T00:00:01.000Z",
    });
    // Crash after the task event append but before the step record (event-without-step).
    await fs.appendFile(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({
        sequence: 1,
        type: "task",
        at: "2026-05-29T00:00:02.000Z",
        stepId: "a",
        taskId: "task_a",
        status: "completed",
      })}\n`
    );
    // Crash after the step record but before the task event (step-without-event).
    await fs.appendFile(
      path.join(runDir, "steps.jsonl"),
      `${JSON.stringify({
        stepId: "b",
        inputHash: "hash:b",
        taskId: "task_b",
        status: "completed",
        result: { reportMarkdown: "b done" },
        startedAt: "2026-05-29T00:00:01.000Z",
        completedAt: "2026-05-29T00:00:02.000Z",
      })}\n`
    );

    const replayed = await store.getRun("wfr_123");
    // The step record, not the event, is the checkpoint: "a" is still started and replayable.
    expect(replayed.steps).toMatchObject([
      { stepId: "a", status: "started" },
      { stepId: "b", status: "completed" },
    ]);
    await expect(store.getCompletedStep("wfr_123", "a", "hash:a")).resolves.toBeNull();
    await expect(store.getCompletedStep("wfr_123", "b", "hash:b")).resolves.toMatchObject({
      result: { reportMarkdown: "b done" },
    });

    // Settling "a" for real dedupes the orphaned task event; backfilling "b" adds exactly one.
    await store.recordStepCompletedAndAppendTaskEvent("wfr_123", {
      stepId: "a",
      inputHash: "hash:a",
      taskId: "task_a",
      result: { reportMarkdown: "a done" },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:03.000Z",
    });
    await store.appendTaskEventIfMissing("wfr_123", {
      stepId: "b",
      taskId: "task_b",
      status: "completed",
      at: "2026-05-29T00:00:03.000Z",
    });
    const settled = await store.getRun("wfr_123");
    expect(settled.events.filter((event) => event.type === "task")).toMatchObject([
      { stepId: "a", taskId: "task_a", status: "completed" },
      { stepId: "b", taskId: "task_b", status: "completed" },
    ]);
    expect(settled.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
  });

  test("replays terminal status from journal when run file is stale", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);
    await fs.appendFile(
      path.join(tmp.path, "workflows", "wfr_123", "events.jsonl"),
      `${JSON.stringify({
        sequence: 1,
        type: "status",
        at: "2026-05-29T00:00:01.000Z",
        status: "completed",
      })}\n`,
      "utf-8"
    );

    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "completed" });
    await expect(
      store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:02.000Z")
    ).rejects.toThrow(/Cannot transition/);
  });

  test("uses the atomic run file snapshot while a writer lock is active", async () => {
    using tmp = new DisposableTempDir("workflow-runs-active-writer-snapshot");
    const store = await createStore(tmp.path);
    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z");
    // A real writer, paused after its journal append and before its run.json rewrite: only its
    // held events lock tells readers that the journal is ahead of the snapshot.
    const pause = pauseNext(store, "writeRunFile");
    const writer = store.appendStatus("wfr_123", "completed", "2026-05-29T00:00:02.000Z");
    await pause.entered;

    const whileWriting = (await store.getRun("wfr_123")).status;
    pause.release();
    await writer;

    expect({ whileWriting, after: (await store.getRun("wfr_123")).status }).toEqual({
      whileWriting: "running",
      after: "completed",
    });
  });

  test("does not overwrite terminal runs with later interrupt status", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z");
    await store.appendStatus("wfr_123", "completed", "2026-05-29T00:00:02.000Z");

    await expect(
      store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:03.000Z")
    ).rejects.toThrow(/Cannot transition/);
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "completed" });
  });

  test("requires explicit checkpoint retry permission to reopen failed runs", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z");
    await store.appendStatus("wfr_123", "failed", "2026-05-29T00:00:02.000Z");

    await expect(
      store.appendStatus("wfr_123", "running", "2026-05-29T00:00:03.000Z")
    ).rejects.toThrow(/Cannot transition/);
    await expect(
      store.appendStatus("wfr_123", "running", "2026-05-29T00:00:04.000Z", {
        allowFailedCheckpointRetry: true,
      })
    ).resolves.toMatchObject({ status: "running" });
  });

  test("reuses completed steps by stable step id and input hash", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await store.recordStepStarted("wfr_123", {
      stepId: "read-source",
      inputHash: "source:a",
      taskId: "task_1",
      startedAt: "2026-05-29T00:00:01.000Z",
    });
    await store.recordStepCompleted("wfr_123", {
      stepId: "read-source",
      inputHash: "source:a",
      taskId: "task_1",
      result: { reportMarkdown: "source summary" },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
    });

    await expect(store.getCompletedStep("wfr_123", "read-source", "source:b")).resolves.toBeNull();
    await expect(
      store.getCompletedStep("wfr_123", "read-source", "source:a")
    ).resolves.toMatchObject({
      status: "completed",
      result: { reportMarkdown: "source summary" },
    });
  });

  test("renews active leases so they are not reclaimed as stale", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    await expect(store.renewLease("wfr_123", "runner-a", 1008)).resolves.toBe(true);
    await expect(store.acquireLease("wfr_123", "runner-b", 1012)).resolves.toBe(false);
    await expect(store.acquireLease("wfr_123", "runner-b", 1019)).resolves.toBe(true);
  });

  test("does not acquire through an active lease mutation lock", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    const releaseLock = await holdStoreLock(
      path.join(tmp.path, "workflows", "wfr_123", "lease.json.xlock")
    );

    await expect(store.acquireLease("wfr_123", "runner-b", 1012)).resolves.toBe(false);

    await releaseLock();
    await expect(store.acquireLease("wfr_123", "runner-b", 1012)).resolves.toBe(true);
  });

  test("serializes renewal with lease ownership changes", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    const runDir = path.join(tmp.path, "workflows", "wfr_123");
    const leaseFile = path.join(runDir, "lease.json");
    // A fenced journal write holds the lease lock while paused.
    const holder = pauseNext(store, "getRunUnlocked");
    const fencedWrite = store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z", {
      expectedLeaseOwnerId: "runner-a",
    });
    await holder.entered;

    const renewal = store.renewLease("wfr_123", "runner-a", 1005);
    await fs.writeFile(leaseFile, JSON.stringify({ ownerId: "runner-b", acquiredAtMs: 1004 }));
    holder.release();
    await fencedWrite;

    await expect(renewal).resolves.toBe(false);
    await expect(fs.readFile(leaseFile, "utf-8")).resolves.toContain("runner-b");
  });

  test("release waits for in-flight lease mutations", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path, 100);

    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    const leaseFile = path.join(tmp.path, "workflows", "wfr_123", "lease.json");
    const holder = pauseNext(store, "getRunUnlocked");
    const fencedWrite = store.appendStatus("wfr_123", "running", "2026-05-29T00:00:01.000Z", {
      expectedLeaseOwnerId: "runner-a",
    });
    await holder.entered;

    const release = store.releaseLease("wfr_123", "runner-a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(fs.readFile(leaseFile, "utf-8")).resolves.toContain("runner-a");

    holder.release();
    await fencedWrite;
    await release;

    await expect(store.acquireLease("wfr_123", "runner-b", 1001)).resolves.toBe(true);
  });

  test("prevents concurrent runners while allowing stale lease recovery", async () => {
    using tmp = new DisposableTempDir("workflow-runs");
    const store = await createStore(tmp.path);

    await expect(store.acquireLease("wfr_123", "runner-a", 1000)).resolves.toBe(true);
    await expect(store.acquireLease("wfr_123", "runner-a", 1001)).resolves.toBe(false);
    await expect(store.acquireLease("wfr_123", "runner-b", 1001)).resolves.toBe(false);
    await expect(store.acquireLease("wfr_123", "runner-b", 1012)).resolves.toBe(true);
  });
});

describe("isPathSafeWorkspaceId", () => {
  test("accepts single-segment ids and rejects traversal attempts", () => {
    expect(isPathSafeWorkspaceId("workspace-1")).toBe(true);
    for (const unsafe of [
      "",
      ".",
      "..",
      "../evil",
      "..\\evil",
      "a/../b",
      "nested/dir",
      "/absolute",
      "C:\\sessions",
    ]) {
      expect(isPathSafeWorkspaceId(unsafe)).toBe(false);
    }
  });
});
