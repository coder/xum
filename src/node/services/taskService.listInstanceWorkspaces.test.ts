import { AssertionError } from "node:assert";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AgentTaskIndex } from "@/node/services/agentTaskIndex";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveTestConfig,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  registerLiveWorkspaceTurnHandle,
  removeTaskServiceTestRoot,
  startLiveWorkspaceTurn,
} from "@/node/services/taskService.shared.testHarness";

// Characterization tests written before listInstanceWorkspaces is split into steps. They pin which
// visibility term hides each root, the order in which the terms probe state, and the result shape.
// taskService.familyMessaging.test.ts covers consent, runtimes, queries, paging and sorting.

const SSH_RUNTIME = { type: "ssh", host: "remote.example", srcBaseDir: "~/src" } as const;
const ARCHIVED_AT = "2026-01-01T00:00:00.000Z";
const UNARCHIVED_AT = "2026-01-02T00:00:00.000Z";

/** Private probes that the visibility terms call. The trace wraps them by name. */
interface VisibilityProbes {
  isUnrelatedMessagingEndpoint(workspace: WorkspaceConfigEntry): boolean;
  isWorkflowOwnedTaskUsingIndex(index: AgentTaskIndex, id: string): boolean;
  isBestOfChainUsingIndex(index: AgentTaskIndex, id: string): boolean;
}

/** An opted-in local root: every visibility term lists it until a test changes one input. */
function root(
  projectPath: string,
  id: string,
  options: Partial<WorkspaceConfigEntry> = {}
): WorkspaceConfigEntry {
  return {
    ...projectWorkspace(projectPath, id, id, {
      unrelatedWorkspaceConsent: "instance-discovery-consent",
      runtimeConfig: { type: "local" },
    }),
    ...options,
  };
}

/**
 * A finished task child of "caller". Under an earlier project key than a root with the same id, it
 * is the row the task index resolves that id to (buildAgentTaskIndex keeps the first row per id).
 */
function child(projectPath: string, id: string, options: Partial<WorkspaceConfigEntry> = {}) {
  return root(projectPath, id, { parentWorkspaceId: "caller", taskStatus: "reported", ...options });
}

/** Wraps fn so that each call first appends label(...args) to the trace. */
function traced<A extends unknown[], R>(
  trace: string[],
  fn: (...args: A) => R,
  label: (...args: A) => string
): (...args: A) => R {
  return (...args) => {
    trace.push(label(...args));
    return fn(...args);
  };
}

describe("TaskService listInstanceWorkspaces before the split", () => {
  let rootDir: string;
  // Background inits the host is asked to register. Settled after each test so none outlives it.
  let backgroundInits: Array<Promise<void>>;
  // Releases of the stop latches that tests hold. Released after each test.
  let stopLatchReleases: Array<() => void>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    backgroundInits = [];
    stopLatchReleases = [];
  });
  afterEach(async () => {
    for (const release of stopLatchReleases.splice(0)) release();
    await Promise.all(backgroundInits.splice(0));
    await removeTaskServiceTestRoot(rootDir);
  });

  /** Saves two project keys in order and builds a TaskService whose activity probes trace calls. */
  async function setup(
    build: (first: string, second: string) => [WorkspaceConfigEntry[], WorkspaceConfigEntry[]],
    streamingIds: readonly string[] = []
  ) {
    const config = await createTestConfig(rootDir);
    const first = path.join(rootDir, "first");
    const second = path.join(rootDir, "second");
    const [firstRows, secondRows] = build(first, second);
    await saveTestConfig(config, [
      [first, { trusted: true, workspaces: firstRows }],
      [second, { trusted: true, workspaces: secondRows }],
    ]);
    const trace: string[] = [];
    const isBusyForMessage = mock((id: string) => {
      trace.push(`busy:${id}`);
      return false;
    });
    const isStreaming = mock((id: string) => {
      trace.push(`streaming:${id}`);
      return streamingIds.includes(id);
    });
    const host = createWorkspaceServiceMocks({ isBusyForMessage });
    spyOn(host.workspaceService, "registerExternalBackgroundInit").mockImplementation(
      (_workspaceId: string, _controller: AbortController, settlement: Promise<void>) => {
        backgroundInits.push(settlement);
      }
    );
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService, workspaceTurnManager } = createTaskServiceHarness(config, {
      workspaceService: host.workspaceService,
      aiService,
    });
    /** Clears the trace, then also traces the config read, the index build and each probe. */
    function traceProbes(): void {
      trace.splice(0);
      const probes = taskService as unknown as VisibilityProbes;
      const read = config.loadConfigOrDefault.bind(config);
      config.loadConfigOrDefault = traced(trace, read, () => "config");
      const index = taskService.buildAgentTaskIndex.bind(taskService);
      taskService.buildAgentTaskIndex = traced(trace, index, () => "index");
      const endpoint = probes.isUnrelatedMessagingEndpoint.bind(taskService);
      probes.isUnrelatedMessagingEndpoint = traced(
        trace,
        endpoint,
        (ws) => `endpoint:${String(ws.id)}`
      );
      const stop = taskService.isWorkspaceStopInProgress.bind(taskService);
      taskService.isWorkspaceStopInProgress = traced(trace, stop, (id) => `stop:${id}`);
      const manager = workspaceTurnManager;
      const turn = manager.getLiveWorkspaceTurnRegistration.bind(manager);
      manager.getLiveWorkspaceTurnRegistration = traced(trace, turn, (id) => `turn:${id}`);
      const workflow = probes.isWorkflowOwnedTaskUsingIndex.bind(taskService);
      probes.isWorkflowOwnedTaskUsingIndex = traced(trace, workflow, (_, id) => `workflow:${id}`);
      const bestOf = probes.isBestOfChainUsingIndex.bind(taskService);
      probes.isBestOfChainUsingIndex = traced(trace, bestOf, (_, id) => `bestOf:${id}`);
    }
    return { config, first, second, trace, taskService, traceProbes };
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;

  function listedIds(f: Fixture): string[] {
    return f.taskService.listInstanceWorkspaces("caller", {}).rows.map((row) => row.workspaceId);
  }

  /** Holds a stop-in-progress latch on `id` until the test ends. */
  function latchStop(f: Fixture, id: string): void {
    stopLatchReleases.push(f.taskService.latchWorkspaceStopsInProgress([id]));
  }

  /** Gives `id` a live workspace turn of "owner" through the production createWorkspaceTurn. */
  async function startTurn(f: Fixture, id: string): Promise<void> {
    await startLiveWorkspaceTurn(f.taskService, f.config, {
      ownerWorkspaceId: "owner",
      workspaceId: id,
      handleId: `wst_${id}`,
      ownerCreatedWorkspace: true,
    });
  }

  // "owner" never opted in, so the consent term hides it: it only owns delegated turns.
  const owner = (first: string) => root(first, "owner", { unrelatedWorkspaceConsent: undefined });

  // Each case changes one input of "target", so exactly one of the 11 visibility terms decides
  // whether it is listed. The cases marked `listed` are near misses that the term lets through.
  test.each<{
    term: string;
    listed?: true;
    target?: Partial<WorkspaceConfigEntry>;
    shadow?: Partial<WorkspaceConfigEntry>;
    hide?: (f: Fixture) => unknown;
  }>([
    { term: "none (control)", listed: true },
    { term: "1 (missing id)", target: { id: undefined } },
    { term: "1 (null id)", target: { id: null as unknown as undefined } },
    { term: "2 (blank id)", target: { id: "  " } },
    {
      term: "3 (parentWorkspaceId)",
      target: { parentWorkspaceId: "caller", taskStatus: "reported" },
    },
    { term: "3 (empty parentWorkspaceId)", listed: true, target: { parentWorkspaceId: "" } },
    { term: "4 (padded consent)", target: { unrelatedWorkspaceConsent: " padded " } },
    { term: "5 (remote runtime)", target: { runtimeConfig: SSH_RUNTIME } },
    { term: "5 (side chat)", target: { sideChatParentWorkspaceId: "caller" } },
    { term: "6 (archived)", target: { archivedAt: ARCHIVED_AT } },
    {
      term: "6 (unarchived)",
      listed: true,
      target: { archivedAt: ARCHIVED_AT, unarchivedAt: UNARCHIVED_AT },
    },
    {
      term: "7 (interrupted)",
      hide: (f) => f.taskService.markParentWorkspaceInterrupted("target"),
    },
    { term: "8 (stop in progress)", hide: (f) => latchStop(f, "target") },
    { term: "9 (live workspace turn)", hide: (f) => startTurn(f, "target") },
    { term: "10 (workflow-owned id)", shadow: { workflowTask: { runId: "wfr_x", stepId: "s" } } },
    { term: "11 (best-of id)", shadow: { bestOf: { groupId: "group", index: 0, total: 2 } } },
  ])(
    "term $term decides alone whether a root is listed",
    async ({ listed, target, shadow, hide }) => {
      const f = await setup((first, second) => [
        [root(first, "caller"), owner(first), ...(shadow ? [child(first, "target", shadow)] : [])],
        [root(second, "target", target)],
      ]);
      await hide?.(f);
      expect(listedIds(f)).toEqual(listed ? ["caller", "target"] : ["caller"]);
    }
  );

  test("probes state term by term and stops at the first term that hides a root", async () => {
    const f = await setup((first, second) => [
      [
        root(first, "caller"),
        owner(first),
        child(first, "workflow-id", { workflowTask: { runId: "wfr_trace", stepId: "step" } }),
        child(first, "best-of-id", { bestOf: { groupId: "group", index: 0, total: 2 } }),
      ],
      [
        root(second, "no-id", { id: undefined }),
        root(second, "  "),
        root(second, "remote", { runtimeConfig: SSH_RUNTIME }),
        root(second, "archived", { archivedAt: ARCHIVED_AT }),
        ...["interrupted", "stopping", "delegated", "workflow-id", "best-of-id", "listed"].map(
          (id) => root(second, id)
        ),
      ],
    ]);
    f.taskService.markParentWorkspaceInterrupted("interrupted");
    latchStop(f, "stopping");
    await startTurn(f, "delegated");
    f.traceProbes();
    const result = f.taskService.listInstanceWorkspaces("caller", {});
    expect(result.rows.map((row) => row.workspaceId)).toEqual(["caller", "listed"]);
    expect(result.totalMatching).toBe(2);
    // A root runs the probes of the terms up to the one that hides it, once each, in term order.
    const probes = (id: string, count: number) =>
      ["endpoint", "stop", "turn", "workflow", "bestOf"].slice(0, count).map((p) => `${p}:${id}`);
    expect(f.trace).toEqual([
      // One config read and one index build, after the caller's own endpoint check.
      "config",
      "endpoint:caller",
      "index",
      "workflow:caller",
      "bestOf:caller",
      ...probes("caller", 5),
      // "owner", the task children, "no-id" and "  " are hidden before the first probe.
      ...probes("remote", 1),
      ...probes("archived", 1),
      ...probes("interrupted", 1),
      ...probes("stopping", 2),
      ...probes("delegated", 3),
      ...probes("workflow-id", 4),
      ...probes("best-of-id", 5),
      ...probes("listed", 5),
      // Activity probes run after the sort, and only for the page.
      "busy:caller",
      "streaming:caller",
      "busy:listed",
      "streaming:listed",
    ]);
  });

  test("probes every visibility term of a root before the query test hides it", async () => {
    const f = await setup((first, second) => [[root(first, "caller")], [root(second, "other")]]);
    f.traceProbes();
    const result = f.taskService.listInstanceWorkspaces("caller", { query: "caller" });
    expect(result.rows.map((row) => row.workspaceId)).toEqual(["caller"]);
    const probes = (id: string) =>
      ["endpoint", "stop", "turn", "workflow", "bestOf"].map((p) => `${p}:${id}`);
    expect(f.trace).toEqual([
      "config",
      "endpoint:caller",
      "index",
      "workflow:caller",
      "bestOf:caller",
      ...probes("caller"),
      // "other" fails the query only after all 11 terms ran for it.
      ...probes("other"),
      "busy:caller",
      "streaming:caller",
    ]);
  });

  // Corrupted rows make two terms throw: a non-string id fails the blank-id term, and a parent
  // cycle under a root's id fails the workflow and best-of ancestry walks. Today the whole listing
  // throws when such a term runs. These tests pin that the terms run only for rows that the earlier
  // terms keep. A self-healing fix of the throw would change them on purpose.

  /** "loop" is a root whose id the task index resolves to a task child in a parent cycle. */
  function setupCycle(target?: Partial<WorkspaceConfigEntry>) {
    return setup((first, second) => [
      [
        root(first, "caller"),
        child(first, "loop", { parentWorkspaceId: "loop-parent" }),
        child(first, "loop-parent", { parentWorkspaceId: "loop" }),
      ],
      [root(second, "loop", target)],
    ]);
  }

  test("throws in the workflow-owner walk for a cycle root that no earlier term hides", async () => {
    const f = await setupCycle();
    expect(() => listedIds(f)).toThrow(AssertionError);
  });

  test.each<{
    hiddenBy: string;
    target?: Partial<WorkspaceConfigEntry>;
    hide?: (f: Fixture) => unknown;
  }>([
    { hiddenBy: "consent", target: { unrelatedWorkspaceConsent: undefined } },
    { hiddenBy: "archive", target: { archivedAt: ARCHIVED_AT } },
    { hiddenBy: "interrupt", hide: (f) => f.taskService.markParentWorkspaceInterrupted("loop") },
    { hiddenBy: "stop latch", hide: (f) => latchStop(f, "loop") },
    // The id resolves to a task child, which createWorkspaceTurn would continue: seed the turn.
    {
      hiddenBy: "live turn",
      hide: (f) => registerLiveWorkspaceTurnHandle(f.taskService, "loop", "wst_loop", "owner"),
    },
  ])("never walks the parent cycle of a root hidden by $hiddenBy", async ({ target, hide }) => {
    const f = await setupCycle(target);
    await hide?.(f);
    expect(listedIds(f)).toEqual(["caller"]);
  });

  test("runs the blank-id term before the parentWorkspaceId term", async () => {
    const f = await setup((first) => [
      [root(first, "caller"), child(first, "numeric", { id: 42 as unknown as string })],
      [],
    ]);
    // `id.trim` throws for a non-string id, even on a task child that the next term would hide.
    expect(() => listedIds(f)).toThrow(TypeError);
  });

  test("returns full rows newest first and sets nextOffset only while rows remain", async () => {
    const f = await setup(
      (first, second) => [
        [
          // The caller's root never opted in. The caller still sees it, as its ancestor.
          root(first, "root", {
            unrelatedWorkspaceConsent: undefined,
            title: "Root title",
            createdAt: "2026-03-01T00:00:00.000Z",
          }),
          child(first, "caller", { parentWorkspaceId: "root" }),
        ],
        [
          root(second, "older", { createdAt: "2026-01-01T00:00:00.000Z" }),
          root(second, "peer", { title: "Peer title", createdAt: "2026-02-01T00:00:00.000Z" }),
        ],
      ],
      ["peer"]
    );
    const row = (
      id: string,
      projectPath: string,
      title: string | undefined,
      createdAt: string
    ) => ({
      workspaceId: id,
      title,
      name: id,
      projectPath,
      createdAt,
    });
    expect(f.taskService.listInstanceWorkspaces("caller", { limit: 2 })).toStrictEqual({
      rows: [
        {
          ...row("root", f.first, "Root title", "2026-03-01T00:00:00.000Z"),
          relationship: "ancestor",
          busy: false,
        },
        {
          ...row("peer", f.second, "Peer title", "2026-02-01T00:00:00.000Z"),
          relationship: "unrelated",
          busy: true,
        },
      ],
      totalMatching: 3,
      nextOffset: 2,
    });
    expect(f.taskService.listInstanceWorkspaces("caller", { limit: 2, offset: 2 })).toStrictEqual({
      rows: [
        {
          ...row("older", f.second, undefined, "2026-01-01T00:00:00.000Z"),
          relationship: "unrelated",
          busy: false,
        },
      ],
      totalMatching: 3,
    });
  });

  test("rejects an empty caller id and invalid paging before reading config", async () => {
    const f = await setup((first) => [[root(first, "caller")], []]);
    f.traceProbes();
    expect(() => f.taskService.listInstanceWorkspaces("", {})).toThrow();
    expect(() => f.taskService.listInstanceWorkspaces("caller", { limit: 0 })).toThrow();
    expect(() => f.taskService.listInstanceWorkspaces("caller", { offset: -1 })).toThrow();
    expect(f.trace).toEqual([]);
  });
});
