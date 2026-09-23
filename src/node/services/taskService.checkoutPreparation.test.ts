import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import * as path from "path";

import type { ProjectsConfig } from "@/common/types/project";
import { SecretsStore, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Ok } from "@/common/types/result";
import type { RuntimeConfig } from "@/common/types/runtime";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { InitStateManager } from "@/node/services/initStateManager";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
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
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
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

  async function createRealStack(projectPath: string, extraRows: WorkspaceConfigEntry[] = []) {
    const { config, historyService } = history;
    const runtimeConfig: RuntimeConfig = { type: "worktree", srcBaseDir: config.srcDir };
    const parentRuntime = createRuntime(runtimeConfig, { projectPath });
    const parentName = "parent";
    const created = await parentRuntime.createWorkspace({
      projectPath,
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
    const parentPath = parentRuntime.getWorkspacePath(projectPath, parentName);
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
        },
        ...extraRows,
      ],
      testTaskSettings()
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
      const release = await acquireCrossProcessLock({
        lockPath: path.join(config.rootDir, "workspace-registration.lock"),
        acquireTimeoutMs: 100,
        staleMs: 60_000,
        timeoutMessage: "registration lock held",
      });
      await release();
    },
    30_000
  );
});
