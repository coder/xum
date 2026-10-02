import * as fs from "fs/promises";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GoalRecordV1 } from "@/common/types/goal";
import { Ok } from "@/common/types/result";
import type { Config } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import { getWorkspaceScratchDir } from "@/node/runtime/workspaceScratchDir";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import {
  GOAL_STATUS_BOARD_FILE,
  GoalStatusBoardService,
  createWorkspaceBoardBashRunner,
  fetchGoalBoardPrSection,
  renderGoalStatusBoardHtml,
  summarizeChecks,
  type GoalBoardBashRunner,
  type GoalStatusBoardDeps,
} from "./goalStatusBoard";
import { IdleDispatcher } from "./idleDispatcher";
import type { HistoryService } from "./historyService";
import { waitForCondition } from "./testDispatchHelpers";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import {
  PROJECT_PATH,
  analyticsMock,
  continuationBridge,
  setGoalOk,
} from "./workspaceGoalService.testHarness";

const WORKSPACE_ID = "goal-board-ws";
const LOCAL_METADATA = {
  runtimeConfig: { type: "local" as const },
  projectPath: PROJECT_PATH,
  name: "parent",
  namedWorkspacePath: PROJECT_PATH,
};

function goal(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  return {
    version: 1,
    goalId: "11111111-1111-4111-8111-111111111111",
    objective: "Ship the board",
    status: "active",
    budgetCents: 500,
    turnCap: 10,
    costCents: 125,
    turnsUsed: 3,
    attributedChildren: [],
    budgetLimitInjectedForGoalId: null,
    requireUserAcknowledgmentSinceMs: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

/** gh stand-in: answers by which command the script runs. */
function ghRunner(answers: { view: string | null; threads?: string | null }): GoalBoardBashRunner {
  return (_workspaceId, script) =>
    Promise.resolve(script.includes("gh api graphql") ? (answers.threads ?? null) : answers.view);
}

const PR_VIEW = JSON.stringify({
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  statusCheckRollup: [
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "FAILURE" },
    { status: "IN_PROGRESS", conclusion: "" },
    { state: "SUCCESS" },
  ],
});

describe("renderGoalStatusBoardHtml", () => {
  test("escapes attacker-controlled objective, summary and todo text", () => {
    const attack = `</p><script>alert("x")</script><img src=x onerror='y'>`;
    const html = renderGoalStatusBoardHtml({
      goal: goal({ objective: attack, status: "complete", completionSummary: attack }),
      todos: [{ content: attack, status: "pending" }],
      pr: {
        kind: "pr",
        status: {
          number: 1,
          url: `https://h/${attack}`,
          checks: { passed: 0, failed: 0, pending: 0, skipped: 0 },
          unresolvedThreads: null,
        },
      },
      updatedAtMs: 0,
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror='");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});

describe("summarizeChecks", () => {
  test("classifies check runs and status contexts", () => {
    expect(
      summarizeChecks((JSON.parse(PR_VIEW) as { statusCheckRollup: unknown }).statusCheckRollup)
    ).toEqual({
      passed: 2,
      failed: 1,
      pending: 1,
      skipped: 0,
    });
    expect(summarizeChecks(null)).toEqual({ passed: 0, failed: 0, pending: 0, skipped: 0 });
  });

  test("only SUCCESS passes: skipped checks are counted apart and STALE stays pending", () => {
    const checks = summarizeChecks([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "COMPLETED", conclusion: "STALE" },
    ]);
    expect(checks).toEqual({ passed: 1, failed: 0, pending: 1, skipped: 1 });
    const html = renderGoalStatusBoardHtml({
      goal: goal(),
      todos: [],
      pr: {
        kind: "pr",
        status: { number: 7, url: "https://h/7", checks, unresolvedThreads: null },
      },
      updatedAtMs: 0,
    });
    expect(html).toContain(">Pending<");
    expect(html).toContain("1 passed, 0 failed, 1 pending, 1 skipped");
  });
});

describe("fetchGoalBoardPrSection", () => {
  test("gh failure or garbage output is unavailable, and the board says so", async () => {
    for (const view of [null, "not json", JSON.stringify({ number: "x" })]) {
      expect(await fetchGoalBoardPrSection(WORKSPACE_ID, ghRunner({ view }))).toEqual({
        kind: "unavailable",
      });
    }
    const html = renderGoalStatusBoardHtml({
      goal: goal(),
      todos: [],
      pr: { kind: "unavailable" },
      updatedAtMs: 0,
    });
    expect(html).toContain("PR status unavailable");
    expect(html).not.toContain("Last CI run");
  });

  test("no PR omits the section", async () => {
    const pr = await fetchGoalBoardPrSection(WORKSPACE_ID, ghRunner({ view: '{"no_pr":true}\n' }));
    expect(pr).toEqual({ kind: "none" });
    const html = renderGoalStatusBoardHtml({ goal: goal(), todos: [], pr, updatedAtMs: 0 });
    expect(html).not.toContain("Pull request");
  });

  test("reports checks and unresolved threads; a failed thread query keeps the checks", async () => {
    const threads = "banner\n" + JSON.stringify({ total: 120, seen: 100, unresolved: 3 });
    expect(
      await fetchGoalBoardPrSection(WORKSPACE_ID, ghRunner({ view: PR_VIEW, threads }))
    ).toEqual({
      kind: "pr",
      status: {
        number: 42,
        url: "https://github.com/acme/widgets/pull/42",
        checks: { passed: 2, failed: 1, pending: 1, skipped: 0 },
        unresolvedThreads: { count: 3, atLeast: true },
      },
    });
    const noThreads = await fetchGoalBoardPrSection(
      WORKSPACE_ID,
      ghRunner({ view: PR_VIEW, threads: null })
    );
    expect(noThreads).toMatchObject({ kind: "pr", status: { unresolvedThreads: null } });
  });
});

describe("GoalStatusBoardService", () => {
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let enabled: boolean;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    enabled = true;
  });

  afterEach(async () => {
    await cleanup();
  });

  function boardPath(): string {
    return path.join(
      getWorkspaceScratchDir(config.sessionsDir, WORKSPACE_ID),
      "artifacts",
      GOAL_STATUS_BOARD_FILE
    );
  }

  function makeBoard(overrides: Partial<GoalStatusBoardDeps> = {}): GoalStatusBoardService {
    return new GoalStatusBoardService({
      sessionsDir: config.sessionsDir,
      isArtifactsEnabled: () => enabled,
      getWorkspaceMetadata: () => Promise.resolve(LOCAL_METADATA),
      runBash: ghRunner({ view: null }),
      ...overrides,
    });
  }

  async function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(
      () => true,
      () => false
    );
  }

  test("writes the board with the todo checklist, latest goal state wins", async () => {
    const sessionDir = path.join(config.sessionsDir, WORKSPACE_ID);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "todos.json"),
      JSON.stringify([{ content: "Write <tests>", status: "in_progress" }])
    );
    const board = makeBoard();
    board.requestRefresh(WORKSPACE_ID, goal({ objective: "first" }));
    board.requestRefresh(WORKSPACE_ID, goal({ objective: "second" }));
    await board.whenIdle(WORKSPACE_ID);

    const html = await fs.readFile(boardPath(), "utf8");
    expect(html).toContain("second");
    expect(html).toContain("Write &lt;tests&gt;");
    expect(html).toContain("PR status unavailable");
  });

  test("writes nothing while the experiment is off", async () => {
    enabled = false;
    const board = makeBoard();
    board.requestRefresh(WORKSPACE_ID, goal());
    await board.whenIdle(WORKSPACE_ID);
    expect(await exists(boardPath())).toBe(false);
  });

  test("writes nothing when the workspace has no scratch dir, and never throws", async () => {
    const board = makeBoard({
      getWorkspaceMetadata: () =>
        Promise.resolve({
          ...LOCAL_METADATA,
          runtimeConfig: { type: "ssh" as const, host: "example", srcBaseDir: "~/src" },
          projects: [
            { projectPath: "/a", projectName: "a" },
            { projectPath: "/b", projectName: "b" },
          ],
        }),
      runBash: () => Promise.reject(new Error("must not run gh without a board")),
    });
    board.requestRefresh(WORKSPACE_ID, goal());
    await board.whenIdle(WORKSPACE_ID);
    expect(await exists(path.dirname(boardPath()))).toBe(false);
  });

  test("goal set, continuation start and completion refresh the board", async () => {
    await config.addWorkspace(PROJECT_PATH, {
      id: WORKSPACE_ID,
      name: "parent",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    const goalService = new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(config.rootDir, "extensionMetadata.json")),
      analyticsMock()
    );
    const board = makeBoard();
    const seen: string[] = [];
    goalService.setGoalStatusObserver((workspaceId, record) => {
      seen.push(record?.status ?? "none");
      board.requestRefresh(workspaceId, record);
    });
    let continuations = 0;
    goalService.registerGoalContinuationConsumer(new IdleDispatcher(), {
      ...continuationBridge(() => {
        continuations++;
        return Promise.resolve(true);
      }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const created = await setGoalOk(goalService, {
      workspaceId: WORKSPACE_ID,
      objective: "Board <objective>",
    });
    // The kickoff continuation turn starts on its own once the goal is set.
    await waitForCondition(() => continuations > 0 && seen.length >= 2, { timeoutMs: 1_000 });
    await board.whenIdle(WORKSPACE_ID);
    expect(await fs.readFile(boardPath(), "utf8")).toContain("Board &lt;objective&gt;");

    seen.length = 0;
    await setGoalOk(goalService, {
      workspaceId: WORKSPACE_ID,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });
    expect(seen).toContain("complete");
    await board.whenIdle(WORKSPACE_ID);
    expect(await fs.readFile(boardPath(), "utf8")).toContain("Done.");
  });

  test("status and budget edits without an objective refresh the board", async () => {
    await config.addWorkspace(PROJECT_PATH, {
      id: WORKSPACE_ID,
      name: "parent",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    const goalService = new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(config.rootDir, "extensionMetadata.json")),
      analyticsMock()
    );
    const seen: Array<{ status: string; budgetCents: number | null }> = [];
    goalService.setGoalStatusObserver((_workspaceId, record) => {
      if (record != null) seen.push({ status: record.status, budgetCents: record.budgetCents });
    });

    await setGoalOk(goalService, {
      workspaceId: WORKSPACE_ID,
      objective: "Pause me",
      status: "paused",
    });
    seen.length = 0;

    // Pause/resume and budget edits from the Goal UI omit the objective, so they skip the
    // goal-set notification; the board must still see them.
    await setGoalOk(goalService, { workspaceId: WORKSPACE_ID, budgetCents: 500 });
    expect(seen).toContainEqual({ status: "paused", budgetCents: 500 });

    seen.length = 0;
    await setGoalOk(goalService, { workspaceId: WORKSPACE_ID, budgetCents: 500 });
    expect(seen).toEqual([]);
  });

  async function makeGoalService(): Promise<WorkspaceGoalService> {
    await config.addWorkspace(PROJECT_PATH, {
      id: WORKSPACE_ID,
      name: "parent",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    return new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(config.rootDir, "extensionMetadata.json")),
      analyticsMock()
    );
  }

  test("one goal transition notifies the board once", async () => {
    const goalService = await makeGoalService();
    const seen: string[] = [];
    goalService.setGoalStatusObserver((_workspaceId, record) => {
      seen.push(record?.status ?? "none");
    });
    const created = await setGoalOk(goalService, { workspaceId: WORKSPACE_ID, objective: "Once" });
    expect(seen).toEqual(["active"]);
    await setGoalOk(goalService, {
      workspaceId: WORKSPACE_ID,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });
    expect(seen).toEqual(["active", "complete"]);
  });

  test("clearing the last goal replaces the board with No active goal", async () => {
    const goalService = await makeGoalService();
    const board = makeBoard({
      runBash: (_workspaceId, script) =>
        script.includes("gh api graphql")
          ? Promise.resolve(null)
          : Promise.reject(new Error("no gh calls without a goal")),
    });
    const seen: Array<string | null> = [];
    goalService.setGoalStatusObserver((workspaceId, record) => {
      seen.push(record?.objective ?? null);
      board.requestRefresh(workspaceId, record);
    });
    await setGoalOk(goalService, { workspaceId: WORKSPACE_ID, objective: "Old objective" });
    await board.whenIdle(WORKSPACE_ID);
    expect(await fs.readFile(boardPath(), "utf8")).toContain("Old objective");

    await goalService.clearGoal(WORKSPACE_ID);
    expect(seen).toEqual(["Old objective", null]);
    await board.whenIdle(WORKSPACE_ID);
    const html = await fs.readFile(boardPath(), "utf8");
    expect(html).toContain("No active goal");
    expect(html).not.toContain("Old objective");

    // A second clear (no goal to clear) is not a change: no second notification.
    await goalService.clearGoal(WORKSPACE_ID);
    expect(seen).toEqual(["Old objective", null]);
  });

  test("todo changes re-render the checklist with the last goal, and nothing without one", async () => {
    const sessionDir = path.join(config.sessionsDir, WORKSPACE_ID);
    await fs.mkdir(sessionDir, { recursive: true });
    const writeTodos = (content: string) =>
      fs.writeFile(
        path.join(sessionDir, "todos.json"),
        JSON.stringify([{ content, status: "in_progress" }])
      );
    const board = makeBoard();

    await writeTodos("before any goal");
    board.handleTodosChanged(WORKSPACE_ID);
    await board.whenIdle(WORKSPACE_ID);
    expect(await exists(boardPath())).toBe(false);

    board.requestRefresh(WORKSPACE_ID, goal());
    await board.whenIdle(WORKSPACE_ID);
    await writeTodos("Write the second step");
    board.handleTodosChanged(WORKSPACE_ID);
    await board.whenIdle(WORKSPACE_ID);
    expect(await fs.readFile(boardPath(), "utf8")).toContain("Write the second step");

    board.requestRefresh(WORKSPACE_ID, null);
    await board.whenIdle(WORKSPACE_ID);
    await writeTodos("after the goal was cleared");
    board.handleTodosChanged(WORKSPACE_ID);
    await board.whenIdle(WORKSPACE_ID);
    expect(await fs.readFile(boardPath(), "utf8")).not.toContain("after the goal was cleared");
  });

  test("a refresh that outlives workspace removal recreates nothing", async () => {
    const sessionDir = path.join(config.sessionsDir, WORKSPACE_ID);
    await fs.mkdir(sessionDir, { recursive: true });
    // Removal deletes the session dir while the slow gh probe runs.
    const board = makeBoard({
      runBash: async () => {
        await fs.rm(sessionDir, { recursive: true, force: true });
        return null;
      },
    });
    board.requestRefresh(WORKSPACE_ID, goal());
    await board.whenIdle(WORKSPACE_ID);
    expect(await exists(sessionDir)).toBe(false);

    // While removal is in progress, nothing is written even though the dirs still exist.
    await fs.mkdir(sessionDir, { recursive: true });
    let removing = false;
    const guarded = makeBoard({
      isWorkspaceRemoving: () => removing,
      runBash: () => {
        removing = true;
        return Promise.resolve(null);
      },
    });
    guarded.requestRefresh(WORKSPACE_ID, goal());
    await guarded.whenIdle(WORKSPACE_ID);
    expect(await exists(path.join(sessionDir, "scratch"))).toBe(false);
  });

  test("accounting recorded after completion reaches the board", async () => {
    const goalService = await makeGoalService();
    const seen: Array<{ status: string; costCents: number }> = [];
    goalService.setGoalStatusObserver((_workspaceId, record) => {
      if (record != null) seen.push({ status: record.status, costCents: record.costCents });
    });
    const created = await setGoalOk(goalService, {
      workspaceId: WORKSPACE_ID,
      objective: "Bill me",
      budgetCents: 200,
    });
    await setGoalOk(goalService, {
      workspaceId: WORKSPACE_ID,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });
    expect(seen.at(-1)).toEqual({ status: "complete", costCents: 0 });
    // The completing turn is charged at stream end, after complete_goal.
    await goalService.recordStreamAccounting({
      workspaceId: WORKSPACE_ID,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(seen.at(-1)).toEqual({ status: "complete", costCents: 125 });
  });

  test("completing with a queued goal leaves the board on the promoted goal", async () => {
    const goalService = await makeGoalService();
    const seen: Array<string | null> = [];
    goalService.setGoalStatusObserver((_workspaceId, record) => {
      seen.push(record == null ? null : `${record.objective}:${record.status}`);
    });
    await setGoalOk(goalService, { workspaceId: WORKSPACE_ID, objective: "First" });
    await goalService.addUpcomingGoal({ workspaceId: WORKSPACE_ID, objective: "Second" });
    await setGoalOk(goalService, {
      workspaceId: WORKSPACE_ID,
      status: "complete",
      completionSummary: "Wrapped up.",
    });
    expect(seen.at(-1)).toBe("Second:active");
  });

  test("runtime board writes land in distinct wall-clock seconds", async () => {
    let clock = 10_000_400;
    const sleeps: number[] = [];
    const writes: Array<{ kind: string; at: number }> = [];
    const deps = {
      now: () => clock,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      writeArtifact: (location: { kind: string }) => {
        writes.push({ kind: location.kind, at: clock });
        clock += 100; // the write itself takes time
        return Promise.resolve();
      },
    };
    const runtimeBoard = makeBoard({
      ...deps,
      getWorkspaceMetadata: () =>
        Promise.resolve({
          ...LOCAL_METADATA,
          runtimeConfig: { type: "ssh" as const, host: "example", srcBaseDir: "~/src" },
        }),
      // No SSH host to run the scratch mkdir on: the location as if it succeeded.
      resolveLocation: () =>
        Promise.resolve({
          kind: "runtime" as const,
          runtime: {} as unknown as Runtime,
          dir: "~/.xum/scratch/ws/artifacts",
        }),
    });
    runtimeBoard.requestRefresh(WORKSPACE_ID, goal({ objective: "one" }));
    await runtimeBoard.whenIdle(WORKSPACE_ID);
    runtimeBoard.requestRefresh(WORKSPACE_ID, goal({ objective: "two" }));
    await runtimeBoard.whenIdle(WORKSPACE_ID);
    expect(writes.map((write) => write.kind)).toEqual(["runtime", "runtime"]);
    // The first write finished at 10_000_500, so the second starts a full second later: on a
    // runtime whose clock has another sub-second phase, the listed whole-second mtime still
    // changes and the panel re-reads the board.
    expect(writes[1].at).toBe(10_001_500);
    expect(sleeps).toEqual([1000]);

    // Done at host time ...999 and asked again 2 ms later: the host second already changed,
    // but the remote one may not have, so the wait is the rest of the full second.
    clock = 10_004_899;
    runtimeBoard.requestRefresh(WORKSPACE_ID, goal({ objective: "three" }));
    await runtimeBoard.whenIdle(WORKSPACE_ID);
    expect(writes[2].at).toBe(10_004_899);
    clock += 2;
    runtimeBoard.requestRefresh(WORKSPACE_ID, goal({ objective: "four" }));
    await runtimeBoard.whenIdle(WORKSPACE_ID);
    expect(sleeps).toEqual([1000, 998]);

    // Later than a second after the last write: no wait.
    clock += 5_000;
    runtimeBoard.requestRefresh(WORKSPACE_ID, goal({ objective: "five" }));
    await runtimeBoard.whenIdle(WORKSPACE_ID);
    expect(sleeps).toEqual([1000, 998]);

    // Host writes have sub-second mtimes and never wait.
    const hostBoard = makeBoard(deps);
    hostBoard.requestRefresh(WORKSPACE_ID, goal());
    await hostBoard.whenIdle(WORKSPACE_ID);
    hostBoard.requestRefresh(WORKSPACE_ID, goal());
    await hostBoard.whenIdle(WORKSPACE_ID);
    expect(writes.slice(5).map((write) => write.kind)).toEqual(["host", "host"]);
    expect(sleeps).toEqual([1000, 998]);
  });
});

describe("createWorkspaceBoardBashRunner", () => {
  test("runs gh from the repo root, so multi-project workspaces resolve the PR", async () => {
    const calls: unknown[] = [];
    const runBash = createWorkspaceBoardBashRunner((workspaceId, script, options) => {
      calls.push({ workspaceId, script, options });
      return Promise.resolve(
        Ok({ success: true as const, output: "out", exitCode: 0 as const, wall_duration_ms: 1 })
      );
    });
    expect(await runBash(WORKSPACE_ID, "gh pr view", 10)).toBe("out");
    expect(calls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        script: "gh pr view",
        options: { timeout_secs: 10, cwdMode: "repo-root" },
      },
    ]);
  });

  test("runs nothing while project automation is disabled (gh would source tool_env)", async () => {
    let calls = 0;
    const runBash = createWorkspaceBoardBashRunner(() => {
      calls++;
      return Promise.resolve(
        Ok({ success: true as const, output: "out", exitCode: 0 as const, wall_duration_ms: 1 })
      );
    });
    const previous = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
    process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
    try {
      expect(await runBash(WORKSPACE_ID, "gh pr view", 10)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      else process.env[DISABLE_PROJECT_AUTOMATION_ENV] = previous;
    }
    expect(calls).toBe(0);
  });
});
