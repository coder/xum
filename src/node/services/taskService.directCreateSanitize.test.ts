import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import * as path from "path";

import { Config, SecretsStore } from "@/node/config";
import { Ok } from "@/common/types/result";
import type { RuntimeConfig } from "@/common/types/runtime";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { InitStateManager } from "@/node/services/initStateManager";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import { TaskService } from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createTestProject,
  findWorkspaceInConfig,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

/**
 * Direct (unqueued) task creation must sanitize a fresh host-local checkout BEFORE the
 * task record is published: a record published first is discoverable and admittable by
 * every ordinary reader (older builds included) while its tracked `plugin:` enables are
 * still in place, and a failed sanitization then leaves that record — with its unsanitized
 * checkout — behind as a rescuable interrupted task.
 *
 * Real stack: Config + HistoryService + WorkspaceService + WorkspaceMcpOverridesService +
 * TaskService over a real git repository and real worktree forks; only the model send and
 * the background init hook are stubbed (no provider, no init process).
 */
const rootId = "directroot1";
/** Canonical `plugin:<16-hex>:<server>` key: the only shape registration sanitization prunes. */
const STALE_PLUGIN_KEY = "plugin:0123456789abcdef:evil";
const OVERRIDES_RELATIVE_PATH = path.join(".xum", "mcp.local.jsonc");
/** Test mirror of WorkspaceMcpOverridesService's private PUBLICATION_TIMEOUT_MS (the plugin-prune budget). */
const PRUNE_BUDGET_MIRROR_MS = 30_000;

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

describe("TaskService direct create: pre-publication sanitization of the forked checkout", () => {
  let history: Awaited<ReturnType<typeof createTestHistoryService>>;
  let rootDir: string;
  const restores: Array<() => void> = [];

  beforeEach(async () => {
    history = await createTestHistoryService();
    rootDir = history.tempDir;
    await fsPromises.mkdir(history.config.srcDir, { recursive: true });
    // Never run a real init hook: the fork target is a plain worktree.
    const initSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    restores.push(() => initSpy.mockRestore());
  });
  afterEach(async () => {
    for (const restore of restores.splice(0)) restore();
    await history.cleanup();
  });

  /**
   * A repository whose main branch TRACKS a workspace override enabling a plugin server:
   * every fresh worktree materializes the stale enable (project plugin instance IDs are
   * stable across a project's worktrees, so a committed enable activates in each fork).
   */
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

  async function createRealStack(projectPath: string) {
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
    // The parent is registered below the way WorkspaceService.create leaves a checkout:
    // registration-time sanitization already pruned ITS copy of the tracked enable (the
    // committed file still carries it, so every fork of the parent's branch materializes it).
    // Without this, a child's override read would inherit the key from the parent — the
    // parent's own consent context, not the child's stale copy under test.
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
    // The hosted send is the one seam stubbed here: no provider is available. The real
    // WorkspaceService disposes the launch's admission token at its seams; the stub does the
    // same so the launch's obligation is discharged and no stop latch is retained.
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

  test("while the checkout's sanitization is held, no ordinary reader can discover or admit the task, and the record published afterwards reads sanitized content", async () => {
    const taskId = "directbarrier1";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, workspaceService, overridesService } =
      await createRealStack(projectPath);
    stubStableIds(config, [taskId]);

    // Hold the global override write lock: the real sanitizer's prune queues behind it.
    const releaseHeld = await overridesService.acquireExclusiveLock();
    const exclusive = overridesService as unknown as {
      runExclusive: <T>(fn: () => Promise<T>, options?: unknown) => Promise<T>;
    };
    const realRunExclusive = exclusive.runExclusive.bind(overridesService);
    let sanitizerQueued = false;
    const runExclusiveSpy = spyOn(exclusive, "runExclusive").mockImplementation(
      <T>(fn: () => Promise<T>, options?: unknown) => {
        sanitizerQueued = true;
        return realRunExclusive(fn, options);
      }
    );
    restores.push(() => runExclusiveSpy.mockRestore());

    const creation = taskService.create(createArgs("Barrier"));
    try {
      await waitUntil(() => sanitizerQueued, "the sanitizer to queue behind the held lock");
      // The fork exists (the sanitizer targets it) ...
      const forkedPaths = (await fsPromises.readdir(path.join(config.srcDir, "repo"))).filter(
        (name) => name.startsWith("agent_explore_")
      );
      expect(forkedPaths).toHaveLength(1);
      const forkedPath = path.join(config.srcDir, "repo", forkedPaths[0]);
      expect(
        JSON.parse(
          await fsPromises.readFile(path.join(forkedPath, OVERRIDES_RELATIVE_PATH), "utf-8")
        )
      ).toEqual({ enabledServers: [STALE_PLUGIN_KEY] });
      // ... but no reader can see or admit the task while its checkout is unsanitized.
      expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
      expect((await config.getAllWorkspaceMetadata()).some((m) => m.id === taskId)).toBe(false);
      expect(await workspaceService.getInfo(taskId)).toBeNull();
      expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })).toEqual({
        kind: "not-a-task",
      });
    } finally {
      await releaseHeld();
    }
    const created = await creation;
    expect(created).toMatchObject({ success: true, data: { taskId, status: "running" } });
    const entry = findWorkspaceInConfig(config, taskId);
    expect(entry).toMatchObject({ taskStatus: "running" });
    // Published only after the prune: the record's checkout reads sanitized.
    expect(
      JSON.parse(
        await fsPromises.readFile(path.join(entry!.path, OVERRIDES_RELATIVE_PATH), "utf-8")
      )
    ).toEqual({ enabledServers: [] });
    const read = await overridesService.getOverridesForWorkspace(taskId, { timeoutMs: 5_000 });
    expect(read.authoritative).toBe(true);
    expect(read.overrides.enabledServers ?? []).not.toContain(STALE_PLUGIN_KEY);
  }, 30_000);

  /** The fork target of a task: `agent_<type>_<id>` under the project's worktree directory. */
  const forkPathFor = (srcDir: string, taskId: string) =>
    path.join(srcDir, "repo", `agent_explore_${taskId}`);

  const pathExists = (candidate: string) =>
    fsPromises
      .access(candidate)
      .then(() => true)
      .catch(() => false);

  test("a refused sanitization publishes no task record: the fresh worktree is retained, unregistered and named in the error; a later creation neither reuses nor removes it", async () => {
    const failedId = "directrefuse1";
    const retryId = "directrefuse2";
    // Duplicate `enabledServers` properties: the strict pruner refuses to edit the document
    // (last-wins parse vs first-wins edit could leave the key in place) and throws.
    const projectPath = await createRepoWithTrackedEnable(
      `{"enabledServers": ["${STALE_PLUGIN_KEY}"], "enabledServers": []}`
    );
    const { config, taskService, workspaceService, sends } = await createRealStack(projectPath);
    stubStableIds(config, [failedId, retryId]);
    const rollback = spyOn(
      taskService as unknown as { rollbackFailedTaskCreate: () => Promise<void> },
      "rollbackFailedTaskCreate"
    );
    restores.push(() => rollback.mockRestore());

    const failedPath = forkPathFor(config.srcDir, failedId);
    const refused = await taskService.create(createArgs("Refused"));
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("could not be sanitized");
    expect(refused.error).toContain(`created at ${failedPath} but not registered`);
    // Nothing published, nothing sent, nothing deleted.
    expect(findWorkspaceInConfig(config, failedId)).toBeUndefined();
    expect(await workspaceService.getInfo(failedId)).toBeNull();
    expect(taskService.admitTaskWorkspaceTurn(failedId, { acceptanceOrigin: "manual" })).toEqual({
      kind: "not-a-task",
    });
    expect(sends).toEqual([]);
    expect(rollback).not.toHaveBeenCalled();
    expect(await pathExists(path.join(failedPath, OVERRIDES_RELATIVE_PATH))).toBe(true);
    // The unsanitized document is left verbatim for inspection.
    expect(await fsPromises.readFile(path.join(failedPath, OVERRIDES_RELATIVE_PATH), "utf-8")).toBe(
      `{"enabledServers": ["${STALE_PLUGIN_KEY}"], "enabledServers": []}`
    );
    // Creation released its lock: the next creation proceeds and owns a DIFFERENT checkout.
    // Forks materialize the parent's committed state: repair the document on the parent's branch.
    const parentPath = path.join(config.srcDir, "repo", "parent");
    await fsPromises.writeFile(
      path.join(parentPath, OVERRIDES_RELATIVE_PATH),
      JSON.stringify({ enabledServers: [STALE_PLUGIN_KEY] }),
      "utf-8"
    );
    git(parentPath, 'commit -am "repair the tracked override"');
    const retried = await taskService.create(createArgs("Retry"));
    expect(retried).toMatchObject({ success: true, data: { taskId: retryId } });
    const retriedEntry = findWorkspaceInConfig(config, retryId);
    expect(retriedEntry?.path).toBe(forkPathFor(config.srcDir, retryId));
    expect(retriedEntry?.path).not.toBe(failedPath);
    expect(await pathExists(path.join(failedPath, OVERRIDES_RELATIVE_PATH))).toBe(true);
    expect(sends).toEqual([retryId]);
  }, 30_000);

  test("a registry that turns unreadable after the fork refuses strictly: nothing is pruned or published, the worktree is retained verbatim", async () => {
    const taskId = "directstrict01";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, sends } = await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const configPath = path.join(config.rootDir, "config.json");
    // Corrupt the registry the moment the fork exists: the pre-publication scan must not read
    // an unparseable store as "no live sibling" and prune (the lenient read yields an empty map).
    const realFork = forkOrchestrator.orchestrateFork;
    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(
      async (params) => {
        const result = await realFork(params);
        await fsPromises.writeFile(configPath, "{ not json", "utf-8");
        return result;
      }
    );
    restores.push(() => forkSpy.mockRestore());
    const forkPath = forkPathFor(config.srcDir, taskId);

    const refused = await taskService.create(createArgs("Strict"));
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("unreadable");
    expect(refused.error).toContain(`created at ${forkPath} but not registered`);
    expect(sends).toEqual([]);
    // Neither pruned nor published: the tracked enable is still in the retained worktree and the
    // registry bytes are exactly what the test wrote (no row appended, no repair).
    expect(
      JSON.parse(await fsPromises.readFile(path.join(forkPath, OVERRIDES_RELATIVE_PATH), "utf-8"))
    ).toEqual({ enabledServers: [STALE_PLUGIN_KEY] });
    expect(await fsPromises.readFile(configPath, "utf-8")).toBe("{ not json");
  }, 30_000);

  test("isolation: none shares the parent's checkout without any sanitization: the parent's consent survives and no lock is taken", async () => {
    const taskId = "directshared1";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, workspaceService, overridesService, parentPath } =
      await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    // Consent the parent saved for itself after its own registration.
    const consented = { enabledServers: ["plugin:fedcba9876543210:consented"] };
    await fsPromises.writeFile(
      path.join(parentPath, OVERRIDES_RELATIVE_PATH),
      JSON.stringify(consented),
      "utf-8"
    );
    const register = spyOn(workspaceService, "registerSanitizedTaskCheckout");
    const prune = spyOn(overridesService, "prunePluginOverrideKeysForUnregisteredCheckout");
    restores.push(
      () => register.mockRestore(),
      () => prune.mockRestore()
    );

    const created = await taskService.create({ ...createArgs("Shared"), isolation: "none" });
    expect(created).toMatchObject({ success: true, data: { taskId } });
    expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
      path: parentPath,
      taskIsolation: "none",
      taskStatus: "running",
    });
    expect(register).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(
      JSON.parse(await fsPromises.readFile(path.join(parentPath, OVERRIDES_RELATIVE_PATH), "utf-8"))
    ).toEqual(consented);
  }, 30_000);

  test("a project-dir (local runtime) parent shares its directory with the task: the live sibling is found and its consent is preserved", async () => {
    const taskId = "directlocal01";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService } = await createRealStack(projectPath);
    // Re-register the parent as a project-dir workspace ON the project directory itself; a
    // local-runtime fork resolves to that same directory (shared by design).
    const consented = { enabledServers: ["plugin:fedcba9876543210:consented"] };
    await fsPromises.writeFile(
      path.join(projectPath, OVERRIDES_RELATIVE_PATH),
      JSON.stringify(consented),
      "utf-8"
    );
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: rootId,
          name: "repo",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        },
      ],
      testTaskSettings()
    );
    stubStableIds(config, [taskId]);
    const before = await fsPromises.stat(path.join(projectPath, OVERRIDES_RELATIVE_PATH));

    const created = await taskService.create(createArgs("Local"));
    expect(created).toMatchObject({ success: true, data: { taskId } });
    expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
      path: projectPath,
      taskStatus: "running",
    });
    // Sibling found under the checkout locks: the document was never rewritten.
    const after = await fsPromises.stat(path.join(projectPath, OVERRIDES_RELATIVE_PATH));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(
      JSON.parse(
        await fsPromises.readFile(path.join(projectPath, OVERRIDES_RELATIVE_PATH), "utf-8")
      )
    ).toEqual(consented);
  }, 30_000);

  test.each(["before-the-scan", "after-the-prune"] as const)(
    "an older-style in-place registration of the same physical checkout through a symlinked spelling (%s): a live alias of the fresh fork refuses the creation with its consent intact; consent saved after the prune survives publication",
    async (when) => {
      const taskId = when === "before-the-scan" ? "directalias01" : "directalias02";
      const aliasId = "cli-alias-registration";
      const projectPath = await createRepoWithTrackedEnable();
      const { config, taskService, overridesService, sends } = await createRealStack(projectPath);
      stubStableIds(config, [taskId]);
      // A second spelling of the worktree directory tree: `<root>/src-alias` -> `<root>/src`.
      const srcAlias = path.join(rootDir, "src-alias");
      await fsPromises.symlink(config.srcDir, srcAlias);
      const aliasPath = path.join(srcAlias, "repo", `agent_explore_${taskId}`);
      const forkPath = forkPathFor(config.srcDir, taskId);
      const consented = "plugin:fedcba9876543210:consented";
      // Another process (its own Config + overrides service on the same root) registers the
      // checkout in place through the alias spelling — the shape `xum run` leaves behind — and
      // then saves plugin consent for it through the ordinary save path. A save replaces the
      // document's enable list: registered before the scan, the alias re-consents to the tracked
      // key as well; saved after the prune, the consent alone must survive publication.
      const aliasEnables = when === "before-the-scan" ? [STALE_PLUGIN_KEY, consented] : [consented];
      const otherConfig = new Config(config.rootDir);
      const otherOverrides = new WorkspaceMcpOverridesService(otherConfig);
      const registerAliasAndConsent = async () => {
        await otherConfig.editConfig((cfg) => {
          cfg.projects.set(aliasPath, {
            workspaces: [
              {
                path: aliasPath,
                id: aliasId,
                name: aliasPath,
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
              },
            ],
          });
          return cfg;
        });
        await otherOverrides.setOverridesForWorkspace(aliasId, { enabledServers: aliasEnables });
      };
      if (when === "before-the-scan") {
        // Injected the moment the fork exists, before the creation's sibling scan runs.
        const realFork = forkOrchestrator.orchestrateFork;
        const forkSpy = spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(
          async (params) => {
            const result = await realFork(params);
            await registerAliasAndConsent();
            return result;
          }
        );
        restores.push(() => forkSpy.mockRestore());
      } else {
        // Injected after the creation's prune, while it still holds the registration lock and
        // before it publishes: the consent must survive publication.
        const realPrune =
          overridesService.prunePluginOverrideKeysForUnregisteredCheckout.bind(overridesService);
        const pruneSpy = spyOn(
          overridesService,
          "prunePluginOverrideKeysForUnregisteredCheckout"
        ).mockImplementation(async (target, keyPrefix, options) => {
          await realPrune(target, keyPrefix, options);
          await registerAliasAndConsent();
        });
        restores.push(() => pruneSpy.mockRestore());
      }

      const created = await taskService.create(createArgs("Alias"));
      const document = JSON.parse(
        await fsPromises.readFile(path.join(forkPath, OVERRIDES_RELATIVE_PATH), "utf-8")
      ) as { enabledServers?: string[] };
      if (when === "before-the-scan") {
        // A live workspace already resolving to a FRESH dedicated fork is anomalous: a skipped
        // prune would prove nothing about the directory, so the preparation refuses. Nothing is
        // published or sent, the alias's document (tracked key included) is untouched, and the
        // fork is retained unregistered and named.
        expect(created.success).toBe(false);
        if (created.success) throw new Error("unreachable");
        expect(created.error).toContain("alias");
        expect(created.error).toContain(`created at ${forkPath} but not registered`);
        expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
        expect(sends).toEqual([]);
        expect(document.enabledServers).toEqual(aliasEnables);
      } else {
        expect(created).toMatchObject({ success: true, data: { taskId } });
        expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
          path: forkPath,
          taskStatus: "running",
          taskCheckoutPreparation: { v: 1, path: forkPath },
        });
        // A sibling arriving after the prune is never pruned again: its consent survives.
        expect(document.enabledServers).toEqual(aliasEnables);
      }
      // Both registrations read the same document.
      const viaAlias = await otherOverrides.getOverridesForWorkspace(aliasId, { timeoutMs: 5_000 });
      expect(viaAlias.overrides.enabledServers).toEqual(document.enabledServers);
      // The alias row was never touched by the creation.
      expect(findWorkspaceInConfig(config, aliasId)).toMatchObject({ path: aliasPath });
    },
    30_000
  );

  test("an alias registration that lands after the sibling scan but before the checkout lock is acquired is seen under the path lock: the creation refuses and the alias's consent is neither pruned nor published against", async () => {
    // The plan's scan-under-relevant-locks gate. A registration-lock snapshot alone provides
    // no exclusion against an older-CLI-style in-place registration (which never takes that
    // lock): it can register the same physical checkout through a symlinked spelling and save
    // legitimate plugin consent in the window between the creator's "no live sibling" verdict
    // and the creator's acquisition of the checkout lock. Interleaved deterministically at the
    // creator's own lock acquisition; the alias save takes and releases the SAME path lock first.
    const taskId = "directalias03";
    const aliasId = "cli-alias-late";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, overridesService, sends } = await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const srcAlias = path.join(rootDir, "src-alias");
    await fsPromises.symlink(config.srcDir, srcAlias);
    const aliasPath = path.join(srcAlias, "repo", `agent_explore_${taskId}`);
    const forkPath = forkPathFor(config.srcDir, taskId);
    const consented = "plugin:fedcba9876543210:consented";
    const otherConfig = new Config(config.rootDir);
    const otherOverrides = new WorkspaceMcpOverridesService(otherConfig);
    const lockAccess = overridesService as unknown as {
      acquireCheckoutLock: (key: string, timeoutMs?: number) => Promise<() => Promise<void>>;
    };
    const realAcquire = lockAccess.acquireCheckoutLock.bind(overridesService);
    let interleaved = false;
    const acquireSpy = spyOn(lockAccess, "acquireCheckoutLock").mockImplementation(
      async (key, timeoutMs) => {
        if (!interleaved) {
          interleaved = true;
          // The creator has scanned (no sibling) and is about to fence the path.
          await otherConfig.editConfig((cfg) => {
            cfg.projects.set(aliasPath, {
              workspaces: [
                {
                  path: aliasPath,
                  id: aliasId,
                  name: aliasPath,
                  createdAt: new Date().toISOString(),
                  runtimeConfig: { type: "local" },
                },
              ],
            });
            return cfg;
          });
          await otherOverrides.setOverridesForWorkspace(aliasId, { enabledServers: [consented] });
          savedAt = (await fsPromises.stat(path.join(forkPath, OVERRIDES_RELATIVE_PATH))).mtimeMs;
        }
        return realAcquire(key, timeoutMs);
      }
    );
    restores.push(() => acquireSpy.mockRestore());
    let savedAt: number | undefined;

    const created = await taskService.create(createArgs("Late alias"));
    expect(interleaved).toBe(true);
    // Seen under the path lock: the live alias refuses the preparation of a fresh fork. Nothing
    // is published, and the newly saved legitimate consent was never rewritten.
    expect(created.success).toBe(false);
    if (created.success) throw new Error("unreachable");
    expect(created.error).toContain("alias");
    expect(created.error).toContain(`created at ${forkPath} but not registered`);
    expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
    expect(sends).toEqual([]);
    const document = JSON.parse(
      await fsPromises.readFile(path.join(forkPath, OVERRIDES_RELATIVE_PATH), "utf-8")
    ) as { enabledServers?: string[] };
    expect(document.enabledServers).toEqual([consented]);
    expect(savedAt).toBeDefined();
    expect((await fsPromises.stat(path.join(forkPath, OVERRIDES_RELATIVE_PATH))).mtimeMs).toBe(
      savedAt ?? Number.NaN
    );
    const viaAlias = await otherOverrides.getOverridesForWorkspace(aliasId, { timeoutMs: 5_000 });
    expect(viaAlias.overrides.enabledServers).toEqual([consented]);
    expect(findWorkspaceInConfig(config, aliasId)).toMatchObject({ path: aliasPath });
  }, 30_000);

  test("a prune deadline that fires while the rewrite is in flight publishes nothing: the path lock stays held until the write lands, then the creation fails with the retained path", async () => {
    // No budget knob: the clock (still ticking) is shifted forward between the budget's
    // creation and the prune deadline's `remaining()` read, leaving ~2 s; the document write is
    // held open so the deadline provably fires with the rewrite in flight.
    const taskId = "directdeadline1";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, overridesService, sends } = await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const forkPath = forkPathFor(config.srcDir, taskId);
    const lockAccess = overridesService as unknown as {
      acquireCheckoutLock: (key: string, timeoutMs?: number) => Promise<() => Promise<void>>;
      pruneResolvedWorkspace: (
        resolved: unknown,
        keyPrefix: string,
        step: { readonly cancelled: boolean }
      ) => Promise<unknown>;
    };
    const lockKeys: string[] = [];
    const realAcquire = lockAccess.acquireCheckoutLock.bind(overridesService);
    const acquireSpy = spyOn(lockAccess, "acquireCheckoutLock").mockImplementation(
      (key, timeoutMs) => {
        lockKeys.push(key);
        return realAcquire(key, timeoutMs);
      }
    );
    const realNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
    const realPrune = lockAccess.pruneResolvedWorkspace.bind(overridesService);
    let step: { readonly cancelled: boolean } | undefined;
    const pruneSpy = spyOn(lockAccess, "pruneResolvedWorkspace").mockImplementation(
      (resolved, keyPrefix, s) => {
        step = s;
        clockOffsetMs = PRUNE_BUDGET_MIRROR_MS - 2_000;
        return realPrune(resolved, keyPrefix, s);
      }
    );
    const gate = Promise.withResolvers<void>();
    let writeStarted = false;
    let writeSettled = false;
    // A leaked prototype spy from another file would be captured here as "the real writeFile"
    // and recurse (bun's spyOn returns the existing mock): fail loudly instead.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- membership probe, not a call
    expect("mockRestore" in LocalBaseRuntime.prototype.writeFile).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound via .call below
    const realWriteFile = LocalBaseRuntime.prototype.writeFile;
    const writeSpy = spyOn(LocalBaseRuntime.prototype, "writeFile").mockImplementation(function (
      this: LocalBaseRuntime,
      target: string,
      abortSignal?: AbortSignal
    ) {
      const real = realWriteFile.call(this, target, abortSignal).getWriter();
      return new WritableStream<Uint8Array>({
        write: (chunk) => {
          writeStarted = true;
          return real.write(chunk);
        },
        close: async () => {
          await gate.promise;
          await real.close();
          writeSettled = true;
        },
      });
    });
    restores.push(
      () => acquireSpy.mockRestore(),
      () => clock.mockRestore(),
      () => pruneSpy.mockRestore(),
      () => writeSpy.mockRestore()
    );
    try {
      let outcome: Awaited<ReturnType<typeof taskService.create>> | undefined;
      const creation = taskService.create(createArgs("Deadline")).then((result) => {
        outcome = result;
        return result;
      });
      const waitUntilMs = realNow() + 10_000;
      while (!(writeStarted && step?.cancelled)) {
        if (realNow() > waitUntilMs) {
          throw new Error(
            `expected the deadline to fire with the write in flight (writeStarted=${String(writeStarted)}, cancelled=${String(step?.cancelled)})`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Pending, unpublished, and the path lock is still held while the rewrite is in flight.
      expect(outcome).toBeUndefined();
      expect(writeSettled).toBe(false);
      expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
      expect(lockKeys.length).toBeGreaterThan(0);
      for (const key of lockKeys) {
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
        await expect(
          acquireCrossProcessLock({
            lockPath: path.join(config.rootDir, "mcp-overrides-locks", `${key}.lock`),
            acquireTimeoutMs: 200,
            staleMs: 60_000,
            timeoutMessage: "checkout lock still held",
          })
        ).rejects.toThrow("checkout lock still held");
      }
      gate.resolve();
      const result = await creation;
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("exceeded the plugin-prune budget");
      expect(result.error).toContain(`created at ${forkPath} but not registered`);
      expect(writeSettled).toBe(true);
      // The write joined before the locks released: the pruned text is on disk, and the lock is free.
      expect(
        JSON.parse(await fsPromises.readFile(path.join(forkPath, OVERRIDES_RELATIVE_PATH), "utf-8"))
      ).toEqual({ enabledServers: [] });
      for (const key of lockKeys) {
        const release = await acquireCrossProcessLock({
          lockPath: path.join(config.rootDir, "mcp-overrides-locks", `${key}.lock`),
          acquireTimeoutMs: 2_000,
          staleMs: 60_000,
          timeoutMessage: "checkout lock still held after settlement",
        });
        await release();
      }
      expect(findWorkspaceInConfig(config, taskId)).toBeUndefined();
      expect(sends).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  test("later legitimate consent survives Stop and manual resume: nothing re-sanitizes a published task", async () => {
    const taskId = "directresume1";
    const projectPath = await createRepoWithTrackedEnable();
    const { config, taskService, overridesService } = await createRealStack(projectPath);
    stubStableIds(config, [taskId]);
    const created = await taskService.create(createArgs("Resume"));
    expect(created).toMatchObject({ success: true, data: { taskId } });
    const consented = "plugin:fedcba9876543210:consented";
    await overridesService.setOverridesForWorkspace(taskId, { enabledServers: [consented] });

    expect(await taskService.terminateAllDescendantAgentTasks(rootId)).toEqual([taskId]);
    expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
    await waitUntil(
      () => taskService.markInterruptedTaskRunning(taskId),
      "the manual rescue to be admitted"
    );
    expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("running");
    const read = await overridesService.getOverridesForWorkspace(taskId, { timeoutMs: 5_000 });
    expect(read.authoritative).toBe(true);
    expect(read.overrides.enabledServers).toEqual([consented]);
  }, 30_000);

  test.each(["write-fails", "commits-then-throws", "commits-then-superseded"] as const)(
    "a config write that %s never deletes the checkout or a record of unknown ownership; only a row proven to be this launch's is marked interrupted",
    async (failure) => {
      const taskId = {
        "write-fails": "directcfg0001",
        "commits-then-throws": "directcfg0002",
        "commits-then-superseded": "directcfg0003",
      }[failure];
      const foreignAttempt = "att_00000000000000c7";
      const projectPath = await createRepoWithTrackedEnable();
      const { config, taskService, workspaceService, sends } = await createRealStack(projectPath);
      stubStableIds(config, [taskId]);
      const forkPath = forkPathFor(config.srcDir, taskId);
      const rollback = spyOn(
        taskService as unknown as { rollbackFailedTaskCreate: () => Promise<void> },
        "rollbackFailedTaskCreate"
      );
      restores.push(() => rollback.mockRestore());
      const realEdit = config.editConfig.bind(config);
      let sabotaged = false;
      const editSpy = spyOn(config, "editConfig").mockImplementation(async (mutator, options) => {
        // Only the task's own publication (the write that adds its row) is sabotaged, and only
        // after its mutator ran: a write that fails before the transform (a lock timeout) is
        // provably unwritten and keeps the ordinary rollback.
        let addsTask = false;
        await realEdit((cfg) => {
          const next = mutator(cfg);
          addsTask = [...next.projects.values()].some((p) =>
            p.workspaces.some((w) => w.id === taskId)
          );
          if (addsTask && failure === "write-fails") {
            // The save never happens.
            throw new Error("disk full");
          }
          return next;
        }, options);
        if (!addsTask || sabotaged) return;
        sabotaged = true;
        if (failure === "commits-then-superseded") {
          // Another backend re-admits the just-committed row under its own attempt.
          await realEdit((cfg) => {
            for (const project of cfg.projects.values()) {
              const ws = project.workspaces.find((w) => w.id === taskId);
              if (ws) ws.taskAttemptId = foreignAttempt;
            }
            return cfg;
          });
        }
        throw new Error("post-commit failure");
      });
      restores.push(() => editSpy.mockRestore());

      const created = await taskService.create(createArgs("Config"));
      expect(created.success).toBe(false);
      if (created.success) throw new Error("unreachable");
      expect(created.error).toContain(failure === "write-fails" ? "disk full" : "post-commit");
      expect(sends).toEqual([]);
      // Never a rollback (which removes the row, the checkout and the session directory) once
      // the write was attempted: the checkout stays, sanitized, whatever the row's fate.
      expect(rollback).not.toHaveBeenCalled();
      expect(
        JSON.parse(await fsPromises.readFile(path.join(forkPath, OVERRIDES_RELATIVE_PATH), "utf-8"))
      ).toEqual({ enabledServers: [] });
      const row = findWorkspaceInConfig(config, taskId);
      if (failure === "write-fails") {
        expect(row).toBeUndefined();
        expect(await workspaceService.getInfo(taskId)).toBeNull();
      } else if (failure === "commits-then-throws") {
        // Proven ours (attempt, path, runtime): ended as a published launch failure.
        expect(row).toMatchObject({
          taskStatus: "interrupted",
          taskLaunchError: expect.stringContaining("post-commit") as unknown,
          path: forkPath,
        });
      } else {
        // The successor's row: neither marked nor removed.
        expect(row).toMatchObject({
          taskStatus: "running",
          taskAttemptId: foreignAttempt,
          path: forkPath,
        });
        expect(row?.taskLaunchError).toBeUndefined();
      }
    },
    30_000
  );
});
