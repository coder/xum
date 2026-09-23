import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { AssertionError } from "@/common/utils/assert";
import { KeepAwakeController, type PowerSaveBlockerLike } from "./keepAwake";

class FakeBlocker implements PowerSaveBlockerLike {
  private nextId = 1;
  private readonly running = new Set<number>();
  readonly startCalls: string[] = [];
  readonly startedIds: number[] = [];
  readonly stopCalls: number[] = [];
  /** When false, `isStarted` lies about freshly started ids (defensive-path test). */
  reportsStarted = true;

  start(type: "prevent-display-sleep"): number {
    const id = this.nextId++;
    this.running.add(id);
    this.startCalls.push(type);
    this.startedIds.push(id);
    return id;
  }

  stop(id: number): boolean {
    this.stopCalls.push(id);
    return this.running.delete(id);
  }

  isStarted(id: number): boolean {
    return this.reportsStarted && this.running.has(id);
  }

  get runningCount(): number {
    return this.running.size;
  }
}

function snapshot(overrides: Partial<WorkspaceActivitySnapshot> = {}): WorkspaceActivitySnapshot {
  return {
    recency: 0,
    streaming: false,
    lastModel: null,
    lastThinkingLevel: null,
    ...overrides,
  };
}

interface Harness {
  blocker: FakeBlocker;
  controller: KeepAwakeController;
  emit: (workspaceId: string, activity: WorkspaceActivitySnapshot | null) => boolean;
  setEnabled: (enabled: boolean) => void;
  activityListenerCount: () => number;
}

function createHarness(options: {
  enabled?: boolean;
  activityList?: () => Promise<Record<string, WorkspaceActivitySnapshot> | null>;
}): Harness {
  const blocker = new FakeBlocker();
  const activityEmitter = new EventEmitter();
  const configEmitter = new EventEmitter();
  let enabled = options.enabled ?? false;

  const controller = new KeepAwakeController({
    blocker,
    isEnabled: () => enabled,
    onEnabledChanged: (callback) => {
      configEmitter.on("changed", callback);
      return () => {
        configEmitter.off("changed", callback);
      };
    },
    activity: {
      on: (event, listener) => activityEmitter.on(event, listener),
      off: (event, listener) => activityEmitter.off(event, listener),
      getActivityList: options.activityList ?? (() => Promise.resolve({})),
    },
  });

  return {
    blocker,
    controller,
    emit: (workspaceId, activity) => activityEmitter.emit("activity", { workspaceId, activity }),
    setEnabled: (next) => {
      enabled = next;
      configEmitter.emit("changed");
    },
    activityListenerCount: () => activityEmitter.listenerCount("activity"),
  };
}

describe("KeepAwakeController", () => {
  test("never starts a blocker while the setting is disabled", async () => {
    const h = createHarness({ enabled: false });
    await h.controller.start();

    h.emit("a", snapshot({ streaming: true }));
    h.emit("b", snapshot({ activeBashMonitorCount: 1 }));

    expect(h.blocker.startCalls).toEqual([]);
    expect(h.controller.isHoldingBlocker).toBe(false);
  });

  test("holds exactly one blocker across overlapping busy workspaces", async () => {
    const h = createHarness({ enabled: true });
    await h.controller.start();

    h.emit("a", snapshot({ streaming: true }));
    expect(h.blocker.startCalls).toEqual(["prevent-display-sleep"]);
    expect(h.controller.isHoldingBlocker).toBe(true);

    // A second busy workspace (armed bash monitor) must not start a second blocker.
    h.emit("b", snapshot({ activeBashMonitorCount: 1 }));
    expect(h.blocker.startCalls).toHaveLength(1);

    // First workspace goes idle: still held for the second.
    h.emit("a", snapshot({ streaming: false }));
    expect(h.blocker.stopCalls).toEqual([]);
    expect(h.controller.isHoldingBlocker).toBe(true);

    // Last busy workspace goes idle: released exactly once.
    h.emit("b", snapshot({ activeBashMonitorCount: 0 }));
    expect(h.blocker.stopCalls).toEqual([h.blocker.startedIds[0]]);
    expect(h.blocker.runningCount).toBe(0);
    expect(h.controller.isHoldingBlocker).toBe(false);
  });

  test("workflow runs count as busy and a null activity clears the workspace", async () => {
    const h = createHarness({ enabled: true });
    await h.controller.start();

    h.emit("a", snapshot({ activeWorkflowRunCount: 2 }));
    expect(h.controller.isHoldingBlocker).toBe(true);

    // Workspace removed while its workflow run was still counted.
    h.emit("a", null);
    expect(h.controller.isHoldingBlocker).toBe(false);
    expect(h.blocker.stopCalls).toHaveLength(1);
  });

  test("ignores goal-only activity pushes", async () => {
    const h = createHarness({ enabled: true });
    await h.controller.start();

    // A goal overlay on a stale baseline must neither acquire...
    h.emit("a", snapshot({ streaming: true, transientGoalOnly: true }));
    expect(h.blocker.startCalls).toEqual([]);

    h.emit("a", snapshot({ streaming: true }));
    expect(h.controller.isHoldingBlocker).toBe(true);

    // ...nor release while the workspace is otherwise still busy.
    h.emit("a", snapshot({ streaming: false, transientGoalOnly: true }));
    expect(h.controller.isHoldingBlocker).toBe(true);
    expect(h.blocker.stopCalls).toEqual([]);
  });

  test("reacts to the setting toggling while workspaces are busy", async () => {
    const h = createHarness({ enabled: false });
    await h.controller.start();

    h.emit("a", snapshot({ streaming: true }));
    expect(h.blocker.startCalls).toEqual([]);

    h.setEnabled(true);
    expect(h.blocker.startCalls).toHaveLength(1);
    expect(h.controller.isHoldingBlocker).toBe(true);

    h.setEnabled(false);
    expect(h.blocker.stopCalls).toEqual([h.blocker.startedIds[0]]);
    expect(h.controller.isHoldingBlocker).toBe(false);

    // Unrelated config edits while already in the wanted state are idempotent.
    h.setEnabled(false);
    expect(h.blocker.startCalls).toHaveLength(1);
    expect(h.blocker.stopCalls).toHaveLength(1);

    h.setEnabled(true);
    expect(h.blocker.startCalls).toHaveLength(2);
    expect(h.blocker.startedIds[1]).not.toBe(h.blocker.startedIds[0]);
    expect(h.controller.isHoldingBlocker).toBe(true);
  });

  test("seeds from the activity list and acquires for an already-streaming workspace", async () => {
    const h = createHarness({
      enabled: true,
      activityList: () =>
        Promise.resolve({
          idle: snapshot(),
          streaming: snapshot({ streaming: true }),
        }),
    });
    await h.controller.start();

    expect(h.blocker.startCalls).toHaveLength(1);
    expect(h.controller.isHoldingBlocker).toBe(true);

    h.emit("streaming", snapshot({ streaming: false }));
    expect(h.controller.isHoldingBlocker).toBe(false);
  });

  test("a live event during the seed read wins over the older snapshot", async () => {
    let resolveList: (value: Record<string, WorkspaceActivitySnapshot>) => void = () => {
      throw new Error("activity list resolver not initialised");
    };
    const h = createHarness({
      enabled: true,
      activityList: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });

    const started = h.controller.start();
    // The stream the snapshot will still report as active has already ended...
    h.emit("ended", snapshot({ streaming: false }));
    // ...and a stream the snapshot predates has started.
    h.emit("fresh", snapshot({ activeBashMonitorCount: 1 }));
    resolveList({ ended: snapshot({ streaming: true }), fresh: snapshot() });
    await started;

    expect(h.controller.isHoldingBlocker).toBe(true);
    // Only "fresh" is busy: releasing it must drop the blocker even though the snapshot
    // claimed "ended" was streaming.
    h.emit("fresh", snapshot({ activeBashMonitorCount: 0 }));
    expect(h.controller.isHoldingBlocker).toBe(false);
  });

  // Desktop startup does not wait for the seed read (it can be slow on large workspace
  // stores), so live events and quit can both arrive while it is still in flight.
  test("live events acquire and release before the seed read settles", async () => {
    let resolveList: (value: Record<string, WorkspaceActivitySnapshot>) => void = () => {
      throw new Error("activity list resolver not initialised");
    };
    const h = createHarness({
      enabled: true,
      activityList: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });

    const started = h.controller.start();
    h.emit("a", snapshot({ streaming: true }));
    expect(h.controller.isHoldingBlocker).toBe(true);
    h.emit("a", snapshot({ streaming: false }));
    expect(h.controller.isHoldingBlocker).toBe(false);

    resolveList({});
    await started;
    expect(h.blocker.startCalls).toHaveLength(1);
    expect(h.controller.isHoldingBlocker).toBe(false);
  });

  test("dispose during the seed read releases and ignores the late snapshot", async () => {
    let resolveList: (value: Record<string, WorkspaceActivitySnapshot>) => void = () => {
      throw new Error("activity list resolver not initialised");
    };
    const h = createHarness({
      enabled: true,
      activityList: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });

    const started = h.controller.start();
    h.emit("a", snapshot({ streaming: true }));
    expect(h.controller.isHoldingBlocker).toBe(true);

    h.controller.dispose();
    expect(h.blocker.runningCount).toBe(0);
    expect(h.activityListenerCount()).toBe(0);

    resolveList({ b: snapshot({ streaming: true }) });
    await started;
    expect(h.blocker.startCalls).toHaveLength(1);
    expect(h.controller.isHoldingBlocker).toBe(false);
  });

  test("dispose releases the blocker and stops reacting to later events", async () => {
    const h = createHarness({ enabled: true });
    await h.controller.start();

    h.emit("a", snapshot({ streaming: true }));
    expect(h.controller.isHoldingBlocker).toBe(true);

    h.controller.dispose();
    expect(h.blocker.stopCalls).toEqual([h.blocker.startedIds[0]]);
    expect(h.blocker.runningCount).toBe(0);
    expect(h.activityListenerCount()).toBe(0);

    h.emit("b", snapshot({ streaming: true }));
    h.setEnabled(true);
    expect(h.blocker.startCalls).toHaveLength(1);
    expect(h.controller.isHoldingBlocker).toBe(false);

    // Idempotent.
    h.controller.dispose();
    expect(h.blocker.stopCalls).toHaveLength(1);
  });

  test("asserts when the blocker reports a freshly started id as not running", async () => {
    const h = createHarness({
      enabled: true,
      activityList: () => Promise.resolve({ a: snapshot({ streaming: true }) }),
    });
    h.blocker.reportsStarted = false;

    const startOutcome = await h.controller.start().then(
      () => "resolved",
      (error: unknown) => error
    );
    expect(startOutcome).toBeInstanceOf(AssertionError);
    expect((startOutcome as AssertionError).message).toMatch(/not running/);
    expect(h.controller.isHoldingBlocker).toBe(false);

    // Listener failures stay inside the controller: the emitter (WorkspaceService) must
    // never see the assertion thrown from an activity event.
    expect(() => h.emit("b", snapshot({ streaming: true }))).not.toThrow();
    expect(h.controller.isHoldingBlocker).toBe(false);
  });
});
