import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Config, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { AgentSessionAIService } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { HistoryService } from "./historyService";
import { InitStateManager } from "./initStateManager";
import type { TaskService } from "./taskService";
import {
  createTaskServiceStack,
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "./taskService.testHarness";
import type { WorkspaceHost } from "./taskWorkspaceSeam";
import { createTestHistoryService } from "./testHistoryService";
import type { WorkspaceService } from "./workspaceService";
import {
  createDeferred,
  createMockAIService,
  createWorkspaceServiceForTest,
} from "./workspaceService.testHarness";
import { workspaceUseLeasesFor } from "./workspaceUseLeases";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { SessionFileManager } from "@/node/utils/sessionFile";
import { FileChangeTracker } from "@/node/services/utils/fileChangeTracker";

// Deterministic code repros for the TLA+ model in formal/workspace-leases/ (see its check.sh).
// Each `test.failing` reproduces a violation TLC found and fails at its target assertion; each
// plain test is the passing control that shows the setup reaches the code path under test.
// A fixed repro is a plain test that fails at its target assertion when its fix is reverted.

// ---------------------------------------------------------------------------------------------
// L1 (MC_lease_turn, NoTouchDuringMutation): the turn lease is begun without await in
// completePreparation. It used to be confirmed only before the provider started, so
// prepareMessage ran its checkout work (here a skill's dynamic-context command) while another
// backend's structural mutation gate was live; the send was refused afterwards, but the command
// had already run. Fixed (MC_lease_turn_fixed): preparation confirms the lease first.

describe("L1: turn preparation vs another backend's structural mutation", () => {
  const workspaceId = "ws-lease-formal";
  const sendOptions = {
    model: "openai:gpt-4o",
    agentId: "exec",
    muxMetadata: {
      type: "agent-skill" as const,
      rawCommand: "/probe",
      skillName: "probe",
      scope: "project" as const,
    },
  };
  const idle = { hasRunningBackgroundProcesses: () => Promise.resolve(false) };

  async function setup() {
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
      Promise.resolve(Err({ type: "unknown", raw: "provider stub" }))
    );
    const b = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: { streamMessage },
      captureEvents: true,
    });
    const checkout = b.config.rootDir;
    spyOn(b.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Ok({
        id: workspaceId,
        name: "lease",
        projectName: "project",
        projectPath: checkout,
        namedWorkspacePath: checkout,
        runtimeConfig: { type: "local" },
      } as FrontendWorkspaceMetadata)
    );
    spyOn(b.aiService, "isExperimentEnabled").mockImplementation(
      (id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT
    );
    const skillDir = path.join(checkout, ".xum", "skills", "probe");
    await fs.mkdir(skillDir, { recursive: true });
    // The command appends to a marker in the checkout: the observable "touch".
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: probe\ndescription: Touches the checkout\n---\n!`printf x >> touched.marker`\nbody\n"
    );
    const marker = path.join(checkout, "touched.marker");
    const touched = () =>
      fs.readFile(marker, "utf-8").then(
        (text) => text.length,
        () => 0
      );
    const leasesA = workspaceUseLeasesFor(await createTestConfig(b.config.rootDir));
    return { b, touched, leasesA, streamMessage };
  }

  test("control: without a mutation, the skill command runs in the checkout during preparation", async () => {
    const { b, touched, streamMessage } = await setup();
    try {
      await b.session.sendMessage("/probe", sendOptions);
      expect(await touched()).toBe(1);
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      await b.session.dispose();
      await b.cleanup();
    }
  });

  test("a send refused by another backend's live mutation gate does not run checkout commands first", async () => {
    const { b, touched, leasesA, streamMessage } = await setup();
    try {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      // A renames/removes/archives the workspace: its gate is live for the whole send.
      const mutation = leasesA.withMutationGate([workspaceId], idle, async () => {
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;

      const result = await b.session.sendMessage("/probe", sendOptions);
      expect(!result.success && result.error.type === "unknown" && result.error.raw).toContain(
        "being renamed, removed or archived"
      );
      expect(streamMessage).not.toHaveBeenCalled();
      finish.resolve();
      await mutation;
      // Target assertion: nothing ran in the checkout while A's mutation was in progress.
      expect(await touched()).toBe(0);
    } finally {
      await b.session.dispose();
      await b.cleanup();
    }
  });

  // MC_lease_turn_rename_one: the same backend's rename does not ignore its own turn lease, but a
  // turn AgentSession starts itself bypasses WorkspaceService's in-process renamingWorkspaces check.
  test("a send refused by this backend's own rename does not run checkout commands first", async () => {
    const { b, touched, streamMessage } = await setup();
    try {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const rename = workspaceUseLeasesFor(b.config).withMutationGate(
        [workspaceId],
        { ...idle, ignoreOwnKinds: new Map([[workspaceId, new Set(["exec" as const])]]) },
        async () => {
          entered.resolve();
          await finish.promise;
        }
      );
      await entered.promise;

      const result = await b.session.sendMessage("/probe", sendOptions);
      expect(!result.success && result.error.type === "unknown" && result.error.raw).toContain(
        "being renamed, removed or archived"
      );
      finish.resolve();
      await rename;
      expect(streamMessage).not.toHaveBeenCalled();
      expect(await touched()).toBe(0);
    } finally {
      await b.session.dispose();
      await b.cleanup();
    }
  });

  test("a canceled send refused by another backend's mutation keeps its canceled outcome", async () => {
    const { b, touched, leasesA, streamMessage } = await setup();
    try {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const mutation = leasesA.withMutationGate([workspaceId], idle, async () => {
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;

      const cancel = new AbortController();
      cancel.abort();
      const cancelState = { canceledBeforeAcceptance: false };
      const onCanceled = mock(() => undefined);
      const result = await b.session.sendMessage("/probe", sendOptions, {
        cancelSignal: cancel.signal,
        cancelState,
        onCanceled,
      });
      finish.resolve();
      await mutation;
      expect(result).toEqual(Ok(undefined));
      expect(onCanceled).toHaveBeenCalledTimes(1);
      expect(cancelState.canceledBeforeAcceptance).toBe(true);
      expect(streamMessage).not.toHaveBeenCalled();
      expect(await touched()).toBe(0);
    } finally {
      await b.session.dispose();
      await b.cleanup();
    }
  });

  // Queue dispatch keeps its synchronous startup (the lease is confirmed inside preparation), and a
  // refused queued manual send returns to the composer instead of being dropped or persisted.
  test("a queued send refused by another backend's mutation returns to the input untouched", async () => {
    const { b, touched, leasesA, streamMessage } = await setup();
    try {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const mutation = leasesA.withMutationGate([workspaceId], idle, async () => {
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;

      const failed = createDeferred<void>();
      b.session.queueMessage("/probe", sendOptions, {
        onAcceptedPreStreamFailure: () => failed.resolve(),
      });
      b.session.sendQueuedMessages();
      await failed.promise;
      await b.session.waitForIdle();
      finish.resolve();
      await mutation;
      expect(
        b.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
      ).toEqual(["/probe"]);
      const history = await b.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && history.data.filter((row) => row.role === "user")).toHaveLength(0);
      expect(streamMessage).not.toHaveBeenCalled();
      expect(await touched()).toBe(0);
    } finally {
      await b.session.dispose();
      await b.cleanup();
    }
  });

  // Resumes and retries reach streamWithHistory without prepareMessage: its file-change detection
  // reads tracked checkout files, so it must not run before the lease is confirmed.
  test("a resume refused by another backend's mutation does not read tracked checkout files", async () => {
    const { b, leasesA, streamMessage } = await setup();
    const detect = spyOn(FileChangeTracker.prototype, "getChangedAttachments");
    try {
      await b.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-1", "user", "hello", { timestamp: Date.now() })
      );
      const tracked = path.join(b.config.rootDir, "plan.md");
      await fs.writeFile(tracked, "original");
      await b.session.recordFileState(tracked, {
        content: "original",
        timestamp: (await fs.stat(tracked)).mtimeMs,
      });
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const mutation = leasesA.withMutationGate([workspaceId], idle, async () => {
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;

      const result = await b.session.resumeStream({ model: sendOptions.model, agentId: "exec" });
      finish.resolve();
      await mutation;
      expect(!result.success && result.error.type === "unknown" && result.error.raw).toContain(
        "being renamed, removed or archived"
      );
      expect(streamMessage).not.toHaveBeenCalled();
      expect(detect).not.toHaveBeenCalled();

      // Control: once the mutation ends, the same resume detects file changes and streams.
      await b.session.resumeStream({ model: sendOptions.model, agentId: "exec" });
      expect(detect).toHaveBeenCalledTimes(1);
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      detect.mockRestore();
      await b.session.dispose();
      await b.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// #4918 (InitReplay.tla, MC_init_faithful): two backends, O owns the init, R replays it.

describe("#4918: init replay by another backend", () => {
  const workspaceId = "ws-init-formal";
  let tempDir: string;
  let owner: InitStateManager;
  let ownerConfig: Config;
  let replayer: InitStateManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-lease-formal-"));
    await fs.mkdir(path.join(tempDir, "sessions"), { recursive: true });
    ownerConfig = new Config(tempDir);
    owner = new InitStateManager(ownerConfig);
    replayer = new InitStateManager(new Config(tempDir));
    owner.startInit(workspaceId, "/path/to/hook");
    // startInit's "running" record lands asynchronously, but its write queues on the workspace
    // file lock synchronously: a no-op turn on that lock runs only after the write finished.
    await workspaceFileLocks.withLock(workspaceId, () => Promise.resolve());
    expect((await replayer.readInitStatus(workspaceId))?.status).toBe("running");
  });

  afterEach(async () => {
    mock.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Gap 2 (FinalRecordCorrect): logComplete runs `void endInit(...)` (workspaceService.ts) and
   * withInitUseLease releases the lease without waiting for that write. A slow disk is modelled
   * by holding the workspace file lock, so O's final write is still queued when R replays.
   */
  async function ownerFinishesThenReplay(awaitFinalWriteBeforeRelease: boolean) {
    const lease = await workspaceUseLeasesFor(ownerConfig).hold(workspaceId, "init");
    const locked = createDeferred<void>();
    const unlock = createDeferred<void>();
    const diskBusy = workspaceFileLocks.withLock(workspaceId, async () => {
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    const ownerEnd = owner.endInit(workspaceId, 0); // the hook succeeded
    if (awaitFinalWriteBeforeRelease) {
      unlock.resolve();
      await diskBusy;
      await ownerEnd;
    }
    await lease.release();

    // R's write is queued once it decided the record is unowned: watch for it, then let the
    // disk drain in issue order (O's success first, then R's error).
    const replayerWrite = createDeferred<void>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound below with write.call(this, ...)
    const write = SessionFileManager.prototype.write;
    spyOn(SessionFileManager.prototype, "write").mockImplementation(function (
      this: SessionFileManager<unknown>,
      id,
      data,
      options
    ) {
      const pending = write.call(this, id, data, options);
      if ((data as { status?: string }).status === "error") replayerWrite.resolve();
      return pending;
    });
    const replay = replayer.replayInit(workspaceId);
    if (!awaitFinalWriteBeforeRelease) {
      // Fixed (#4918), R leaves the record alone and never queues a write.
      await Promise.race([replayerWrite.promise, replay]);
      unlock.resolve();
      await diskBusy;
    }
    await Promise.all([ownerEnd, replay]);
  }

  test("control: an owner that awaits its final write before releasing the lease keeps success", async () => {
    await ownerFinishesThenReplay(true);
    expect((await replayer.readInitStatus(workspaceId))?.status).toBe("success");
  });

  test("gap 2: a successful init is not recorded as failed by a replay after the lease release", async () => {
    await ownerFinishesThenReplay(false);
    // Target assertion: the hook reported exit 0.
    expect((await replayer.readInitStatus(workspaceId))?.status).toBe("success");
  });

  test("gap 1: a replay between the owner's running write and its lease hold does not fail the init", async () => {
    // WorkspaceService.createWorkspace registers the row and awaits more work (sanitize,
    // consent) between startInit and runBackgroundInit's hold, so R can open it meanwhile.
    const ends: Array<{ exitCode: number }> = [];
    replayer.on("init-end", (event: { exitCode: number }) => ends.push(event));
    await replayer.replayInit(workspaceId);
    const lease = await workspaceUseLeasesFor(ownerConfig).hold(workspaceId, "init");
    await owner.endInit(workspaceId, 0);
    await lease.release();
    expect((await replayer.readInitStatus(workspaceId))?.status).toBe("success");
    // Target assertion: R never told its clients that the live owner's init failed.
    expect(ends).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// #4928 (ArchiveCascade.tla, MC_cascade_two_backends; fixed: MC_cascade_fixed): A archives a
// parent and its sub-agents; B creates a sub-agent under that parent after A's last check for
// active descendants.

describe("#4928: sub-agent creation under a parent another backend is archiving", () => {
  const realCreateRuntime = runtimeFactory.createRuntime;
  const rootId = "root-cascade";
  const kidId = "kid-cascade";
  const otherRootId = "root-busy";
  const busyId = "kid-busy";

  interface Backend {
    config: Config;
    workspaceService: WorkspaceService;
    taskService: TaskService;
  }

  function createBackend(config: Config, historyService: HistoryService): Backend {
    const aiService = createMockAIService({
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = await config.getWorkspaceMetadataById(workspaceId);
        return metadata ? Ok(metadata) : Err(`Workspace metadata not found for ${workspaceId}`);
      }),
    });
    const workspaceService = createWorkspaceServiceForTest({ config, historyService, aiService });
    const { taskService } = createTaskServiceStack(config, {
      historyService,
      workspaceService: workspaceService as unknown as WorkspaceHost,
    });
    workspaceService.setAgentTaskIntegration(
      taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
    );
    return { config, workspaceService, taskService };
  }

  let cleanupFixture: () => Promise<void>;
  let a: Backend;
  let b: Backend;

  beforeEach(async () => {
    const fixture = await createTestHistoryService();
    cleanupFixture = fixture.cleanup;
    const projectPath = await createTestProject(fixture.tempDir, "repo", { initGit: false });
    const kid = (id: string, parent: string, taskStatus: "reported" | "running") =>
      projectWorkspace(projectPath, id, id, {
        parentWorkspaceId: parent,
        agentType: "explore",
        agentId: "explore",
        taskStatus,
        taskModelString: "openai:gpt-5.2",
        runtimeConfig: { type: "local" },
      });
    await saveWorkspaces(
      fixture.config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        kid(kidId, rootId, "reported"),
        // A running task elsewhere fills the queue, so B's creation only writes its config row.
        { ...projectWorkspace(projectPath, "busy", otherRootId), path: `${projectPath}-busy` },
        kid(busyId, otherRootId, "running"),
      ],
      testTaskSettings(1)
    );
    a = createBackend(fixture.config, fixture.historyService);
    const configB = await createTestConfig(fixture.tempDir);
    b = createBackend(configB, new HistoryService(configB));
    // Real runtimes (agent discovery reads the checkout); checkout deletion stays stubbed.
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: "x" })
    );
    spyOn(runtimeFactory, "createRuntime").mockImplementation((...args) =>
      Object.assign(realCreateRuntime(...args), { deleteWorkspace })
    );
  });

  afterEach(async () => {
    mock.restore();
    await cleanupFixture();
  });

  function liveChildrenOf(config: Config, parentId: string): WorkspaceConfigEntry[] {
    return [...config.loadConfigOrDefault().projects.values()].flatMap((project) =>
      project.workspaces.filter(
        (row) =>
          row.parentWorkspaceId === parentId &&
          !(
            row.archivedAt != null &&
            (row.unarchivedAt == null || row.unarchivedAt < row.archivedAt)
          )
      )
    );
  }

  /**
   * Pause A's archive of `workspaceId` (the parent, or a sub-agent its cascade archives) after its
   * last active-descendant check (archiveUnlocked's hasActiveDescendantAgentTasksForWorkspace)
   * and before its archivedAt commit: at A's next config write, which is that commit or comes
   * before it.
   */
  function pauseArchiveAfterRecheck(
    workspaceId: string,
    aroundFirstEdit?: { before: () => Promise<void>; after: () => Promise<void> }
  ) {
    const reached = createDeferred<void>();
    const release = createDeferred<void>();
    const hasActive = a.taskService.hasActiveDescendantAgentTasksForWorkspace.bind(a.taskService);
    let rechecked = false;
    spyOn(a.taskService, "hasActiveDescendantAgentTasksForWorkspace").mockImplementation((id) => {
      const active = hasActive(id);
      if (id === workspaceId && !active) rechecked = true;
      return active;
    });
    const editConfig = a.config.editConfig.bind(a.config);
    let paused = false;
    let firstEdit = aroundFirstEdit != null;
    spyOn(a.config, "editConfig").mockImplementation(async (...args) => {
      if (firstEdit && aroundFirstEdit != null) {
        firstEdit = false;
        await aroundFirstEdit.before();
        const result = await editConfig(...args);
        await aroundFirstEdit.after();
        return result;
      }
      if (rechecked && !paused) {
        paused = true;
        reached.resolve();
        await release.promise;
      }
      return editConfig(...args);
    });
    return { reached: reached.promise, release: () => release.resolve() };
  }

  const createChild = (parentWorkspaceId = rootId) =>
    b.taskService.create({
      parentWorkspaceId,
      kind: "agent",
      agentId: "explore",
      prompt: "child work",
      title: "child",
    });

  test("control: a creation after the archive committed is refused (parent archived)", async () => {
    expect((await a.workspaceService.archive(rootId)).success).toBe(true);
    const created = await createChild();
    expect(created.success ? "created" : created.error).toContain("archived");
    expect(liveChildrenOf(b.config, rootId)).toEqual([]);
  });

  test("a refused archive reopens sub-agent creation under the parent", async () => {
    await a.config.editConfig((config) => {
      const kid = [...config.projects.values()]
        .flatMap((project) => project.workspaces)
        .find((row) => row.id === kidId);
      if (kid) kid.taskStatus = "running";
      return config;
    });
    const archived = await a.workspaceService.archive(rootId);
    expect(archived.success ? "archived" : archived.error).toContain("active descendant");
    expect(findWorkspaceInConfig(a.config, rootId)?.pendingArchive).toBeUndefined();
    expect((await createChild()).success).toBe(true);
  });

  test("no unarchived sub-agent remains under a parent whose cascade archive committed", async () => {
    const paused = pauseArchiveAfterRecheck(rootId);
    const archiving = a.workspaceService.archive(rootId);
    await paused.reached;
    // B's creation reaches its commit after A's last descendant check, before A's parent commit.
    const created = await createChild();
    paused.release();
    expect((await archiving).success).toBe(true);
    expect(findWorkspaceInConfig(a.config, rootId)?.archivedAt).toBeDefined();
    // Target assertion: the cascade left no live sub-agent under the archived parent.
    expect(liveChildrenOf(a.config, rootId)).toEqual([]);
    // Fixed (#4928): A's pendingArchive marker refused B's creation inside its config write, and
    // A's archivedAt commit cleared the marker.
    expect(created.success ? "created" : created.error).toContain("being archived");
    expect(findWorkspaceInConfig(a.config, rootId)?.pendingArchive).toBeUndefined();
  });

  test("control: archiving a workspace that was never registered refuses as not found", async () => {
    const archived = await a.workspaceService.archive("never-registered");
    expect(archived.success ? "archived" : archived.error).toContain("Workspace not found");
  });

  // A's first lookup finds the parent; B removes the row before A's marker write (A's first config
  // edit) and registers the same id again before A lists the tree. Then B creates a child after
  // A's last descendant check. Without the fail-closed claim, A archived the parent unfenced.
  test("an archive whose row vanished before its marker write refuses instead of running unfenced", async () => {
    const editRows = (edit: (rows: WorkspaceConfigEntry[]) => void) =>
      b.config.editConfig((config) => {
        for (const project of config.projects.values()) edit(project.workspaces);
        return config;
      });
    let removed: WorkspaceConfigEntry | undefined;
    const paused = pauseArchiveAfterRecheck(rootId, {
      before: () =>
        editRows((rows) => {
          const index = rows.findIndex((row) => row.id === rootId);
          if (index >= 0) removed = rows.splice(index, 1)[0];
        }),
      after: () =>
        editRows((rows) => {
          if (removed != null && rows.every((row) => row.path !== removed!.path)) {
            rows.push(removed);
          }
        }),
    });
    const archiving = a.workspaceService.archive(rootId);
    const first = await Promise.race([
      paused.reached.then(() => "paused" as const),
      archiving.then(() => "settled" as const),
    ]);
    const created = first === "paused" ? await createChild() : undefined;
    paused.release();
    const archived = await archiving;
    expect(removed?.id).toBe(rootId);
    const rootArchived = findWorkspaceInConfig(a.config, rootId)?.archivedAt != null;
    // Target assertion: no live sub-agent under an archived parent.
    expect(rootArchived ? liveChildrenOf(a.config, rootId) : []).toEqual([]);
    // Fixed: the claim refused, so nothing was archived and B never had a window.
    expect(archived.success ? "archived" : archived.error).toContain("was removed");
    expect(created).toBeUndefined();
  });

  test("an archive in flight keeps its marker live through a shutdown", async () => {
    const paused = pauseArchiveAfterRecheck(rootId);
    const archiving = a.workspaceService.archive(rootId);
    await paused.reached;
    // A shutdown that retired A's marker token would make B judge the marker dead.
    a.workspaceService.beginShutdown();
    const created = await createChild();
    paused.release();
    await archiving;
    // Target assertion: the marker still refused B's creation.
    expect(created.success ? "created" : created.error).toContain("being archived");
  });

  // #4914: an upgraded workspace whose config row is still id-less (its id lives only in its
  // session metadata). Its archive refuses until a metadata listing records the id.
  async function addLegacyRow(id: string, metadata: string): Promise<void> {
    const rootRow = findWorkspaceInConfig(a.config, rootId)!;
    const projectPath = [...a.config.loadConfigOrDefault().projects.entries()].find(([, project]) =>
      project.workspaces.some((row) => row.id === rootId)
    )![0];
    // Config.findWorkspace reads sessions/<checkout basename>/metadata.json for id-less rows.
    const sessionDir = path.join(a.config.sessionsDir, id);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "metadata.json"),
      metadata.replaceAll("@PROJECT@", projectPath)
    );
    await a.config.editConfig((config) => {
      config.projects
        .get(projectPath)!
        .workspaces.push({ path: path.join(path.dirname(rootRow.path), id) });
      return config;
    });
  }
  const legacyMetadata = (id: string) =>
    JSON.stringify({
      id,
      name: id,
      projectName: "repo",
      projectPath: "@PROJECT@",
      runtimeConfig: { type: "local" },
    });

  test("an id-less workspace refuses to archive until a reload records its id", async () => {
    await addLegacyRow("legacy-root", legacyMetadata("legacy-root"));
    expect(findWorkspaceInConfig(a.config, "legacy-root")).toBeUndefined();
    const refused = await a.workspaceService.archive("legacy-root");
    // Target assertion: no unfenced archive of an id-less row.
    expect(refused.success ? "archived" : refused.error).toContain("has no ID yet");
    // A reload's metadata listing persists the id; then the archive is fenced like any other.
    await a.config.getAllWorkspaceMetadata();
    expect(findWorkspaceInConfig(a.config, "legacy-root")).toBeDefined();
    expect((await a.workspaceService.archive("legacy-root")).success).toBe(true);
    expect(findWorkspaceInConfig(a.config, "legacy-root")?.archivedAt).toBeDefined();
  });

  test("a malformed unrelated legacy session does not block an archive's lookup", async () => {
    // Listed before the target, so a strict scan would rethrow its parse failure first.
    await addLegacyRow("legacy-broken", "{not json");
    await addLegacyRow("legacy-root", legacyMetadata("legacy-root"));
    const refused = await a.workspaceService.archive("legacy-root");
    // Target assertion: the target is still found (and refused with the id hint), not hidden or
    // failed by the unrelated row.
    expect(refused.success ? "archived" : refused.error).toContain("has no ID yet");
    expect((await a.workspaceService.archive(rootId)).success).toBe(true);
  });

  // The cascade archives the sub-agent before the parent. After A listed the tree (the sub-agent
  // was idle) and after the sub-agent's own descendant check, B admits a turn in the sub-agent
  // (a reported sub-agent spawns only during one) and that turn creates a child under it. The new
  // (queued) child makes the parent's check refuse, so without the fence the cascade stopped with
  // the sub-agent archived and its child live.
  test("no unarchived sub-agent remains under a sub-agent the cascade archived", async () => {
    const paused = pauseArchiveAfterRecheck(kidId);
    const archiving = a.workspaceService.archive(rootId);
    await paused.reached;
    await b.config.editConfig((config) => {
      const kid = [...config.projects.values()]
        .flatMap((project) => project.workspaces)
        .find((row) => row.id === kidId);
      if (kid) kid.taskExecutionStatus = "running";
      return config;
    });
    const created = await createChild(kidId);
    paused.release();
    const archived = await archiving;
    expect(findWorkspaceInConfig(a.config, kidId)?.archivedAt).toBeDefined();
    // Target assertion: no live sub-agent under the archived sub-agent.
    expect(liveChildrenOf(a.config, kidId)).toEqual([]);
    // Fixed (#4928): the parent's marker fences its descendants too (assertParentAdmitsChild).
    expect(created.success ? "created" : created.error).toContain("being archived");
    // The sub-agent's own turn still refuses the parent (live activity there is #5161's scope).
    expect(archived.success ? "archived" : archived.error).toContain("active descendant");
  });
});
