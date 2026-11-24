import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import type { ProjectsConfig } from "@/node/config";
import { log } from "@/node/services/log";
import {
  TerminalAttentionNotifier,
  WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS,
} from "@/node/services/terminalAttentionNotifier";
import {
  TerminalAttentionStore,
  type TerminalAttentionNotification,
} from "@/node/services/terminalAttentionStore";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(notifier: TerminalAttentionNotifier): Promise<void> {
  for (let i = 0; i < 5 && notifier.pendingTerminalAttentionDrains.size > 0; i++) {
    await Promise.all([...notifier.pendingTerminalAttentionDrains]);
  }
}

function createHarness() {
  const events: string[] = [];
  let streaming = false;
  const turn = Symbol("turn");
  let created: TerminalAttentionNotification | null = null;
  let pendingOwners: string[] = [];
  let config: ProjectsConfig = { projects: new Map() };
  const store = {
    enqueueIfAbsent: mock((params: Parameters<TerminalAttentionStore["enqueueIfAbsent"]>[0]) => {
      events.push(`enqueue:${params.sourceKind}:${params.terminalOutcome ?? ""}`);
      return Promise.resolve(created);
    }),
    markSuperseded: mock((owner: string, id: string) => {
      events.push(`superseded:${owner}:${id}`);
      return Promise.resolve();
    }),
    listPendingOwnerWorkspaceIds: mock(() => Promise.resolve(pendingOwners)),
  };
  const idleWaits: Array<ReturnType<typeof deferred>> = [];
  const workspaceService = {
    getActiveTurnGeneration: mock((_id: string) => turn),
    waitForIdleAndNoQueuedMessages: mock((_id: string) => {
      const wait = deferred();
      idleWaits.push(wait);
      return wait.promise;
    }),
  };
  const turnManager = {
    markWorkspaceTurnBackgroundWorkNotifyOnTerminal: mock((taskId: string, owner: string) => {
      events.push(`turn-policy:${taskId}:${owner}`);
      return Promise.resolve();
    }),
  };
  const editConfig = mock(async (fn: (c: ProjectsConfig) => ProjectsConfig) => {
    config = fn(config);
    await Promise.resolve();
  });
  let drainImpl: (owner: string) => Promise<void> = (owner) => {
    events.push(`drain:${owner}`);
    return Promise.resolve();
  };
  const drain = mock((owner: string) => drainImpl(owner));
  const notifier = new TerminalAttentionNotifier({
    terminalAttentionStore: () => store,
    config: () => ({ editConfig }),
    aiService: () => ({ isStreaming: () => streaming }),
    workspaceService: () => workspaceService,
    turnManager: () => turnManager,
    drain,
  });
  return {
    notifier,
    events,
    turn,
    store,
    workspaceService,
    turnManager,
    editConfig,
    drain,
    idleWaits,
    get config() {
      return config;
    },
    set config(value: ProjectsConfig) {
      config = value;
    },
    setStreaming(value: boolean) {
      streaming = value;
    },
    setCreated(value: TerminalAttentionNotification | null) {
      created = value;
    },
    setPendingOwners(value: string[]) {
      pendingOwners = value;
    },
    setDrain(impl: (owner: string) => Promise<void>) {
      drainImpl = impl;
    },
  };
}

function notification(
  sourceKind: TerminalAttentionNotification["sourceKind"],
  id = "n1"
): TerminalAttentionNotification {
  return {
    id,
    ownerWorkspaceId: "owner",
    sourceKind,
    sourceId: "child",
    outputDelivery: "already_injected",
    terminalOutcome: "completed",
    status: "pending",
    createdAt: new Date(0).toISOString(),
  };
}

// Silence the expected failure logs; tests assert the log call itself.
let logError: ReturnType<typeof spyOn<typeof log, "error">>;
beforeEach(() => {
  logError = spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  setSystemTime();
  logError.mockRestore();
});

describe("TerminalAttentionNotifier drain scheduling", () => {
  test("serializes drains per owner and clears the tail only after the last one", async () => {
    const h = createHarness();
    const first = deferred();
    let calls = 0;
    h.setDrain((owner) => {
      calls++;
      h.events.push(`start:${owner}:${calls}`);
      return calls === 1 ? first.promise : Promise.resolve();
    });

    h.notifier.scheduleTerminalAttentionDrain("owner");
    h.notifier.scheduleTerminalAttentionDrain("owner");
    h.notifier.scheduleTerminalAttentionDrain("other");
    // Tracked in the same tick as the schedule call.
    expect(h.notifier.pendingTerminalAttentionDrains.size).toBe(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.events).toEqual(["start:owner:1", "start:other:2"]);

    first.resolve();
    await flush(h.notifier);
    expect(h.events).toEqual(["start:owner:1", "start:other:2", "start:owner:3"]);
    expect(h.notifier.pendingTerminalAttentionDrainsByOwner.size).toBe(0);
    expect(h.notifier.pendingTerminalAttentionDrains.size).toBe(0);
  });

  test("a failed drain does not block the owner's next drain", async () => {
    const h = createHarness();
    let calls = 0;
    h.setDrain(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });

    h.notifier.scheduleTerminalAttentionDrain("owner");
    h.notifier.scheduleTerminalAttentionDrain("owner");
    await flush(h.notifier);
    expect(h.drain).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  test("an earlier chain link settling keeps the newer tail registered", async () => {
    const h = createHarness();
    const second = deferred();
    let calls = 0;
    h.setDrain(() => {
      calls++;
      return calls === 2 ? second.promise : Promise.resolve();
    });

    h.notifier.scheduleTerminalAttentionDrain("owner");
    h.notifier.scheduleTerminalAttentionDrain("owner");
    const tail = h.notifier.pendingTerminalAttentionDrainsByOwner.get("owner");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls).toBe(2);
    expect(h.notifier.pendingTerminalAttentionDrainsByOwner.get("owner")).toBe(tail);

    second.resolve();
    await flush(h.notifier);
    expect(h.notifier.pendingTerminalAttentionDrainsByOwner.has("owner")).toBe(false);
  });

  test("re-pokes every owner with pending notifications", async () => {
    const h = createHarness();
    h.setPendingOwners(["a", "b"]);
    expect(await h.notifier.schedulePendingTerminalAttentionOwnerDrains()).toBe(2);
    await flush(h.notifier);
    expect(h.events).toEqual(["drain:a", "drain:b"]);
  });

  test("tracked work is awaited with the drains until untracked", () => {
    const h = createHarness();
    const work = Promise.resolve();
    h.notifier.trackDrain(work);
    expect([...h.notifier.pendingTerminalAttentionDrains]).toEqual([work]);
    h.notifier.untrackDrain(work);
    expect(h.notifier.pendingTerminalAttentionDrains.size).toBe(0);
  });
});

describe("TerminalAttentionNotifier idle waits", () => {
  test("installs one idle wait per owner and drains once it settles", async () => {
    const h = createHarness();
    h.notifier.scheduleTerminalAttentionDrainAfterIdle("owner");
    h.notifier.scheduleTerminalAttentionDrainAfterIdle("owner");
    expect(h.workspaceService.waitForIdleAndNoQueuedMessages).toHaveBeenCalledTimes(1);
    expect(h.drain).not.toHaveBeenCalled();

    h.idleWaits[0].resolve();
    await flush(h.notifier);
    expect(h.events).toEqual(["drain:owner"]);
  });

  test("a failed idle wait still drains", async () => {
    const h = createHarness();
    h.notifier.scheduleTerminalAttentionDrainAfterIdle("owner");
    h.idleWaits[0].reject(new Error("session gone"));
    await flush(h.notifier);
    expect(h.events).toEqual(["drain:owner"]);
  });

  test("releases the slot before the drain, so a busy drain can wait again", async () => {
    const h = createHarness();
    let calls = 0;
    h.setDrain((owner) => {
      calls++;
      if (calls === 1) h.notifier.scheduleTerminalAttentionDrainAfterIdle(owner);
      return Promise.resolve();
    });
    h.notifier.scheduleTerminalAttentionDrainAfterIdle("owner");
    h.idleWaits[0].resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.workspaceService.waitForIdleAndNoQueuedMessages).toHaveBeenCalledTimes(2);

    h.idleWaits[1].resolve();
    await flush(h.notifier);
    expect(h.drain).toHaveBeenCalledTimes(2);
  });
});

describe("TerminalAttentionNotifier enqueue", () => {
  test("records a fresh edge for an agent task delivered into a live turn", async () => {
    const h = createHarness();
    h.setStreaming(true);
    h.setCreated(notification("agent_task", "agent_task:child"));
    h.setDrain((owner) => {
      // The drain sees the fresh edge: it was written before scheduling.
      h.events.push(`drain:${owner}:${h.notifier.takeFreshTurns(owner).size}`);
      return Promise.resolve();
    });

    await h.notifier.enqueueTerminalAttention({
      ownerWorkspaceId: "owner",
      sourceKind: "agent_task",
      terminalOutcome: "completed",
      sourceId: "child",
    });
    await flush(h.notifier);
    expect(h.events).toEqual(["enqueue:agent_task:completed", "drain:owner:1"]);
    // Taken once: the next take is empty.
    expect(h.notifier.takeFreshTurns("owner").size).toBe(0);
  });

  test("keeps the live turn per notification for the next drain", async () => {
    const h = createHarness();
    h.setStreaming(true);
    h.setDrain(() => new Promise(() => undefined));
    for (const id of ["a", "b"]) {
      h.setCreated(notification("agent_task", id));
      await h.notifier.enqueueTerminalAttention({
        ownerWorkspaceId: "owner",
        sourceKind: "agent_task",
        terminalOutcome: "completed",
        sourceId: id,
      });
    }
    expect([...h.notifier.takeFreshTurns("owner")]).toEqual([
      ["a", h.turn],
      ["b", h.turn],
    ]);
  });

  test("records no fresh edge for an idle owner or a workspace turn", async () => {
    const h = createHarness();
    h.setCreated(notification("agent_task"));
    await h.notifier.enqueueTerminalAttention({
      ownerWorkspaceId: "owner",
      sourceKind: "agent_task",
      terminalOutcome: "completed",
      sourceId: "child",
    });
    h.setStreaming(true);
    h.setCreated(notification("workspace_turn"));
    await h.notifier.enqueueTerminalAttention({
      ownerWorkspaceId: "owner",
      sourceKind: "workspace_turn",
      terminalOutcome: "completed",
      sourceId: "wst_child",
    });
    await flush(h.notifier);
    expect(h.notifier.takeFreshTurns("owner").size).toBe(0);
    expect(h.drain).toHaveBeenCalledTimes(2);
  });

  test("schedules nothing when the notification already exists", async () => {
    const h = createHarness();
    await h.notifier.enqueueTerminalAttention({
      ownerWorkspaceId: "owner",
      sourceKind: "agent_task",
      terminalOutcome: "completed",
      sourceId: "child",
    });
    expect(h.notifier.pendingTerminalAttentionDrains.size).toBe(0);
    expect(h.drain).not.toHaveBeenCalled();
  });

  test("suppression writes an interrupted record, then marks it superseded", async () => {
    const h = createHarness();
    await h.notifier.suppressTerminalAttention({
      ownerWorkspaceId: "owner",
      sourceKind: "workspace_turn",
      sourceId: "wst_child",
    });
    expect(h.events).toEqual([
      "enqueue:workspace_turn:interrupted",
      `superseded:owner:${TerminalAttentionStore.notificationId("workspace_turn", "wst_child")}`,
    ]);
    expect(h.drain).not.toHaveBeenCalled();
  });
});

describe("TerminalAttentionNotifier send backoff", () => {
  test("backs keys off for one sweep interval, then expires them on read", async () => {
    const h = createHarness();
    setSystemTime(new Date(1_000_000));
    h.notifier.backOffTerminalWakeSends("owner", ["group", "other"]);
    // Backoff is written before the drain it schedules.
    expect(h.notifier.pendingTerminalAttentionDrainsByOwner.has("owner")).toBe(true);
    await flush(h.notifier);
    expect(h.events).toEqual(["drain:owner"]);

    expect(h.notifier.isWakeSendBackedOff("owner", "group")).toBe(true);
    expect(h.notifier.isWakeSendBackedOff("owner", "unknown")).toBe(false);
    expect(h.notifier.isWakeSendBackedOff("stranger", "group")).toBe(false);

    setSystemTime(new Date(1_000_000 + WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS));
    expect(h.notifier.isWakeSendBackedOff("owner", "group")).toBe(false);
    // Expired entries are gone: a later clock rewind does not revive them.
    setSystemTime(new Date(1_000_000));
    expect(h.notifier.isWakeSendBackedOff("owner", "group")).toBe(false);
    expect(h.notifier.isWakeSendBackedOff("owner", "other")).toBe(true);
  });

  test("dropping the owner's last expired key does not drop a later backoff", () => {
    const h = createHarness();
    setSystemTime(new Date(1_000_000));
    h.notifier.backOffTerminalWakeSends("owner", ["a"]);
    setSystemTime(new Date(1_000_000 + WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS + 1));
    expect(h.notifier.isWakeSendBackedOff("owner", "a")).toBe(false);
    h.notifier.backOffTerminalWakeSends("owner", ["b"]);
    expect(h.notifier.isWakeSendBackedOff("owner", "b")).toBe(true);
  });

  test("refuses an empty key list", () => {
    const h = createHarness();
    expect(() => h.notifier.backOffTerminalWakeSends("owner", [])).toThrow();
    expect(h.drain).not.toHaveBeenCalled();
  });
});

describe("TerminalAttentionNotifier notify_on_terminal policy", () => {
  function configWith(id: string, policy?: "notify_on_terminal"): ProjectsConfig {
    return {
      projects: new Map([
        [
          "/repo",
          {
            workspaces: [
              {
                path: "/repo/ws",
                id,
                ...(policy != null ? { taskAttentionPolicy: policy } : {}),
              },
            ],
          },
        ],
      ]),
    };
  }

  test("writes the policy onto a task workspace entry", async () => {
    const h = createHarness();
    h.config = configWith("task-1");
    await h.notifier.markBackgroundWorkNotifyOnTerminal("task-1", "owner");
    expect(h.config.projects.get("/repo")?.workspaces[0].taskAttentionPolicy).toBe(
      "notify_on_terminal"
    );
    expect(h.turnManager.markWorkspaceTurnBackgroundWorkNotifyOnTerminal).not.toHaveBeenCalled();
  });

  test("leaves config unchanged for an unknown task", async () => {
    const h = createHarness();
    h.config = configWith("task-1");
    await h.notifier.markBackgroundWorkNotifyOnTerminal("task-2", "owner");
    expect(h.config.projects.get("/repo")?.workspaces[0].taskAttentionPolicy).toBeUndefined();
  });

  test("routes a workspace-turn handle to the turn manager, and skips it without an owner", async () => {
    const h = createHarness();
    await h.notifier.markBackgroundWorkNotifyOnTerminal("wst_handle", "owner");
    h.notifier.scheduleNotifyOnTerminalPersist("wst_handle", undefined);
    await Promise.all(h.notifier.inFlightNotifyOnTerminalPersists());
    expect(h.events).toEqual(["turn-policy:wst_handle:owner"]);
    expect(h.editConfig).not.toHaveBeenCalled();
  });

  test("tracks a scheduled persist until it settles, also when it fails", async () => {
    const h = createHarness();
    const write = deferred();
    h.editConfig.mockImplementationOnce(() => write.promise);
    h.notifier.scheduleNotifyOnTerminalPersist("task-1", "owner");
    const inFlight = h.notifier.inFlightNotifyOnTerminalPersists();
    expect(inFlight).toHaveLength(1);

    write.reject(new Error("disk full"));
    await Promise.all(inFlight);
    expect(h.notifier.inFlightNotifyOnTerminalPersists()).toHaveLength(0);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
