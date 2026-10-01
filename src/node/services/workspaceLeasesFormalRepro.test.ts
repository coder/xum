import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
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

// Deterministic code repros for the TLA+ model in formal/workspace-leases/ (see its check.sh).
// Each `test.failing` reproduces a violation TLC found and fails at its target assertion; each
// plain test is the passing control that shows the setup reaches the code path under test.

// ---------------------------------------------------------------------------------------------
// L1 (MC_lease_turn, NoTouchDuringMutation): the turn lease is begun without await in
// completePreparation and only confirmed before the provider starts, so prepareMessage runs its
// checkout work (here a skill's dynamic-context command) while another backend's structural
// mutation gate is live. The send is refused afterwards, but the command already ran.

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

  test.failing(
    "a send refused by another backend's live mutation gate does not run checkout commands first",
    async () => {
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
    }
  );
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
      await replayerWrite.promise;
      unlock.resolve();
      await diskBusy;
    }
    await Promise.all([ownerEnd, replay]);
  }

  test("control: an owner that awaits its final write before releasing the lease keeps success", async () => {
    await ownerFinishesThenReplay(true);
    expect((await replayer.readInitStatus(workspaceId))?.status).toBe("success");
  });

  test.failing(
    "gap 2: a successful init is not recorded as failed by a replay after the lease release",
    async () => {
      await ownerFinishesThenReplay(false);
      // Target assertion: the hook reported exit 0.
      expect((await replayer.readInitStatus(workspaceId))?.status).toBe("success");
    }
  );

  test.failing(
    "gap 1: a replay between the owner's running write and its lease hold does not fail the init",
    async () => {
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
    }
  );
});

// ---------------------------------------------------------------------------------------------
// #4928 (ArchiveCascade.tla, MC_cascade_two_backends): A archives a parent and its sub-agents;
// B creates a sub-agent under that parent after A's last check for active descendants.

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
   * Pause A's archive of the parent after its last active-descendant check
   * (archiveUnlocked's hasActiveDescendantAgentTasksForWorkspace) and before its archivedAt
   * commit: at A's next config write, which is that commit or comes before it.
   */
  function pauseParentArchiveAfterRecheck() {
    const reached = createDeferred<void>();
    const release = createDeferred<void>();
    const hasActive = a.taskService.hasActiveDescendantAgentTasksForWorkspace.bind(a.taskService);
    let rechecked = false;
    spyOn(a.taskService, "hasActiveDescendantAgentTasksForWorkspace").mockImplementation((id) => {
      const active = hasActive(id);
      if (id === rootId && !active) rechecked = true;
      return active;
    });
    const editConfig = a.config.editConfig.bind(a.config);
    let paused = false;
    spyOn(a.config, "editConfig").mockImplementation(async (...args) => {
      if (rechecked && !paused) {
        paused = true;
        reached.resolve();
        await release.promise;
      }
      return editConfig(...args);
    });
    return { reached: reached.promise, release: () => release.resolve() };
  }

  const createChild = () =>
    b.taskService.create({
      parentWorkspaceId: rootId,
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

  test.failing(
    "no unarchived sub-agent remains under a parent whose cascade archive committed",
    async () => {
      const paused = pauseParentArchiveAfterRecheck();
      const archiving = a.workspaceService.archive(rootId);
      await paused.reached;
      // B's creation commits after A's last descendant check, before A's parent commit.
      const created = await createChild();
      expect(created.success).toBe(true);
      paused.release();
      expect((await archiving).success).toBe(true);
      expect(findWorkspaceInConfig(a.config, rootId)?.archivedAt).toBeDefined();
      // Target assertion: the cascade left no live sub-agent under the archived parent.
      expect(liveChildrenOf(a.config, rootId)).toEqual([]);
    }
  );
});
