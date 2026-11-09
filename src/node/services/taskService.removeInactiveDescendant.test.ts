/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { WorkspaceRemoveWarning } from "@/common/types/workspace";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import { upsertSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import { upsertSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import type { SubagentRemovalPreview, TaskService } from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createTaskServiceStack,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  initGitRepo,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";
import type { WorkspaceHost, WorkspaceLifecycleResult } from "@/node/services/taskWorkspaceSeam";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  createMockAIService,
  createWorkspaceServiceForTest,
} from "@/node/services/workspaceService.testHarness";

// Characterization tests written before removeInactiveDescendantAgentTaskWhileTaskTreeLocked is
// split into steps. They pin which refusal wins when several apply, the probes each exit runs,
// that the live-writer hold spans every exit after it, the arguments of the final removal, and
// the lock nesting with a real WorkspaceService. taskService.lifecycle.test.ts covers the single
// refusals one at a time.

const ATTEMPT_ID = "att_00000000000000a1";
const HOLD_ERROR = "held by the test";
const WARNING: WorkspaceRemoveWarning = { kind: "leftover", description: "/leftover/child" };
/** Matches any message: the tests never assert prose. */
const PROSE = expect.any(String) as string;

type RemovalResult = Result<WorkspaceLifecycleResult, string>;

/** Private members the trace wraps by name. The split keeps them as instance calls. */
interface RemovalProbes {
  gitPatchArtifactService: {
    withOperationLock<T>(id: string, operation: () => Promise<T>): Promise<T>;
    waitForGeneration(id: string): Promise<void>;
  };
  refuseLossySubagentRemoval(...args: unknown[]): Promise<unknown>;
  describeSubagentRemovalPreview(...args: unknown[]): Promise<unknown>;
  persistRemovedAgentTaskTombstones(taskId: string): Promise<Result<void, string>>;
}

/** Wraps fn so that each call first appends label to the trace. */
function traced<A extends unknown[], R>(trace: string[], fn: (...args: A) => R, label: string) {
  return (...args: A): R => {
    trace.push(label);
    return fn(...args);
  };
}

/** Traces the patch operation lock (inside it) and the private probes of the removal. */
function traceRemovalProbes(taskService: TaskService, trace: string[]) {
  const probes = taskService as unknown as RemovalProbes;
  const patches = probes.gitPatchArtifactService;
  const lock = patches.withOperationLock.bind(patches);
  const lockIds: string[] = [];
  patches.withOperationLock = <T>(id: string, operation: () => Promise<T>) => {
    lockIds.push(id);
    return lock(id, async () => {
      trace.push("patch-lock");
      try {
        return await operation();
      } finally {
        trace.push("patch-unlock");
      }
    });
  };
  patches.waitForGeneration = traced(trace, patches.waitForGeneration.bind(patches), "wait-patch");
  const lossy = mock(traced(trace, probes.refuseLossySubagentRemoval.bind(taskService), "lossy"));
  probes.refuseLossySubagentRemoval = lossy;
  const preview = mock(
    traced(trace, probes.describeSubagentRemovalPreview.bind(taskService), "preview")
  );
  probes.describeSubagentRemovalPreview = preview;
  const persist = probes.persistRemovedAgentTaskTombstones.bind(taskService);
  // The write's own error, or "ok".
  const tombstones: string[] = [];
  probes.persistRemovedAgentTaskTombstones = async (taskId) => {
    trace.push("tombstone");
    const result = await persist(taskId);
    tombstones.push(result.success ? "ok" : result.error);
    return result;
  };
  return { probes, lockIds, lossy, preview, tombstones };
}

/** Edits one config row in place. */
async function editRow(config: Config, id: string, edit: (row: WorkspaceConfigEntry) => void) {
  await config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      const row = project.workspaces.find((workspace) => workspace.id === id);
      if (row != null) edit(row);
    }
    return cfg;
  });
}

/** Drops one config row, as a successful real removal does. */
async function dropRow(config: Config, id: string) {
  await config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      project.workspaces = project.workspaces.filter((workspace) => workspace.id !== id);
    }
    return cfg;
  });
}

/**
 * Collapses a run of config edits into one entry (their count belongs to WorkspaceService). Any
 * other repeated entry stays, so a doubled hold, gate or release fails the nesting asserts.
 */
function collapseRuns(trace: readonly string[]): string[] {
  return trace.filter((label, i) => label !== "config-edit" || trace[i - 1] !== label);
}

describe("TaskService removeInactiveDescendantAgentTask: scope, refusals, hold and locks", () => {
  let rootDir: string;
  // Every test awaits each removal it starts. The background work left is the persist of the
  // config migrations that a load can start (Config.migrationPersist): one more edit on the same
  // serialized queue settles it before the root is deleted, also when a test fails early.
  let configs: Config[];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    configs = [];
  });
  afterEach(async () => {
    mock.restore();
    for (const config of configs.splice(0)) await config.editConfig((cfg) => cfg);
    await removeTaskServiceTestRoot(rootDir);
  });

  /**
   * "child" of "parent" with a clean git checkout that removal deletes, behind a host whose
   * probes read `flags` and append to `trace`. The removal itself is a mock.
   */
  async function setup(extraRows: (projectPath: string) => WorkspaceConfigEntry[] = () => []) {
    const config = await createTestConfig(rootDir);
    configs.push(config);
    const projectPath = path.join(rootDir, "repo");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(childPath, { recursive: true });
    initGitRepo(childPath);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: childPath, encoding: "utf-8" });
    const childRow = projectWorkspace(projectPath, "child", "child", {
      parentWorkspaceId: "parent",
      agentId: "exec",
      agentType: "exec",
      taskStatus: "reported",
      taskBaseCommitSha: base.trim(),
      taskAttemptId: ATTEMPT_ID,
      title: "Reviewer",
    });
    const parentRow = projectWorkspace(projectPath, "parent", "parent");
    const rows = [parentRow, childRow, ...extraRows(projectPath)];
    await saveWorkspaces(config, projectPath, rows, testTaskSettings());
    const trace: string[] = [];
    const flags = { streaming: false, bash: false, holdRefused: false, externalApp: false };
    let removal: () => Promise<Result<void> & { warnings?: WorkspaceRemoveWarning[] }> = () =>
      Promise.resolve(Ok(undefined));
    const remove = mock((..._args: unknown[]) => {
      trace.push("remove");
      return removal();
    });
    const host = createWorkspaceServiceMocks({ removeWhileTaskTreeLocked: remove });
    const ws = host.workspaceService;
    spyOn(ws, "hasRunningBackgroundBashProcesses").mockImplementation(() => {
      trace.push("bash");
      return Promise.resolve(flags.bash);
    });
    const hold = spyOn(ws, "acquirePreInterruptionArchiveHold").mockImplementation(() => {
      trace.push("hold");
      if (flags.holdRefused) return Err(HOLD_ERROR);
      return Ok({ [Symbol.dispose]: () => trace.push("release") });
    });
    spyOn(ws, "hasUntrackableExternalAppOpen").mockImplementation(() => {
      trace.push("external-app");
      return Promise.resolve(flags.externalApp);
    });
    const isStreaming = mock((id: string) => {
      trace.push("streaming");
      return flags.streaming && id === "child";
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { workspaceService: ws, aiService });
    const probes = traceRemovalProbes(taskService, trace);
    const onRemovalWarnings = mock((_warnings: WorkspaceRemoveWarning[]) => {
      trace.push("warnings");
    });
    const setRemoval = (next: typeof removal) => {
      removal = next;
    };
    return {
      ...{ config, projectPath, childPath, taskService, ...probes },
      ...{ trace, flags, remove, hold, onRemovalWarnings, setRemoval },
    };
  }

  /** Writes the child's patch artifact under the parent's session dir. */
  async function writePatchArtifact(config: Config, status: "pending" | "skipped") {
    // The artifact status is derived from its project entries.
    const project = { projectPath: path.join(rootDir, "repo"), projectName: "repo" };
    await upsertSubagentGitPatchArtifact({
      locks: nodeSessionLocks,
      workspaceId: "parent",
      workspaceSessionDir: path.join(config.sessionsDir, "parent"),
      childTaskId: "child",
      updater: () => ({
        ...{ childTaskId: "child", parentWorkspaceId: "parent", createdAtMs: 1, updatedAtMs: 1 },
        status,
        projectArtifacts: [
          status === "pending"
            ? { ...project, storageKey: "repo", status }
            : { ...project, storageKey: "repo", status, commitCount: 0 },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: status === "skipped" ? 1 : 0,
        totalCommitCount: 0,
      }),
    });
  }

  const target = {
    action: "remove",
    taskId: "child",
    workspaceId: "child",
    displayName: "Reviewer",
  } as const;

  test("a row outside the owner's tree is out of scope before any probe", async () => {
    const f = await setup((projectPath) => [
      projectWorkspace(projectPath, "other", "other-root"),
      projectWorkspace(projectPath, "foreign", "foreign", {
        parentWorkspaceId: "other-root",
        taskStatus: "reported",
      }),
    ]);
    const result = await f.taskService.removeInactiveDescendantAgentTask("parent", "foreign", {
      lossyWorkPolicy: "refuse",
    });
    expect(result).toEqual(Ok({ status: "invalid_scope", action: "remove", taskId: "foreign" }));
    expect(f.trace).toEqual([]);
    expect(findWorkspaceInConfig(f.config, "foreign")?.id).toBe("foreign");
  });

  test("a missing row is already removed only when a tombstone or a parent report owns it", async () => {
    const f = await setup();
    const removeAsOwner = (taskId: string) =>
      f.taskService.removeInactiveDescendantAgentTask("parent", taskId);
    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: "parent",
      workspaceSessionDir: path.join(f.config.sessionsDir, "parent"),
      childTaskId: "reported-child",
      parentWorkspaceId: "parent",
      ancestorWorkspaceIds: ["parent"],
      reportMarkdown: "done",
      nowMs: 1,
    });
    // The mock removal leaves the row, so drop it as the real one would: only the tombstone the
    // successful removal wrote still owns the id.
    expect(await removeAsOwner("child")).toEqual(Ok({ status: "removed", ...target }));
    await dropRow(f.config, "child");
    f.trace.length = 0;

    const alreadyRemoved = (taskId: string): RemovalResult =>
      Ok({ status: "already_removed", action: "remove", taskId, workspaceId: taskId });
    expect(await removeAsOwner("child")).toEqual(alreadyRemoved("child"));
    expect(await removeAsOwner("reported-child")).toEqual(alreadyRemoved("reported-child"));
    expect(await removeAsOwner("never-owned")).toEqual(
      Ok({ status: "invalid_scope", action: "remove", taskId: "never-owned" })
    );
    expect(f.trace).toEqual([]);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  // Every refusal applies at first. Each step clears the one that won, so the next one wins.
  test("the first refusal that applies wins, and every exit after the hold releases it", async () => {
    const f = await setup((projectPath) => [
      projectWorkspace(projectPath, "grandchild", "grandchild", {
        parentWorkspaceId: "child",
        taskStatus: "reported",
      }),
    ]);
    await editRow(f.config, "child", (row) => (row.taskStatus = "running"));
    Object.assign(f.flags, { streaming: true, bash: true, holdRefused: true, externalApp: true });
    await writePatchArtifact(f.config, "pending");
    const notes = path.join(f.childPath, "notes.txt");
    await fsPromises.writeFile(notes, "unsaved\n");
    let acknowledgedWork: SubagentRemovalPreview = { summary: null, paths: ["gone.txt"] };
    // A regular file where the tombstone dir goes makes its mkdir fail.
    const tombstoneDir = path.join(f.config.sessionsDir, "parent", "removed-agent-tasks");
    await fsPromises.writeFile(tombstoneDir, "");
    f.setRemoval(() => Promise.resolve({ ...Err("checkout busy"), warnings: [WARNING] }));

    interface ErrorFields {
      descendantTaskIds?: string[];
      paths?: string[];
      error?: string;
    }
    const error = (fields: ErrorFields = {}): RemovalResult =>
      Ok({ status: "error", ...target, error: PROSE, ...fields });
    const note = PROSE;
    const active: RemovalResult = Ok({
      status: "active",
      ...target,
      activeTaskIds: ["child"],
      note,
    });
    const head = ["streaming", "patch-lock", "wait-patch"];
    const locked = (...probes: string[]) => [...head, ...probes, "patch-unlock"];
    const held = (...probes: string[]) =>
      locked("bash", "hold", "external-app", ...probes, "release");
    const succeed = () => Promise.resolve({ ...Ok(undefined), warnings: [WARNING] });
    const steps: Array<
      [wins: string, result: RemovalResult, trace: string[], clear: () => unknown]
    > = [
      [
        "descendants",
        error({ descendantTaskIds: ["grandchild"] }),
        [],
        () => dropRow(f.config, "grandchild"),
      ],
      [
        "active row",
        active,
        [],
        () => editRow(f.config, "child", (row) => (row.taskStatus = "reported")),
      ],
      ["streaming", active, ["streaming"], () => (f.flags.streaming = false)],
      ["pending patch", error(), locked(), () => writePatchArtifact(f.config, "skipped")],
      ["background bash", error(), locked("bash"), () => (f.flags.bash = false)],
      [
        "refused hold",
        error({ error: HOLD_ERROR }),
        locked("bash", "hold"),
        () => (f.flags.holdRefused = false),
      ],
      ["external app", error(), held(), () => (f.flags.externalApp = false)],
      ["lossy work", error({ paths: ["notes.txt"] }), held("lossy"), () => fsPromises.rm(notes)],
      [
        "changed work",
        error(),
        held("lossy", "preview"),
        () => (acknowledgedWork = { summary: null, paths: [] }),
      ],
      [
        "tombstone",
        error(),
        held("lossy", "preview", "tombstone"),
        () => fsPromises.rm(tombstoneDir),
      ],
      // A failed removal forwards no warnings, even ones it reports.
      [
        "failed removal",
        error({ error: "checkout busy" }),
        held("lossy", "preview", "tombstone", "remove"),
        () => f.setRemoval(succeed),
      ],
      [
        "none",
        Ok({ status: "removed", ...target }),
        held("lossy", "preview", "tombstone", "remove", "warnings"),
        () => undefined,
      ],
    ];
    const results = new Map<string, RemovalResult>();
    for (const [wins, result, trace, clear] of steps) {
      f.trace.length = 0;
      const actual = await f.taskService.removeInactiveDescendantAgentTask("parent", "child", {
        lossyWorkPolicy: "refuse",
        acknowledgedWork,
        onRemovalWarnings: f.onRemovalWarnings,
      });
      results.set(wins, actual);
      expect({ wins, result: actual, trace: f.trace }).toEqual({ wins, result, trace });
      await clear();
    }

    // The tombstone refusal reports the write's own error.
    expect(f.tombstones).toHaveLength(3);
    expect(results.get("tombstone")).toEqual(error({ error: f.tombstones[0] }));
    expect(f.onRemovalWarnings.mock.calls).toEqual([[[WARNING]]]);
    expect(f.lockIds).toEqual(Array.from({ length: 9 }, () => "child"));
    const holdOptions = { queuedDelegatedTurnCount: 0, expectedDelegatedTurnCorrelations: [] };
    expect(f.hold.mock.calls).toEqual(
      Array.from({ length: 7 }, () => ["child", { ...holdOptions, operation: "remove" }])
    );
    const removal = ["child", true, { expectedAttemptId: ATTEMPT_ID }, undefined];
    expect(f.remove.mock.calls).toEqual([removal, removal]);
    // The checks read the entry and the patch artifact taken before the awaits.
    const workspace: unknown = expect.objectContaining({ id: "child", taskAttemptId: ATTEMPT_ID });
    const checkedEntry = { projectPath: f.projectPath, workspace };
    const artifact: unknown = expect.objectContaining({ childTaskId: "child", status: "skipped" });
    expect(f.lossy.mock.calls.at(-1)).toEqual(["child", checkedEntry, artifact]);
    expect(f.preview.mock.calls.at(-1)).toEqual(["child", checkedEntry, artifact]);
  }, 20_000);

  test("without the refuse policy, live writers and confirmed work do not block and no hold is taken", async () => {
    const f = await setup();
    Object.assign(f.flags, { bash: true, holdRefused: true, externalApp: true });
    for (const file of ["a.txt", "b.txt"]) {
      await fsPromises.writeFile(path.join(f.childPath, file), "unsaved\n");
    }
    const preview = await f.taskService.previewSubagentRemoval("child");
    expect(preview).toEqual(Ok({ summary: PROSE, paths: ["a.txt", "b.txt"] }));
    const confirmed = preview.success ? preview.data : undefined;
    const removeConfirmed = (acknowledgedWork: SubagentRemovalPreview | undefined) =>
      f.taskService.removeInactiveDescendantAgentTask("parent", "child", {
        acknowledgedWork,
        mutationGateHeld: true,
      });

    // The summary and the paths must both match, and the paths as a list, not as one string.
    const refused: RemovalResult = Ok({ status: "error", ...target, error: PROSE });
    const summary = confirmed?.summary ?? null;
    expect(await removeConfirmed({ summary: null, paths: ["a.txt", "b.txt"] })).toEqual(refused);
    expect(await removeConfirmed({ summary, paths: ["a.txtb.txt"] })).toEqual(refused);
    f.trace.length = 0;
    expect(await removeConfirmed(confirmed)).toEqual(Ok({ status: "removed", ...target }));
    expect(f.trace).toEqual([
      ...["streaming", "patch-lock", "wait-patch", "preview", "tombstone", "remove"],
      "patch-unlock",
    ]);
    expect(f.remove.mock.calls).toEqual([
      ["child", true, { expectedAttemptId: ATTEMPT_ID }, { mutationGateHeld: true }],
    ]);
  }, 20_000);

  test("the removal is bound to the attempt read at entry and passes only a held gate", async () => {
    const f = await setup();
    const nextAttemptId = "att_00000000000000b2";
    // #4478: another backend starts a new attempt while this removal waits for the patch job.
    const patches = f.probes.gitPatchArtifactService;
    const wait = patches.waitForGeneration.bind(patches);
    patches.waitForGeneration = async (id) => {
      await wait(id);
      await editRow(f.config, "child", (row) => (row.taskAttemptId = nextAttemptId));
    };
    f.setRemoval(() => Promise.resolve({ ...Ok(undefined), warnings: [] }));
    const removeWith = (options?: { mutationGateHeld: boolean }) =>
      f.taskService.removeInactiveDescendantAgentTask("parent", "child", {
        ...options,
        onRemovalWarnings: f.onRemovalWarnings,
      });

    expect(await removeWith()).toEqual(Ok({ status: "removed", ...target }));
    expect(f.trace).toEqual([
      "streaming",
      "patch-lock",
      "wait-patch",
      "tombstone",
      "remove",
      "patch-unlock",
    ]);
    patches.waitForGeneration = wait;
    expect(await removeWith({ mutationGateHeld: false })).toEqual(
      Ok({ status: "removed", ...target })
    );
    expect(await removeWith({ mutationGateHeld: true })).toEqual(
      Ok({ status: "removed", ...target })
    );

    expect(f.remove.mock.calls).toEqual([
      ["child", true, { expectedAttemptId: ATTEMPT_ID }, undefined],
      ["child", true, { expectedAttemptId: nextAttemptId }, undefined],
      ["child", true, { expectedAttemptId: nextAttemptId }, { mutationGateHeld: true }],
    ]);
    // An empty warning list is not forwarded.
    expect(f.onRemovalWarnings).not.toHaveBeenCalled();
  });

  test("the removal stays bound to the attempt read at entry while a patch job holds the lock", async () => {
    const f = await setup();
    const nextAttemptId = "att_00000000000000c3";
    const patches = f.probes.gitPatchArtifactService;
    // A patch job holds the child's operation lock until the test releases it.
    const jobRunning = Promise.withResolvers<void>();
    const jobHeld = Promise.withResolvers<void>();
    const job = patches.withOperationLock("child", async () => {
      jobRunning.resolve();
      await jobHeld.promise;
    });
    await jobRunning.promise;
    // Resolves once the removal asks for the lock, so the edit below lands while it waits.
    const lock = patches.withOperationLock.bind(patches);
    const removalQueued = Promise.withResolvers<void>();
    patches.withOperationLock = <T>(id: string, operation: () => Promise<T>) => {
      const locked = lock(id, operation);
      removalQueued.resolve();
      return locked;
    };
    const removal = f.taskService.removeInactiveDescendantAgentTask("parent", "child");
    await removalQueued.promise;
    // #4478: another backend starts a new attempt before this removal gets the lock.
    await editRow(f.config, "child", (row) => (row.taskAttemptId = nextAttemptId));
    f.trace.push("new-attempt");
    jobHeld.resolve();
    await job;

    expect(await removal).toEqual(Ok({ status: "removed", ...target }));
    expect(f.trace).toEqual([
      ...["patch-lock", "streaming", "new-attempt", "patch-unlock"],
      ...["patch-lock", "wait-patch", "tombstone", "remove", "patch-unlock"],
    ]);
    expect(f.remove.mock.calls).toEqual([
      ["child", true, { expectedAttemptId: ATTEMPT_ID }, undefined],
    ]);
  });

  test("a removal that throws releases the hold and both locks, then rethrows", async () => {
    const f = await setup();
    const failure = new Error("runtime gone");
    f.setRemoval(() => Promise.reject(failure));
    const removeAsModel = () =>
      f.taskService.removeInactiveDescendantAgentTask("parent", "child", {
        lossyWorkPolicy: "refuse",
      });

    await expect(removeAsModel()).rejects.toBe(failure);
    expect(f.trace).toEqual([
      ...["streaming", "patch-lock", "wait-patch", "bash", "hold", "external-app", "lossy"],
      ...["tombstone", "remove", "release", "patch-unlock"],
    ]);
    // The tree lock and the patch lock are free again: the retry runs to the end.
    f.setRemoval(() => Promise.resolve(Ok(undefined)));
    expect(await removeAsModel()).toEqual(Ok({ status: "removed", ...target }));
  });

  // The structural mutation gate and the config edits run inside the real WorkspaceService removal.
  test("with a real WorkspaceService the removal nests patch lock, hold, gate and config edits", async () => {
    const config = await createTestConfig(rootDir);
    configs.push(config);
    const historyService = new HistoryService(config);
    const projectPath = await createTestProject(rootDir, "repo");
    const srcBaseDir = path.join(rootDir, "src");
    const child = (id: string): WorkspaceConfigEntry => {
      const checkout = path.join(srcBaseDir, "repo", id);
      execFileSync("git", ["worktree", "add", "-q", "-b", id, checkout], { cwd: projectPath });
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf-8" });
      return {
        ...{ id, name: id, path: checkout, runtimeConfig: { type: "worktree", srcBaseDir } },
        ...{
          parentWorkspaceId: "root",
          agentType: "exec",
          agentId: "exec",
          taskStatus: "reported",
        },
        ...{ taskBaseCommitSha: base.trim(), taskAttemptId: ATTEMPT_ID },
      };
    };
    const rows = [projectWorkspace(projectPath, "root", "root"), child("gated"), child("pregated")];
    await saveWorkspaces(config, projectPath, rows, testTaskSettings());
    // Metadata is answered from the Config, as AIService does, so the removal deletes the checkout.
    const getWorkspaceMetadata = mock(async (id: string) => {
      const metadata = await config.getWorkspaceMetadataById(id);
      return metadata ? Ok(metadata) : Err(`no metadata for ${id}`);
    });
    const aiService = createMockAIService({ getWorkspaceMetadata });
    const workspaceService = createWorkspaceServiceForTest({ config, historyService, aiService });
    const { taskService } = createTaskServiceStack(config, {
      historyService,
      workspaceService: workspaceService as unknown as WorkspaceHost,
    });
    workspaceService.setAgentTaskIntegration(
      taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
    );
    const trace: string[] = [];
    traceRemovalProbes(taskService, trace);
    const hold = workspaceService.acquirePreInterruptionArchiveHold.bind(workspaceService);
    spyOn(workspaceService, "acquirePreInterruptionArchiveHold").mockImplementation(
      (id, options) => {
        const result = hold(id, options);
        if (!result.success) return result;
        trace.push("hold");
        return Ok({
          [Symbol.dispose]: () => {
            trace.push("release");
            result.data[Symbol.dispose]();
          },
        });
      }
    );
    const gates = workspaceService as unknown as {
      acquireStructuralMutationGate(...args: unknown[]): Promise<Result<() => Promise<void>>>;
    };
    const gate = gates.acquireStructuralMutationGate.bind(workspaceService);
    spyOn(gates, "acquireStructuralMutationGate").mockImplementation(async (...args) => {
      const result = await gate(...args);
      if (!result.success) return result;
      trace.push("gate");
      return Ok(() => {
        trace.push("gate-release");
        return result.data();
      });
    });
    const edit = config.editConfig.bind(config);
    spyOn(config, "editConfig").mockImplementation((...args) => {
      trace.push("config-edit");
      return edit(...args);
    });
    const removeAsModel = (id: string, mutationGateHeld?: true) =>
      taskService.removeInactiveDescendantAgentTask("root", id, {
        lossyWorkPolicy: "refuse",
        mutationGateHeld,
      });

    const removed = (id: string): RemovalResult =>
      Ok({ status: "removed", action: "remove", taskId: id, workspaceId: id, displayName: id });
    expect(await removeAsModel("gated")).toEqual(removed("gated"));
    const before = ["patch-lock", "wait-patch", "hold", "lossy", "tombstone"];
    expect(collapseRuns(trace)).toEqual([
      ...before,
      ...["gate", "config-edit", "gate-release", "release", "patch-unlock"],
    ]);
    trace.length = 0;
    expect(await removeAsModel("pregated", true)).toEqual(removed("pregated"));
    expect(collapseRuns(trace)).toEqual([...before, "config-edit", "release", "patch-unlock"]);
    expect(findWorkspaceInConfig(config, "gated")).toBe(undefined);
    expect(findWorkspaceInConfig(config, "pregated")).toBe(undefined);
  }, 20_000);
});
