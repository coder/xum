// Characterization tests for TaskService.waitForAgentReport, written before the method is split
// into steps. They pin the re-check after the first awaited read, the waiter's synchronous
// registration, "cleanup, then settle" on every exit, the report timeout's arming, and the
// completion prompt that an awaiting_report wait queues on the task's event lock without waiting.
// A scripted spy stands in for every report read, so each case controls what each read returns
// and what changes while it runs. taskService.agentReports.waits.test.ts covers the real reads.
import assert from "node:assert";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import * as subagentFailureArtifacts from "@/node/services/subagentFailureArtifacts";
import { upsertSubagentFailureArtifact } from "@/node/services/subagentFailureArtifacts";
import type { TaskService } from "@/node/services/taskService";
import type { PendingTaskWaiterReport, TaskWaiters } from "@/node/services/taskWaiters";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const ROOT = "root-ws";
/** The requester: a running agent task, so its foreground wait frees a parallel slot. */
const PARENT = "parent-task";
const CHILD = "child-task";
const REPORT: PendingTaskWaiterReport = { reportMarkdown: "Child report." };
// Test data. The tests compare these, never product prose.
const FAILURE = "failure from the artifact";
const LAUNCH_ERROR = "launch error from the row";
const READ_ERROR = "the read failed";
const REJECTION = "rejected by the test";
const TEST_MESSAGES = new Set([FAILURE, LAUNCH_ERROR, READ_ERROR, REJECTION]);
/** A delay no other timer uses, so the setTimeout spy can tell the report timer apart. */
const TIMEOUT_MS = 4_321_987;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

type TimerHandle = Parameters<typeof clearTimeout>[0];
type TaskStatus = NonNullable<WorkspaceConfigEntry["taskStatus"]>;
type WaitOptions = NonNullable<Parameters<TaskService["waitForAgentReport"]>[1]>;
/** What a scripted read can change while it runs. */
interface ReadContext {
  config: Config;
  waiters: TaskWaiters;
  flags: { streaming: boolean };
}
/** One scripted report read: it may change state while it runs, then returns a report or null. */
type Read = (h: ReadContext) => Promise<PendingTaskWaiterReport | null>;

/** Private members the tests drive or replace. The split keeps them as instance members. */
interface WaitInternals {
  waiters: TaskWaiters;
  workspaceEventLocks: { withLock<T>(key: string, fn: () => Promise<T>): Promise<T> };
  readPersistedReportForWait(
    taskId: string,
    requestingWorkspaceId: string | undefined
  ): Promise<PendingTaskWaiterReport | null>;
  resolveWaiters(taskId: string, report: PendingTaskWaiterReport): boolean;
  promptTaskForRequiredCompletionTool(
    taskId: string,
    options: { expectedAttemptId: string | null }
  ): Promise<void>;
}

interface ReportTimer {
  delay: number;
  fire: () => void;
  handle: unknown;
  cleared: boolean;
}

const none: Read = () => Promise.resolve(null);
const found: Read = () => Promise.resolve(REPORT);
/** A read that returns null after `change` ran, as if the change landed during the read. */
const after =
  (change: (h: ReadContext) => Promise<void> | void): Read =>
  async (h) => {
    await change(h);
    return null;
  };
const removeRow = (h: ReadContext) =>
  h.config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      project.workspaces = project.workspaces.filter((workspace) => workspace.id !== CHILD);
    }
    return cfg;
  });
const setStatus = (taskStatus: TaskStatus) => (h: ReadContext) =>
  h.config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      const row = project.workspaces.find((workspace) => workspace.id === CHILD);
      if (row != null) row.taskStatus = taskStatus;
    }
    return cfg;
  });
const endStream = (h: ReadContext) => {
  h.flags.streaming = false;
};
const removed = after(removeRow);
const reported = after(setStatus("reported"));

/** One macrotask turn: the microtasks the wait queued have run (enough when its reads do no I/O). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * How a wait ended: "report" (REPORT itself) or another report's JSON, else a test-data message
 * or the class of what was thrown.
 */
async function outcome(wait: Promise<unknown>): Promise<string> {
  try {
    const report = await wait;
    return report === REPORT ? "report" : JSON.stringify(report);
  } catch (error: unknown) {
    if (!(error instanceof Error)) return typeof error;
    return TEST_MESSAGES.has(error.message) ? error.message : error.constructor.name;
  }
}

/** The wait's state once everything is released; tests override the fields they expect set. */
const RELEASED = {
  pendingWaiter: false,
  startWaiter: false,
  foregroundAwaiting: false,
  backgroundable: 0,
  armedTimers: [] as number[],
  abortListeners: 0,
  prompts: 0,
};

let rootDir: string;
// Background work a test can leave behind, settled in afterEach even when a test fails early.
let configs: Config[];
let harnesses: Array<{ waiters: TaskWaiters; drainEventLock: () => Promise<void> }>;
/** Every wait a test started, with a handler attached at once so no rejection goes unhandled. */
let waits: Array<Promise<unknown>>;
let timers: ReportTimer[];
let releases: Array<() => void>;
let abortListeners: Set<unknown>;

/** A running parent task with one child task in `status`, behind scripted reads and spies. */
async function setup(
  status: TaskStatus,
  options: { reads?: Read[]; failure?: boolean; launchError?: string } = {}
) {
  const config = await createTestConfig(rootDir);
  configs.push(config);
  const projectPath = path.join(rootDir, "repo");
  await saveWorkspaces(
    config,
    projectPath,
    [
      projectWorkspace(projectPath, "root", ROOT),
      projectWorkspace(projectPath, "parent", PARENT, {
        name: "agent_exec_parent",
        parentWorkspaceId: ROOT,
        agentType: "exec",
        taskStatus: "running",
      }),
      projectWorkspace(projectPath, "child", CHILD, {
        name: "agent_explore_child",
        parentWorkspaceId: PARENT,
        agentType: "explore",
        taskStatus: status,
        taskLaunchError: options.launchError,
      }),
    ],
    testTaskSettings(1, 3)
  );
  if (options.failure === true) {
    await upsertSubagentFailureArtifact({
      locks: nodeSessionLocks,
      workspaceId: PARENT,
      workspaceSessionDir: path.join(config.sessionsDir, PARENT),
      childTaskId: CHILD,
      parentWorkspaceId: PARENT,
      ancestorWorkspaceIds: [PARENT, ROOT],
      errorType: "model_refusal",
      errorMessage: FAILURE,
    });
  }

  const flags = { streaming: true, queuedMessages: false };
  const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => flags.streaming) });
  const { workspaceService } = createWorkspaceServiceMocks({
    hasQueuedMessages: mock(() => flags.queuedMessages),
  });
  const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
  const internals = taskService as unknown as WaitInternals;
  const waiters = internals.waiters;
  const script = [...(options.reads ?? [])];
  const reads = spyOn(internals, "readPersistedReportForWait").mockImplementation(() =>
    (script.shift() ?? none)(h)
  );
  const prompts = spyOn(internals, "promptTaskForRequiredCompletionTool").mockResolvedValue(
    undefined
  );
  // Records whether the start waiter was registered at each call. It starts no queue drain, so
  // no launch runs in the background.
  const schedules: boolean[] = [];
  spyOn(taskService, "scheduleMaybeStartQueuedTasks").mockImplementation(() => {
    schedules.push(waiters.pendingStartWaitersByTaskId.has(CHILD));
  });
  const ranLastStep = Promise.withResolvers<void>();
  const lastStepOf = taskService.backgroundForegroundWaitIfQueued.bind(taskService);
  const lastStep = spyOn(taskService, "backgroundForegroundWaitIfQueued").mockImplementation(
    (...args) => {
      lastStepOf(...args);
      ranLastStep.resolve();
    }
  );
  const h = {
    config,
    taskService,
    internals,
    waiters,
    flags,
    reads,
    prompts,
    schedules,
    registrations: spyOn(taskService, "startForegroundAwait"),
    lastStep,
    /** Resolves once the wait ran its last step: it has registered and armed everything. */
    armed: ranLastStep.promise,
    /** Waits for CHILD on behalf of PARENT with the test timeout, unless options override them. */
    start(waitOptions: WaitOptions = {}) {
      const wait = taskService.waitForAgentReport(CHILD, {
        timeoutMs: TIMEOUT_MS,
        requestingWorkspaceId: PARENT,
        ...waitOptions,
      });
      waits.push(wait.catch(() => undefined));
      return wait;
    },
    snapshot: () => ({
      pendingWaiter: waiters.hasPendingWaiters(CHILD),
      startWaiter: waiters.pendingStartWaitersByTaskId.has(CHILD),
      foregroundAwaiting: taskService.isForegroundAwaiting(PARENT),
      backgroundable: waiters.backgroundableForegroundWaitersByWorkspaceId.get(PARENT)?.size ?? 0,
      armedTimers: timers.filter((timer) => !timer.cleared).map((timer) => timer.delay),
      abortListeners: abortListeners.size,
      prompts: prompts.mock.calls.length,
    }),
    drainEventLock: () => internals.workspaceEventLocks.withLock(CHILD, () => Promise.resolve()),
  };
  harnesses.push(h);
  return h;
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** An AbortController whose signal counts the listeners attached and not yet removed. */
function abortController(): AbortController {
  const controller = new AbortController();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  type Listener = EventListenerOrEventListenerObject;
  signal.addEventListener = ((type: string, listener: Listener, listenerOptions?: boolean) => {
    abortListeners.add(listener);
    add(type, listener, listenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: Listener, listenerOptions?: boolean) => {
    abortListeners.delete(listener);
    remove(type, listener, listenerOptions);
  }) as typeof signal.removeEventListener;
  return controller;
}

/** Runs the armed report timer's callback now, as if its delay had passed. */
function fireTimer(): void {
  const timer = timers.find((candidate) => !candidate.cleared);
  assert(timer != null, "no armed report timer");
  timer.fire();
}

describe("TaskService.waitForAgentReport before the split", () => {
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    configs = [];
    harnesses = [];
    waits = [];
    timers = [];
    releases = [];
    abortListeners = new Set();
    spyOn(globalThis, "setTimeout").mockImplementation(((
      fire: () => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle: unknown = realSetTimeout(fire, delay, ...args);
      if (delay === TIMEOUT_MS || delay === DEFAULT_TIMEOUT_MS) {
        timers.push({ delay, fire, handle, cleared: false });
      }
      return handle;
    }) as unknown as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: TimerHandle) => {
      for (const timer of timers) if (timer.handle === handle) timer.cleared = true;
      realClearTimeout(handle);
    }) as unknown as typeof clearTimeout);
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    // Lets a wait whose read already resolved register before its waiters are rejected.
    await flush();
    for (const h of harnesses.splice(0)) {
      // Settles a wait a failed test left registered, then the prompts queued on the lock.
      h.waiters.rejectWaiters(CHILD, new Error("teardown"));
      await h.drainEventLock();
    }
    for (const timer of timers.splice(0)) realClearTimeout(timer.handle as TimerHandle);
    // Each stored waiter settled above, within microtasks. A wait that nothing can settle (its
    // waiter never reached the store) holds no timer now, so the turn below bounds the wait.
    await Promise.race([Promise.all(waits.splice(0)), flush()]);
    mock.restore();
    // A config load can queue a migration write (Config.migrationPersist): one more edit on the
    // same serialized queue settles it before the root goes.
    for (const config of configs.splice(0)) await config.editConfig((cfg) => cfg);
    await removeTaskServiceTestRoot(rootDir);
  });

  // The interrupted task is still streaming, so the wait goes past the first read and re-reads
  // the row. Each case changes something during a read. Each settles before registration.
  test.each<[string, Read[], boolean, string, number]>([
    ["the row is removed, a report persisted", [removed, found], false, "report", 2],
    ["the row is removed, a failure persisted", [removed, none], true, FAILURE, 2],
    ["the row is removed, nothing persisted", [removed, none], false, "Error", 2],
    ["the row reports, a report persisted", [reported, found], false, "report", 2],
    ["the row reports, a failure persisted", [reported, none], true, FAILURE, 2],
    ["the row reports, nothing persisted", [reported, none], false, "Error", 2],
    ["a report persisted, the row still interrupted", [none, found], false, "report", 2],
    ["the stream ends during the second read", [none, after(endStream)], false, LAUNCH_ERROR, 2],
    ["the stream ends during the first read", [after(endStream)], false, LAUNCH_ERROR, 1],
  ])("an interrupted wait: %s", async (_name, reads, failure, expected, readCount) => {
    const h = await setup("interrupted", { reads, failure, launchError: LAUNCH_ERROR });

    const result = await outcome(h.start());

    expect({
      result,
      reads: h.reads.mock.calls.length,
      registered: h.registrations.mock.calls.length,
      ...h.snapshot(),
    }).toEqual({ result: expected, reads: readCount, registered: 0, ...RELEASED });
  });

  test("a rejected execution-start callback leaves the wait pending until the report", async () => {
    const h = await setup("running");
    const onExecutionStarted = mock(() => Promise.reject(new Error("callback failed")));

    const wait = h.start({ onExecutionStarted });
    await h.armed;
    expect({ calls: onExecutionStarted.mock.calls.length, status: Bun.peek.status(wait) }).toEqual({
      calls: 1,
      status: "pending",
    });

    h.internals.resolveWaiters(CHILD, REPORT);
    expect(await outcome(wait)).toBe("report");
  });

  test("an awaiting_report wait queues the completion prompt on the event lock without waiting for it", async () => {
    const h = await setup("awaiting_report");
    h.prompts.mockRejectedValueOnce(new Error("prompt failed"));
    // The test holds the task's event lock, so the prompt cannot run yet.
    const gate = Promise.withResolvers<void>();
    releases.push(gate.resolve);
    const held = h.internals.workspaceEventLocks.withLock(CHILD, () => gate.promise);
    const controller = abortController();

    const wait = h.start({ abortSignal: controller.signal });
    await flush();
    // The wait armed its timer and abort listener and ran its last step behind the held lock.
    expect({ ...h.snapshot(), lastStep: h.lastStep.mock.calls.length }).toEqual({
      ...RELEASED,
      pendingWaiter: true,
      foregroundAwaiting: true,
      backgroundable: 1,
      armedTimers: [TIMEOUT_MS],
      abortListeners: 1,
      lastStep: 1,
    });

    gate.resolve();
    await held;
    await h.drainEventLock();
    // The prompt ran under the lock and failed. The failure does not settle the wait.
    expect({ prompts: h.prompts.mock.calls, status: Bun.peek.status(wait) }).toEqual({
      prompts: [[CHILD, { expectedAttemptId: null }]],
      status: "pending",
    });

    h.internals.resolveWaiters(CHILD, REPORT);
    expect(await outcome(wait)).toBe("report");
    expect(h.snapshot()).toEqual({ ...RELEASED, prompts: 1 });
  });

  // The abort check runs after registration, arming and the prompt, and before the last step.
  test.each<[TaskStatus, boolean[], number]>([
    ["running", [], 0],
    ["queued", [true], 0],
    ["awaiting_report", [], 1],
  ])(
    "an already-aborted %s wait rejects and releases everything",
    async (status, schedules, prompts) => {
      const h = await setup(status);
      const controller = abortController();
      controller.abort();

      const result = await outcome(h.start({ abortSignal: controller.signal }));
      await h.drainEventLock();

      expect({
        result,
        registered: h.registrations.mock.calls.length,
        schedules: h.schedules,
        lastStep: h.lastStep.mock.calls.length,
        ...h.snapshot(),
      }).toEqual({ result: "Error", registered: 1, schedules, lastStep: 0, ...RELEASED, prompts });
    }
  );

  test.each<[string, unknown]>([
    ["an Error", new Error(READ_ERROR)],
    ["a string", READ_ERROR],
  ])(
    "a read after registration that throws %s rejects with an Error and releases the waiter",
    async (_name, thrown) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error on purpose
      const h = await setup("running", { reads: [() => Promise.reject(thrown)] });

      const result = await outcome(h.start());

      expect({ result, registered: h.registrations.mock.calls.length, ...h.snapshot() }).toEqual({
        result: READ_ERROR,
        registered: 1,
        ...RELEASED,
      });
    }
  );

  // Registration has no await before it for a task that is not interrupted, so a scheduler call
  // in the caller's own tick already sees the foreground wait (see maybeStartQueuedTasks).
  test.each<{
    name: string;
    status: TaskStatus;
    options: WaitOptions;
    /** A tool-end message already queued backgrounds only a wait registered as backgroundable. */
    queuedMessage: boolean;
    foreground: boolean;
    backgroundable: number;
    /** What the queue drain counts against maxParallelAgentTasks. */
    activeTasks: number;
    queueBackgrounded: boolean;
    requester: string | undefined;
  }>([
    {
      name: "a running wait, backgroundable by default",
      status: "running",
      options: {},
      queuedMessage: false,
      foreground: true,
      backgroundable: 1,
      activeTasks: 1,
      queueBackgrounded: false,
      requester: PARENT,
    },
    {
      name: "a queued wait that opted out of backgrounding",
      status: "queued",
      options: { backgroundOnMessageQueued: false },
      queuedMessage: true,
      foreground: true,
      backgroundable: 0,
      activeTasks: 1,
      queueBackgrounded: false,
      requester: PARENT,
    },
    {
      name: "a requester id with spaces around it",
      status: "running",
      options: { requestingWorkspaceId: ` ${PARENT} `, backgroundOnMessageQueued: true },
      queuedMessage: false,
      foreground: true,
      backgroundable: 1,
      activeTasks: 1,
      queueBackgrounded: false,
      requester: PARENT,
    },
    {
      name: "no requester",
      status: "running",
      options: { requestingWorkspaceId: undefined, backgroundOnMessageQueued: true },
      queuedMessage: true,
      foreground: false,
      backgroundable: 0,
      activeTasks: 2,
      queueBackgrounded: true,
      requester: undefined,
    },
  ])("$name: the wait registers in the caller's tick", async (row) => {
    const h = await setup(row.status);
    h.flags.queuedMessages = row.queuedMessage;
    const marks = h.waiters as unknown as { userBackgroundedTaskIds: Set<string> };
    marks.userBackgroundedTaskIds.add(CHILD);

    const wait = h.start(row.options);
    expect({
      pendingWaiter: h.waiters.hasPendingWaiters(CHILD),
      foreground: h.taskService.isForegroundAwaiting(PARENT),
      backgroundable: h.snapshot().backgroundable,
      activeTasks: h.taskService.countActiveAgentTasks(h.config.loadConfigOrDefault()),
      queueBackgrounded: h.waiters.isTaskQueueBackgrounded(CHILD),
      reads: h.reads.mock.calls,
    }).toEqual({
      pendingWaiter: true,
      foreground: row.foreground,
      backgroundable: row.backgroundable,
      activeTasks: row.activeTasks,
      queueBackgrounded: row.queueBackgrounded,
      reads: [[CHILD, row.requester]],
    });

    await h.armed;
    h.internals.resolveWaiters(CHILD, REPORT);
    expect(await outcome(wait)).toBe("report");
    expect(h.snapshot()).toEqual(RELEASED);
  });

  test("a wait that opted out of backgrounding leaves its requester's other waits alone", async () => {
    const h = await setup("running");
    const backgroundable = h.start();
    await h.armed;
    // A tool-end message is queued now. The test models no enqueue edge, so only the opted-out
    // wait's own last check could background the first wait.
    h.flags.queuedMessages = true;
    const optedOut = h.start({ backgroundOnMessageQueued: false });
    await flush();

    h.internals.resolveWaiters(CHILD, REPORT);
    expect([await outcome(backgroundable), await outcome(optedOut)]).toEqual(["report", "report"]);
  });

  const publish = (h: Harness) => h.internals.resolveWaiters(CHILD, REPORT);
  const reject = (h: Harness) => h.waiters.rejectWaiters(CHILD, new Error(REJECTION));
  // Each exit cleans up, then settles. Settling runs no code of a plain report or error, so the
  // earliest point a test can look is the caller's first reaction.
  test.each<{
    name: string;
    status: TaskStatus;
    reads?: Read[];
    failure?: boolean;
    queuedMessage?: boolean;
    settle: (h: Harness, controller: AbortController) => void;
    expected: string;
  }>([
    {
      name: "the read finds the report",
      status: "running",
      reads: [found],
      settle: () => undefined,
      expected: "report",
    },
    { name: "resolveWaiters publishes it", status: "running", settle: publish, expected: "report" },
    {
      name: "resolveWaiters publishes it while queued",
      status: "queued",
      settle: publish,
      expected: "report",
    },
    { name: "rejectWaiters", status: "running", settle: reject, expected: REJECTION },
    { name: "rejectWaiters while queued", status: "queued", settle: reject, expected: REJECTION },
    {
      name: "the signal aborts",
      status: "running",
      settle: (_h, c) => c.abort(),
      expected: "Error",
    },
    {
      name: "the timeout fires",
      status: "running",
      settle: fireTimer,
      expected: "AgentReportWaitTimeoutError",
    },
    {
      name: "the timeout fires, a failure persisted",
      status: "running",
      failure: true,
      settle: fireTimer,
      expected: FAILURE,
    },
    {
      // The timer's failure read is best-effort: when it throws, the wait still times out.
      name: "the timeout fires, the failure read throws",
      status: "running",
      settle: () => {
        spyOn(subagentFailureArtifacts, "readSubagentFailureArtifact").mockRejectedValueOnce(
          new Error(READ_ERROR)
        );
        fireTimer();
      },
      expected: "AgentReportWaitTimeoutError",
    },
    {
      name: "the started task's timeout fires",
      status: "queued",
      settle: (h) => {
        h.waiters.startPendingStartWaiters(CHILD);
        fireTimer();
      },
      expected: "AgentReportWaitTimeoutError",
    },
    {
      name: "a tool-end message was already queued",
      status: "running",
      queuedMessage: true,
      settle: () => undefined,
      expected: "ForegroundWaitBackgroundedError",
    },
  ])("a $status wait settled because $name has released everything", async (row) => {
    const h = await setup(row.status, { reads: row.reads, failure: row.failure });
    h.flags.queuedMessages = row.queuedMessage === true;
    const controller = abortController();

    const wait = h.start({ abortSignal: controller.signal });
    const atSettle = wait.then(h.snapshot, h.snapshot);
    await flush();
    row.settle(h, controller);
    const result = await outcome(wait);
    await flush();

    expect({ result, atSettle: await atSettle, after: h.snapshot() }).toEqual({
      result: row.expected,
      atSettle: RELEASED,
      after: RELEASED,
    });
  });

  // The timer starts once the task runs. A queued or starting task gets a start waiter instead,
  // unless it started during the read after registration or its launch failure is unpersisted.
  test.each<{
    name: string;
    status: TaskStatus;
    read: Read;
    options?: WaitOptions;
    armedTimers: number[];
    startWaiter: boolean;
    /** Whether the start waiter was registered at each queue-drain call. */
    schedules: boolean[];
  }>([
    {
      name: "running",
      status: "running",
      read: none,
      armedTimers: [TIMEOUT_MS],
      startWaiter: false,
      schedules: [],
    },
    {
      name: "running, default timeout",
      status: "running",
      read: none,
      options: { timeoutMs: undefined },
      armedTimers: [DEFAULT_TIMEOUT_MS],
      startWaiter: false,
      schedules: [],
    },
    {
      name: "queued",
      status: "queued",
      read: none,
      armedTimers: [],
      startWaiter: true,
      schedules: [true],
    },
    {
      name: "starting",
      status: "starting",
      read: none,
      armedTimers: [],
      startWaiter: true,
      schedules: [true],
    },
    {
      name: "queued, no requester",
      status: "queued",
      read: none,
      options: { requestingWorkspaceId: undefined },
      armedTimers: [],
      startWaiter: true,
      schedules: [],
    },
    {
      name: "queued, starting during the read",
      status: "queued",
      read: after(setStatus("starting")),
      armedTimers: [],
      startWaiter: true,
      schedules: [true],
    },
    {
      name: "queued, running after the read",
      status: "queued",
      read: after(setStatus("running")),
      armedTimers: [TIMEOUT_MS],
      startWaiter: false,
      schedules: [false],
    },
    {
      name: "queued, launch failure unpersisted",
      status: "queued",
      read: after((h) => h.waiters.armWaitersOfUnendedTask(CHILD)),
      armedTimers: [TIMEOUT_MS],
      startWaiter: false,
      schedules: [false],
    },
  ])("$name: the wait arms its timeout once the task runs", async (row) => {
    const h = await setup(row.status, { reads: [row.read] });
    const onExecutionStarted = mock(() => undefined);

    const wait = h.start({ onExecutionStarted, ...row.options });
    await h.armed;
    const state = h.snapshot();
    expect({
      pendingWaiter: state.pendingWaiter,
      armedTimers: state.armedTimers,
      startWaiter: state.startWaiter,
      schedules: h.schedules,
      started: onExecutionStarted.mock.calls.length,
    }).toEqual({
      pendingWaiter: true,
      armedTimers: row.armedTimers,
      startWaiter: row.startWaiter,
      schedules: row.schedules,
      started: row.armedTimers.length,
    });

    // The task runs: a start waiter arms the timer and reports the start, each once.
    h.waiters.startPendingStartWaiters(CHILD);
    expect({
      armedTimers: h.snapshot().armedTimers,
      started: onExecutionStarted.mock.calls.length,
    }).toEqual({
      armedTimers: [row.armedTimers[0] ?? TIMEOUT_MS],
      started: 1,
    });
    h.internals.resolveWaiters(CHILD, REPORT);
    expect(await outcome(wait)).toBe("report");
  });

  test("a wait without a requester for a removed task reads no failure and rejects", async () => {
    const h = await setup("running");
    await removeRow(h);

    const result = await outcome(h.start({ requestingWorkspaceId: undefined }));

    expect({ result, reads: h.reads.mock.calls, ...h.snapshot() }).toEqual({
      result: "Error",
      reads: [[CHILD, undefined]],
      ...RELEASED,
    });
  });

  // The cached report comes first (report monotonicity), then the timeout check, before any read.
  test.each<[number, boolean, string]>([
    [0, false, "AssertionError"],
    [-1, false, "AssertionError"],
    [Number.POSITIVE_INFINITY, false, "AssertionError"],
    [0, true, JSON.stringify(REPORT)],
  ])("timeoutMs %p, a report cached: %p", async (timeoutMs, cached, expected) => {
    const h = await setup("running");
    if (cached) h.internals.resolveWaiters(CHILD, REPORT);

    const result = await outcome(h.start({ timeoutMs }));

    expect({ result, reads: h.reads.mock.calls.length, ...h.snapshot() }).toEqual({
      result: expected,
      reads: 0,
      ...RELEASED,
    });
  });
});
