import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import * as path from "path";

import type { ProjectsConfig } from "@/common/types/project";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { SecretsStore, type Config, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Ok } from "@/common/types/result";
import type { RuntimeConfig } from "@/common/types/runtime";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { InitStateManager } from "@/node/services/initStateManager";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import {
  TASK_CHECKOUT_PREPARATION_NONCE_FILE,
  bindTaskCheckoutIdentity,
  buildTaskCheckoutPreparation,
  claimTaskCheckoutIdentity,
  newMaterializationId,
  validateTaskCheckoutPreparation,
  type TaskCheckoutPreparation,
} from "@/node/services/taskCheckoutPreparation";
import { TaskService } from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createTestProject,
  findWorkspaceInConfig,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import * as crossProcessLock from "@/node/utils/main/crossProcessLock";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

/**
 * Producer side of the task-checkout preparation protocol, over the real stack (Config +
 * WorkspaceService + WorkspaceMcpOverridesService + TaskService, real git worktrees; only the
 * hosted send and the init hook are stubbed):
 *
 * - a RESERVED dedicated checkout is forked, pruned, claimed and bound BEFORE its row is
 *   published, the proof rides the row's first write, and the launch reuses that directory
 *   without forking or pruning again;
 * - a refused preparation publishes nothing and retains the claimed fork;
 * - the launch gate refuses legacy (proof-less), missing and context-less shared rows without
 *   forking, and a shared row keeps its discriminator.
 */
const rootId = "prepparent1";
const STALE_PLUGIN_KEY = "plugin:0123456789abcdef:evil";
const OVERRIDES_RELATIVE_PATH = path.join(".xum", "mcp.local.jsonc");

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "ignore" });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await settle();
  }
}
const pathExists = (candidate: string) =>
  fsPromises.access(candidate).then(
    () => true,
    () => false
  );

describe("TaskService reserved launch: task checkout preparation (producer side)", () => {
  let history: Awaited<ReturnType<typeof createTestHistoryService>>;
  let rootDir: string;
  const restores: Array<() => void> = [];

  beforeEach(async () => {
    history = await createTestHistoryService();
    rootDir = history.tempDir;
    await fsPromises.mkdir(history.config.srcDir, { recursive: true });
    const initSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    restores.push(() => initSpy.mockRestore());
  });
  afterEach(async () => {
    for (const restore of restores.splice(0)) restore();
    await history.cleanup();
  });

  const forkPathFor = (srcDir: string, taskId: string) =>
    path.join(srcDir, "repo", `agent_explore_${taskId}`);

  /** A repository whose main branch TRACKS a stale plugin enable (every fork materializes it). */
  async function createRepoWithTrackedEnable(
    document = JSON.stringify({ enabledServers: [STALE_PLUGIN_KEY] })
  ) {
    const projectPath = await createTestProject(rootDir, "repo");
    await fsPromises.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fsPromises.writeFile(path.join(projectPath, OVERRIDES_RELATIVE_PATH), document, "utf-8");
    git(projectPath, "add .xum/mcp.local.jsonc");
    git(projectPath, 'commit -m "track a workspace override"');
    return projectPath;
  }

  /**
   * `secondaryProjectPath`: the parent is a multi-project workspace of both repositories (a
   * parent worktree in each, the multi-project experiment on), so its dedicated tasks fork one
   * checkout per project.
   */
  async function createRealStack(
    projectPath: string,
    extraRows: WorkspaceConfigEntry[] = [],
    options: { secondaryProjectPath?: string } = {}
  ) {
    const { config, historyService } = history;
    const runtimeConfig: RuntimeConfig = { type: "worktree", srcBaseDir: config.srcDir };
    const parentName = "parent";
    const projectPaths = [
      projectPath,
      ...(options.secondaryProjectPath ? [options.secondaryProjectPath] : []),
    ];
    for (const repo of projectPaths) {
      const created = await createRuntime(runtimeConfig, { projectPath: repo }).createWorkspace({
        projectPath: repo,
        branchName: parentName,
        trunkBranch: "main",
        directoryName: parentName,
        initLogger: {
          logStep: () => undefined,
          logStdout: () => undefined,
          logStderr: () => undefined,
          logComplete: () => undefined,
          enterHookPhase: () => undefined,
        },
      });
      if (!created.success) throw new Error(`parent worktree: ${created.error ?? "unknown"}`);
    }
    const parentPath = createRuntime(runtimeConfig, { projectPath }).getWorkspacePath(
      projectPath,
      parentName
    );
    await fsPromises.writeFile(
      path.join(parentPath, OVERRIDES_RELATIVE_PATH),
      JSON.stringify({ enabledServers: [] }),
      "utf-8"
    );
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: rootId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
          ...(options.secondaryProjectPath
            ? {
                projects: projectPaths.map((repo) => ({
                  projectPath: repo,
                  projectName: path.basename(repo),
                })),
              }
            : {}),
        },
        ...extraRows,
      ],
      {
        taskSettings: testTaskSettings(),
        extraProjects: options.secondaryProjectPath
          ? [[options.secondaryProjectPath, { trusted: true, workspaces: [] }]]
          : [],
      }
    );

    const { aiService } = createAIServiceMocks(config);
    const initStateManager = new InitStateManager(config);
    const workspaceService = new WorkspaceService(
      config,
      historyService,
      aiService,
      new ContextManagementService({ config, historyService, aiService }),
      initStateManager,
      new ExtensionMetadataService(path.join(config.rootDir, "extension-metadata.json")),
      new BackgroundProcessManager(path.join(config.rootDir, "bg"))
    );
    const overridesService = new WorkspaceMcpOverridesService(config);
    workspaceService.setWorkspaceMcpOverridesService(overridesService);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const taskService = new TaskService(
      config,
      historyService,
      aiService,
      workspaceService,
      initStateManager,
      undefined,
      undefined,
      new SecretsStore(config.rootDir),
      terminalAttentionStore
    );
    taskService.setWorkspaceTurnManager(
      new WorkspaceTurnManager(
        config,
        historyService,
        aiService,
        workspaceService,
        initStateManager,
        taskService,
        terminalAttentionStore,
        aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7]
      )
    );
    workspaceService.setAgentTaskIntegration(taskService);
    if (options.secondaryProjectPath) {
      const experiments = spyOn(workspaceService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
      );
      restores.push(() => experiments.mockRestore());
    }
    const sends: string[] = [];
    const sendMessage = spyOn(workspaceService, "sendMessage").mockImplementation(((
      ...args: Parameters<WorkspaceHost["sendMessage"]>
    ) => {
      sends.push(args[0]);
      args[3]?.turnAdmission?.onDisposed("no-work");
      return Promise.resolve(Ok(undefined));
    }) as WorkspaceService["sendMessage"]);
    restores.push(() => sendMessage.mockRestore());
    return { config, taskService, workspaceService, overridesService, parentPath, sends };
  }

  const createArgs = (title: string) => ({
    parentWorkspaceId: rootId,
    kind: "agent" as const,
    agentId: "explore",
    prompt: "go",
    title,
  });

  test("a reserved dedicated checkout is forked, pruned, claimed and bound BEFORE its row is published; the launch reuses it without forking or pruning again", async () => {
    const taskId = "prepreserved1";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, workspaceService, overridesService, sends } =
      await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const forkPath = forkPathFor(config.srcDir, taskId);
    const documentPath = path.join(forkPath, OVERRIDES_RELATIVE_PATH);
    const observedAtPublish: Array<{
      rowPublished: boolean;
      document: string;
      nonce: string;
      proofs: readonly TaskCheckoutPreparation[];
    }> = [];
    const realPrepare = workspaceService.prepareTaskCheckouts.bind(workspaceService);
    const prepareSpy = spyOn(workspaceService, "prepareTaskCheckouts").mockImplementation(
      (materialize, publish) =>
        realPrepare(materialize, async (proofs) => {
          // The commit runs here: the fork exists, is already pruned and carries its nonce, and
          // no reader can see the row yet.
          observedAtPublish.push({
            rowPublished: findWorkspaceInConfig(config, taskId) !== undefined,
            document: await fsPromises.readFile(documentPath, "utf-8"),
            nonce: (
              await fsPromises.readFile(
                path.join(proofs[0].gitdir.pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE),
                "utf-8"
              )
            ).trim(),
            proofs,
          });
          return publish(proofs);
        })
    );
    restores.push(() => prepareSpy.mockRestore());
    const sanitizeSpy = spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace");
    restores.push(() => sanitizeSpy.mockRestore());
    // The claim (nonce write) rides the prune's MUTATING `claimUnderLock` hook — joined before
    // the locks release — never the read-only `shouldPrune` verdict a deadline may detach.
    const nonceExists = () =>
      pathExists(path.join(forkPath, ".git")).then(async (isWorktree) => {
        if (!isWorktree) return false;
        const pointer = (await fsPromises.readFile(path.join(forkPath, ".git"), "utf-8"))
          .replace(/^gitdir:\s*/, "")
          .trim();
        return pathExists(path.join(pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE));
      });
    const nonceAfterVerdict: boolean[] = [];
    const nonceAfterClaim: boolean[] = [];
    const realPrune =
      overridesService.prunePluginOverrideKeysForUnregisteredCheckout.bind(overridesService);
    const pruneSpy = spyOn(
      overridesService,
      "prunePluginOverrideKeysForUnregisteredCheckout"
    ).mockImplementation((target, keyPrefix, options) =>
      realPrune(target, keyPrefix, {
        ...options,
        shouldPrune: async () => {
          const verdict = (await options?.shouldPrune?.()) ?? true;
          nonceAfterVerdict.push(await nonceExists());
          return verdict;
        },
        claimUnderLock: async () => {
          await options?.claimUnderLock?.();
          nonceAfterClaim.push(await nonceExists());
        },
      })
    );
    restores.push(() => pruneSpy.mockRestore());

    const created = await taskService.createMany([createArgs("Reserved")]);
    expect(created).toMatchObject({ success: true });
    expect(nonceAfterVerdict).toEqual([false]);
    expect(nonceAfterClaim).toEqual([true]);
    expect(observedAtPublish).toHaveLength(1);
    const [atPublish] = observedAtPublish;
    expect(atPublish.rowPublished).toBe(false);
    expect(JSON.parse(atPublish.document)).toEqual({ enabledServers: [] });
    expect(atPublish.proofs).toHaveLength(1);
    expect(atPublish.nonce).toBe(atPublish.proofs[0].materializationId);

    // The first write carries the materialized truth and the proof; the row is dedicated.
    const row = findWorkspaceInConfig(config, taskId);
    expect(row).toMatchObject({
      path: forkPath,
      runtimeConfig: { type: "worktree" },
      taskCheckoutPreparation: {
        v: 1,
        path: forkPath,
        materializationId: atPublish.proofs[0].materializationId,
      },
    });
    expect(row?.taskIsolation).toBeUndefined();
    expect(row?.taskBaseCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await validateTaskCheckoutPreparation(config, taskId)).toMatchObject({ kind: "ready" });

    // The launch runs in the prepared directory: no second fork, no launch-time prune.
    await waitUntil(
      () =>
        sends.includes(taskId) && findWorkspaceInConfig(config, taskId)?.taskStatus === "running",
      "the reserved launch's send"
    );
    expect(sanitizeSpy).not.toHaveBeenCalled();
    const worktrees = (await fsPromises.readdir(path.join(config.srcDir, "repo"))).sort();
    expect(worktrees).toEqual([`agent_explore_${taskId}`, "parent"]);
    expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
      path: forkPath,
      taskCheckoutPreparation: atPublish.proofs[0],
    });
    expect(findWorkspaceInConfig(config, taskId)?.taskIsolation).toBeUndefined();
  }, 30_000);

  test("a refused preparation publishes nothing: the claimed fork is retained, named, and refuses later adoption", async () => {
    const taskId = "preprefused1";
    // Duplicate `enabledServers` properties: the strict pruner refuses to edit the document.
    const projectPath = await createRepoWithTrackedEnable(
      `{"enabledServers": ["${STALE_PLUGIN_KEY}"], "enabledServers": []}`
    );
    const { config, taskService, sends } = await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const forkPath = forkPathFor(config.srcDir, taskId);

    const created = await taskService.createMany([createArgs("Refused")]);
    expect(created.success).toBe(false);
    if (created.success) throw new Error("unreachable");
    expect(created.error).toContain("could not be sanitized");
    expect(created.error).toContain(`retained, not registered: ${forkPath}`);
    expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
    expect(sends).toEqual([]);
    // Retained verbatim (never pruned), claimed: a later claim of this directory refuses.
    expect(await fsPromises.readFile(path.join(forkPath, OVERRIDES_RELATIVE_PATH), "utf-8")).toBe(
      `{"enabledServers": ["${STALE_PLUGIN_KEY}"], "enabledServers": []}`
    );
    expect(
      await claimTaskCheckoutIdentity({ workspacePath: forkPath }, newMaterializationId())
    ).toBeInstanceOf(Error);
  }, 30_000);

  test("the launch gate refuses without forking: a legacy dedicated row, a proven row whose directory vanished, and a shared row whose parent checkout is gone (its shared flag kept)", async () => {
    const legacyId = "preplegacy01";
    const vanishedId = "prepvanish01";
    const sharedId = "prepshared01";
    const goneParentId = "prepgoneparent";
    const projectPath = await createRepoWithTrackedEnable();
    const srcDir = history.config.srcDir;
    const worktree: RuntimeConfig = { type: "worktree", srcBaseDir: srcDir };
    // A real, proven dedicated checkout that disappears before its launch.
    const vanishedPath = forkPathFor(srcDir, vanishedId);
    git(projectPath, `worktree add -q -b ${vanishedId} "${vanishedPath}" main`);
    const materializationId = newMaterializationId();
    const claimed = await claimTaskCheckoutIdentity(
      { workspacePath: vanishedPath },
      materializationId
    );
    if (claimed instanceof Error) throw claimed;
    const bound = await bindTaskCheckoutIdentity(
      { workspacePath: vanishedPath },
      materializationId,
      claimed
    );
    if (bound instanceof Error) throw bound;
    const vanishedProof = buildTaskCheckoutPreparation(bound, worktree);
    git(projectPath, `worktree remove --force "${vanishedPath}"`);
    const goneParentPath = path.join(srcDir, "repo", "gone-parent");
    const queued = (
      id: string,
      extra: Partial<WorkspaceConfigEntry> & Pick<WorkspaceConfigEntry, "path">
    ): WorkspaceConfigEntry => ({
      id,
      name: `agent_explore_${id}`,
      createdAt: new Date().toISOString(),
      runtimeConfig: worktree,
      parentWorkspaceId: rootId,
      agentId: "explore",
      agentType: "explore",
      taskStatus: "queued",
      taskPrompt: "go",
      taskModelString: "openai:gpt-5.2",
      ...extra,
    });
    const { config, taskService, sends } = await createRealStack(projectPath, [
      {
        path: goneParentPath,
        id: goneParentId,
        name: "gone-parent",
        createdAt: new Date().toISOString(),
        runtimeConfig: worktree,
      },
      queued(legacyId, { path: forkPathFor(srcDir, legacyId) }),
      queued(vanishedId, { path: vanishedPath, taskCheckoutPreparation: vanishedProof }),
      queued(sharedId, {
        path: goneParentPath,
        parentWorkspaceId: goneParentId,
        taskIsolation: "none",
      }),
    ]);

    await taskService.maybeStartQueuedTasks();
    const ids = [legacyId, vanishedId, sharedId];
    await waitUntil(
      () => ids.every((id) => findWorkspaceInConfig(config, id)?.taskStatus === "interrupted"),
      "every gated launch to be refused"
    );
    expect(findWorkspaceInConfig(config, legacyId)?.taskLaunchError).toContain("(PREP_LEGACY)");
    expect(findWorkspaceInConfig(config, vanishedId)?.taskLaunchError).toContain("(PREP_MISSING)");
    expect(findWorkspaceInConfig(config, sharedId)).toMatchObject({
      taskIsolation: "none",
      path: goneParentPath,
    });
    expect(findWorkspaceInConfig(config, sharedId)?.taskLaunchError).toContain(
      "(PREP_SHARED_BROKEN)"
    );
    // Nothing was forked, nothing sent; the retained rows are untouched otherwise.
    expect(sends).toEqual([]);
    expect(await pathExists(forkPathFor(srcDir, legacyId))).toBe(false);
    expect(await pathExists(vanishedPath)).toBe(false);
    expect(await pathExists(goneParentPath)).toBe(false);
    expect(findWorkspaceInConfig(config, vanishedId)?.taskCheckoutPreparation).toEqual(
      vanishedProof
    );
  }, 30_000);

  // Integration with main #4387 (MaterializedTaskLaunch.reusedExistingCheckout): the launch's
  // "a shared task must reuse its published checkout" check is a boolean, so prove identity by
  // behavior. The row is persisted at a STALE path of an existing directory (what a pre-#4387
  // build could leave behind); Config normalization re-derives it to the owner's live checkout,
  // and the launch must be authorized against, and run in, that checkout, never the stale one.
  test("a shared task persisted at a stale path launches authorized against, and running in, its owner's live checkout (no fork)", async () => {
    const sharedId = "prepsharedlive";
    const projectPath = await createRepoWithTrackedEnable();
    const srcDir = history.config.srcDir;
    const worktree: RuntimeConfig = { type: "worktree", srcBaseDir: srcDir };
    const stalePath = path.join(srcDir, "repo", "stale-parent");
    await fsPromises.mkdir(stalePath, { recursive: true });
    const { config, taskService, workspaceService, parentPath, sends } = await createRealStack(
      projectPath,
      [
        {
          id: sharedId,
          name: `agent_explore_${sharedId}`,
          // Save-time normalization (#4387) re-derives this to the owner's checkout.
          path: stalePath,
          createdAt: new Date().toISOString(),
          runtimeConfig: worktree,
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "go",
          taskModelString: "openai:gpt-5.2",
          taskIsolation: "none",
        },
      ]
    );
    // Rewrite the persisted row as an older build would have left it (the save path itself
    // normalizes, so write the file directly).
    const configFile = path.join(config.rootDir, "config.json");
    const raw = JSON.parse(await fsPromises.readFile(configFile, "utf-8")) as {
      projects: Array<[string, { workspaces: Array<{ id?: string; path: string }> }]>;
    };
    const persisted = raw.projects
      .flatMap(([, project]) => project.workspaces)
      .find((row) => row.id === sharedId);
    if (persisted == null) throw new Error("shared row missing from config.json");
    persisted.path = stalePath;
    await fsPromises.writeFile(configFile, JSON.stringify(raw), "utf-8");
    expect(findWorkspaceInConfig(config, sharedId)?.path).toBe(parentPath);
    // The load re-read the stale file and persists its repair (asynchronously, via the edit
    // queue).
    await waitUntil(async () => {
      const onDisk = JSON.parse(await fsPromises.readFile(configFile, "utf-8")) as typeof raw;
      return (
        onDisk.projects
          .flatMap(([, project]) => project.workspaces)
          .find((row) => row.id === sharedId)?.path === parentPath
      );
    }, "the load-time repair of the stale shared path");

    const preflights: Array<Awaited<ReturnType<TaskService["preflightTaskWorkspacePreparation"]>>> =
      [];
    const realPreflight = taskService.preflightTaskWorkspacePreparation.bind(taskService);
    const preflightSpy = spyOn(taskService, "preflightTaskWorkspacePreparation").mockImplementation(
      async (workspaceId) => {
        const result = await realPreflight(workspaceId);
        if (workspaceId === sharedId) preflights.push(result);
        return result;
      }
    );
    restores.push(() => preflightSpy.mockRestore());
    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    restores.push(() => forkSpy.mockRestore());

    await taskService.maybeStartQueuedTasks();
    await waitUntil(
      () =>
        sends.includes(sharedId) &&
        findWorkspaceInConfig(config, sharedId)?.taskStatus === "running",
      "the shared launch's send"
    );

    // Authorized against the owner's live checkout.
    expect(preflights.length).toBeGreaterThan(0);
    for (const preflight of preflights) {
      expect(preflight).toMatchObject({
        success: true,
        data: {
          kind: "authority",
          authority: { kind: "shared", anchorWorkspaceId: rootId, anchorPath: parentPath },
        },
      });
    }
    // Runs there: the row and the metadata the session executes in name the owner's checkout.
    expect(findWorkspaceInConfig(config, sharedId)).toMatchObject({
      path: parentPath,
      taskIsolation: "none",
    });
    expect((await config.getWorkspaceMetadataById(sharedId))?.namedWorkspacePath).toBe(parentPath);
    expect(await workspaceService.getInfo(sharedId)).toMatchObject({
      namedWorkspacePath: parentPath,
    });
    // Nothing forked; the stale directory is neither used nor removed.
    expect(forkSpy).not.toHaveBeenCalled();
    expect((await fsPromises.readdir(path.join(srcDir, "repo"))).sort()).toEqual([
      "parent",
      "stale-parent",
    ]);
  }, 30_000);

  test("Task.create publishes the proof of a directly created dedicated fork in its first write", async () => {
    const taskId = "prepdirect01";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, sends } = await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const forkPath = forkPathFor(config.srcDir, taskId);
    const created = await taskService.create(createArgs("Direct"));
    expect(created).toMatchObject({ success: true, data: { taskId } });
    expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
      path: forkPath,
      taskStatus: "running",
      taskCheckoutPreparation: { v: 1, path: forkPath },
    });
    expect(await validateTaskCheckoutPreparation(config, taskId)).toMatchObject({ kind: "ready" });
    expect(sends).toEqual([taskId]);
  }, 30_000);

  // editConfig logs and swallows a failed save (saveConfigEffect), so a publish that returned
  // proves nothing reached disk: reporting the task created would checkpoint an id whose launch
  // cannot find its row and leak the prepared checkout.
  test.each([
    ["reserved", "prepunsaved01"],
    ["unqueued", "prepunsaved02"],
    ["queued", "prepunsaved03"],
  ] as const)(
    "a %s publication whose config save was swallowed is refused: no row, the fork retained and named, nothing sent, no owned attempt left open, the registration lock free",
    async (mode, taskId) => {
      const projectPath = await createRepoWithTrackedEnable();
      const { config, taskService, sends } = await createRealStack(projectPath);
      stubStableIds(config, [taskId]);
      if (mode === "queued") {
        await config.editConfig((cfg) => ({ ...cfg, taskSettings: testTaskSettings(1) }));
        const busy = spyOn(taskService, "countActiveAgentTasks").mockReturnValue(1);
        restores.push(() => busy.mockRestore());
      }
      const forkPath = forkPathFor(config.srcDir, taskId);
      // Drop every save that would register the task, as a swallowed write failure leaves disk.
      const facade = config as unknown as { saveConfig: (next: ProjectsConfig) => Promise<void> };
      const realSave = facade.saveConfig.bind(config);
      const save = spyOn(facade, "saveConfig").mockImplementation((next) =>
        [...next.projects.values()].some((project) =>
          project.workspaces.some((row) => row.id === taskId)
        )
          ? Promise.resolve()
          : realSave(next)
      );
      restores.push(() => save.mockRestore());

      const created =
        mode === "reserved"
          ? await taskService.createMany([createArgs("Unsaved")])
          : await taskService.create(createArgs("Unsaved"));
      expect(created.success).toBe(false);
      if (created.success) throw new Error("unreachable");
      expect(created.error).toContain("did not persist");
      expect(created.error).toContain(forkPath);
      expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
      expect(await pathExists(path.join(forkPath, ".git"))).toBe(true);
      await settle();
      expect(sends).toEqual([]);
      const internals = taskService as unknown as {
        ownedAttemptByTaskId: Map<string, unknown>;
        attemptSettlementByTaskId: Map<string, { phase: string }>;
        workspaceStopRecords: Map<string, unknown>;
        admittedSendsByTaskId: Map<string, Set<unknown>>;
      };
      // A queued row is never admitted here, so nothing was owned; otherwise the owned attempt
      // is settled, not left for a Stop or reawaken to meet without settlement evidence.
      if (mode === "queued") expect(internals.ownedAttemptByTaskId.has(taskId)).toBe(false);
      else expect(internals.attemptSettlementByTaskId.get(taskId)?.phase).toBe("settled");
      expect(internals.workspaceStopRecords.has(taskId)).toBe(false);
      expect(internals.admittedSendsByTaskId.get(taskId)?.size ?? 0).toBe(0);
      const release = await crossProcessLock.acquireCrossProcessLock({
        lockPath: path.join(config.rootDir, "workspace-registration.lock"),
        acquireTimeoutMs: 100,
        staleMs: 60_000,
        timeoutMessage: "registration lock held",
      });
      await release();
    },
    30_000
  );

  // An unreadable registry proves nothing either way: the write may well have landed, and a
  // reported failure would then leave a durable (possibly launchable) row the caller cannot
  // fence and may duplicate on retry. Only a READABLE registry lacking the proof refuses.
  test.each([
    ["reserved", "prepunread01"],
    ["unqueued", "prepunread02"],
    ["queued", "prepunread03"],
  ] as const)(
    "a %s publication whose verification read fails transiently keeps its success: the persisted row stays the task",
    async (mode, taskId) => {
      const projectPath = await createRepoWithTrackedEnable();
      const { config, taskService, workspaceService } = await createRealStack(projectPath);
      stubStableIds(config, [taskId]);
      if (mode === "queued") {
        await config.editConfig((cfg) => ({ ...cfg, taskSettings: testTaskSettings(1) }));
        const busy = spyOn(taskService, "countActiveAgentTasks").mockReturnValue(1);
        restores.push(() => busy.mockRestore());
      }
      // Armed the moment `publish` returns: the next strict read is the verification's.
      let armed = false;
      let verificationReadFailed = false;
      const realLoad = config.loadConfigOrDefault.bind(config);
      const load = spyOn(config, "loadConfigOrDefault").mockImplementation(((
        options?: Parameters<Config["loadConfigOrDefault"]>[0]
      ) => {
        if (armed && options?.throwOnError === true) {
          armed = false;
          verificationReadFailed = true;
          throw new Error("transient config read failure");
        }
        return realLoad(options);
      }) as Config["loadConfigOrDefault"]);
      const realPrepare = workspaceService.prepareTaskCheckouts.bind(workspaceService);
      const prepare = spyOn(workspaceService, "prepareTaskCheckouts").mockImplementation(
        (materialize, publish) =>
          realPrepare(materialize, async (proofs) => {
            const value = await publish(proofs);
            armed = true;
            return value;
          })
      );
      restores.push(
        () => load.mockRestore(),
        () => prepare.mockRestore()
      );

      const created =
        mode === "reserved"
          ? await taskService.createMany([createArgs("Unread")])
          : await taskService.create(createArgs("Unread"));
      expect(verificationReadFailed).toBe(true);
      expect(created.success).toBe(true);
      const row = findWorkspaceInConfig(config, taskId);
      expect(row).toMatchObject({
        taskCheckoutPreparation: { v: 1, path: forkPathFor(config.srcDir, taskId) },
      });
      if (mode === "queued") expect(row?.taskStatus).toBe("queued");
    },
    30_000
  );

  // HOLDER RULE (see acquireRegistrationSanitizeLock): a failed registration-lock release never
  // changes the outcome of the transaction it closed. A refusal turned into a throw would delete
  // the checkout retained on purpose; a committed publication turned into a failure would fence
  // rows whose ids a workflow already checkpointed.
  function failRegistrationLockRelease(): () => number {
    const realAcquire = crossProcessLock.acquireCrossProcessLock;
    let failedReleases = 0;
    const acquire = spyOn(crossProcessLock, "acquireCrossProcessLock").mockImplementation(
      async (options) => {
        const release = await realAcquire(options);
        if (path.basename(options.lockPath) !== "workspace-registration.lock") return release;
        return async () => {
          await release();
          failedReleases++;
          throw new Error("EIO: registration lock release failed");
        };
      }
    );
    restores.push(() => acquire.mockRestore());
    return () => failedReleases;
  }

  test("a refused direct preparation keeps its refusal when the lock release fails: the claimed fork is retained and named, not rolled back", async () => {
    const taskId = "preprelease01";
    const projectPath = await createRepoWithTrackedEnable(
      `{"enabledServers": ["${STALE_PLUGIN_KEY}"], "enabledServers": []}`
    );
    const { config, taskService, sends } = await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const forkPath = forkPathFor(config.srcDir, taskId);
    const failedReleases = failRegistrationLockRelease();

    const created = await taskService.create(createArgs("Refused"));
    expect(failedReleases()).toBeGreaterThan(0);
    expect(created.success).toBe(false);
    if (created.success) throw new Error("unreachable");
    expect(created.error).toContain("could not be sanitized");
    expect(created.error).toContain(forkPath);
    expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
    expect(sends).toEqual([]);
    // Retained verbatim (never pruned, never deleted by a rollback).
    expect(await fsPromises.readFile(path.join(forkPath, OVERRIDES_RELATIVE_PATH), "utf-8")).toBe(
      `{"enabledServers": ["${STALE_PLUGIN_KEY}"], "enabledServers": []}`
    );
  }, 30_000);

  test.each([
    ["reserved", "preprelease02"],
    ["direct", "preprelease03"],
  ] as const)(
    "a %s publication keeps its success when the lock release fails: the row is the task and it launches",
    async (mode, taskId) => {
      const projectPath = await createRepoWithTrackedEnable();
      const { config, taskService, sends } = await createRealStack(projectPath);
      stubStableIds(config, [taskId]);
      const failedReleases = failRegistrationLockRelease();

      const created =
        mode === "reserved"
          ? await taskService.createMany([createArgs("Released")])
          : await taskService.create(createArgs("Released"));
      expect(failedReleases()).toBeGreaterThan(0);
      expect(created.success).toBe(true);
      await waitUntil(
        () =>
          sends.includes(taskId) && findWorkspaceInConfig(config, taskId)?.taskStatus === "running",
        "the task's launch send"
      );
      expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
        path: forkPathFor(config.srcDir, taskId),
        taskCheckoutPreparation: { path: forkPathFor(config.srcDir, taskId) },
      });
      expect(findWorkspaceInConfig(config, taskId)?.taskLaunchError).toBeUndefined();
    },
    30_000
  );

  const secondaryForkPathFor = (srcDir: string, taskId: string) =>
    path.join(srcDir, "repo2", `agent_explore_${taskId}`);

  test("a multi-project parent's dedicated tasks (reserved batch and Task.create) publish proof v2 binding every project's checkout; both validate ready and launch", async () => {
    const reservedId = "prepmulti01";
    const directId = "prepmulti02";
    const projectPath = await createRepoWithTrackedEnable();
    const secondaryProjectPath = await createTestProject(rootDir, "repo2");
    const { config, taskService, sends } = await createRealStack(projectPath, [], {
      secondaryProjectPath,
    });
    stubStableIds(config, [reservedId, directId]);
    const expectProofV2 = async (taskId: string) => {
      const forkPath = forkPathFor(config.srcDir, taskId);
      const secondaryPath = secondaryForkPathFor(config.srcDir, taskId);
      const row = findWorkspaceInConfig(config, taskId);
      expect(row).toMatchObject({
        path: forkPath,
        projects: [{ projectPath }, { projectPath: secondaryProjectPath }],
        taskCheckoutPreparation: {
          v: 2,
          path: forkPath,
          secondaries: [{ projectPath: secondaryProjectPath, path: secondaryPath }],
        },
      });
      // The proof binds the exact project list the row publishes (paths and names, in order).
      expect((row?.taskCheckoutPreparation as { projects?: unknown }).projects).toEqual(
        row?.projects
      );
      expect(row?.projects).toHaveLength(2);
      const proof = row?.taskCheckoutPreparation as TaskCheckoutPreparation;
      if (proof.v !== 2) throw new Error("unreachable");
      // The generation's nonce is claimed in the secondary's OWN git admin dir too.
      const [secondary] = proof.secondaries;
      expect(secondary.gitdir.pointer).toBe(
        await fsPromises.realpath(
          path.join(secondaryProjectPath, ".git", "worktrees", `agent_explore_${taskId}`)
        )
      );
      expect(
        (
          await fsPromises.readFile(
            path.join(secondary.gitdir.pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE),
            "utf-8"
          )
        ).trim()
      ).toBe(proof.materializationId);
      expect(await validateTaskCheckoutPreparation(config, taskId)).toMatchObject({
        kind: "ready",
      });
    };

    // Success also means the producer's persistence check found each v2 proof, JSON round
    // tripped through the config file, deep-equal to the one it built.
    expect(await taskService.createMany([createArgs("Reserved multi")])).toMatchObject({
      success: true,
    });
    await expectProofV2(reservedId);
    await waitUntil(() => sends.includes(reservedId), "the reserved multi-project launch's send");
    expect(await taskService.create(createArgs("Direct multi"))).toMatchObject({
      success: true,
      data: { taskId: directId },
    });
    await expectProofV2(directId);
    expect(sends).toContain(directId);
  }, 30_000);

  test("a refused secondary claim refuses the whole preparation: nothing is published, and every checkout is retained and named", async () => {
    const taskId = "prepmulti03";
    const projectPath = await createRepoWithTrackedEnable();
    const secondaryProjectPath = await createTestProject(rootDir, "repo2");
    const { config, taskService, sends } = await createRealStack(projectPath, [], {
      secondaryProjectPath,
    });
    stubStableIds(config, [taskId]);
    // Another generation's claim already sits in the SECONDARY's admin dir when preparation
    // claims it (the primary is clean).
    const realFork = forkOrchestrator.orchestrateFork;
    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(
      async (params) => {
        const result = await realFork(params);
        await fsPromises.writeFile(
          path.join(
            secondaryProjectPath,
            ".git",
            "worktrees",
            `agent_explore_${taskId}`,
            TASK_CHECKOUT_PREPARATION_NONCE_FILE
          ),
          "mat_0123456789abcdef\n"
        );
        return result;
      }
    );
    restores.push(() => forkSpy.mockRestore());

    const created = await taskService.create(createArgs("Refused multi"));
    expect(created.success).toBe(false);
    if (created.success) throw new Error("unreachable");
    const forkPath = forkPathFor(config.srcDir, taskId);
    const secondaryPath = secondaryForkPathFor(config.srcDir, taskId);
    expect(created.error).toContain(secondaryPath);
    expect(created.error).toContain(forkPath);
    expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
    expect(await pathExists(forkPath)).toBe(true);
    expect(await pathExists(secondaryPath)).toBe(true);
    expect(sends).toEqual([]);
  }, 30_000);

  // The producer's own refusals after binding (the pre-publication recheck, the persistence
  // check) must name every checkout of a multi-project task: the unqueued Task.create returns a
  // failed persistence check verbatim (an attempted write), with no retained-checkout notice.
  test.each(["changed after bind", "save swallowed"] as const)(
    "a multi-project preparation refused after binding (%s) names every checkout; nothing is registered",
    async (mode) => {
      const taskId = mode === "changed after bind" ? "prepmulti04" : "prepmulti05";
      const projectPath = await createRepoWithTrackedEnable();
      const secondaryProjectPath = await createTestProject(rootDir, "repo2");
      const { config, taskService, overridesService, sends } = await createRealStack(
        projectPath,
        [],
        { secondaryProjectPath }
      );
      stubStableIds(config, [taskId]);
      const forkPath = forkPathFor(config.srcDir, taskId);
      const secondaryPath = secondaryForkPathFor(config.srcDir, taskId);
      if (mode === "changed after bind") {
        // A non-cooperating writer edits the SECONDARY's claim once every checkout is bound.
        const realPrune =
          overridesService.prunePluginOverrideKeysForUnregisteredCheckout.bind(overridesService);
        const pruneSpy = spyOn(
          overridesService,
          "prunePluginOverrideKeysForUnregisteredCheckout"
        ).mockImplementation((target, keyPrefix, options) =>
          realPrune(target, keyPrefix, {
            ...options,
            afterPruneUnderLock: async () => {
              await options?.afterPruneUnderLock?.();
              await fsPromises.writeFile(
                path.join(
                  secondaryProjectPath,
                  ".git",
                  "worktrees",
                  `agent_explore_${taskId}`,
                  TASK_CHECKOUT_PREPARATION_NONCE_FILE
                ),
                "mat_ffffffffffffffff\n"
              );
            },
          })
        );
        restores.push(() => pruneSpy.mockRestore());
      } else {
        const facade = config as unknown as {
          saveConfig: (next: ProjectsConfig) => Promise<void>;
        };
        const realSave = facade.saveConfig.bind(config);
        const save = spyOn(facade, "saveConfig").mockImplementation((next) =>
          [...next.projects.values()].some((project) =>
            project.workspaces.some((row) => row.id === taskId)
          )
            ? Promise.resolve()
            : realSave(next)
        );
        restores.push(() => save.mockRestore());
      }

      const created = await taskService.create(createArgs("Refused after bind"));
      expect(created.success).toBe(false);
      if (created.success) throw new Error("unreachable");
      expect(created.error).toContain(
        mode === "changed after bind" ? `nonce of ${secondaryPath}` : "did not persist"
      );
      expect(created.error).toContain(secondaryPath);
      expect(created.error).toContain(forkPath);
      expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
      expect(await pathExists(forkPath)).toBe(true);
      expect(await pathExists(secondaryPath)).toBe(true);
      await settle();
      expect(sends).toEqual([]);
    },
    30_000
  );
});
