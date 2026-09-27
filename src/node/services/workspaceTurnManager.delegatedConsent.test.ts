import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { Config } from "@/node/config";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import {
  workspaceTurnOwnerLockPath,
  type WorkspaceTurnManager,
} from "@/node/services/workspaceTurnManager";
import {
  createWorkspaceTurnManagerHarness,
  finalizeWorkspaceTurnStreamEndForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import { createWorkspaceServiceForTest } from "@/node/services/workspaceService.testHarness";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  saveLocalParentWorkspace,
  stubStableIds,
  workspaceTurnSnapshot,
  workspaceTurnStreamEndEvent,
} from "@/node/services/taskService.testHarness";

const TARGET = "aaaaaaaaaa";

/** #4453. Each backend: real WorkspaceTurnManager + WorkspaceService on its own Config, one root. */
describe("delegated target default consent (#4453)", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-delegated-consent-"));
  });
  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  /** One backend on rootDir. `afterCreate` runs once the target's create() returned. */
  async function backend(
    options: { stableIds?: string[]; afterCreate?: () => Promise<void> } = {}
  ) {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, options.stableIds ?? ["handle", "turn", TARGET, "handle2", "turn2"]);
    const real = createWorkspaceServiceForTest({ config });
    const host = createWorkspaceServiceMocks({
      create: mock(async (...args: Parameters<WorkspaceHost["create"]>) => {
        const result = await real.create(...args);
        await options.afterCreate?.();
        return result;
      }),
      grantPendingDefaultUnrelatedWorkspaceConsent: mock((id: string) =>
        real.grantPendingDefaultUnrelatedWorkspaceConsent(id)
      ),
      clearPendingDefaultUnrelatedConsent: mock((id: string) =>
        real.clearPendingDefaultUnrelatedConsent(id)
      ),
      removeWhileTaskTreeLocked: mock((id: string, force?: boolean) =>
        real.removeWhileTaskTreeLocked(id, force)
      ),
    });
    const { aiService } = createAIServiceMocks(config);
    const { taskService: manager } = createWorkspaceTurnManagerHarness(config, {
      aiService,
      workspaceService: host.workspaceService,
    });
    return { config, real, manager, aiService };
  }

  async function setUp(options: Parameters<typeof backend>[0] = {}) {
    const a = await backend(options);
    const { parentId, projectPath } = await saveLocalParentWorkspace(a.config, rootDir);
    return { ...a, parentId, projectPath };
  }

  function targetRow(config: Config) {
    const row = findWorkspaceEntry(config.loadConfigOrDefault(), TARGET)?.workspace;
    expect(row).toBeDefined();
    const consent = getValidUnrelatedWorkspaceConsent(row?.unrelatedWorkspaceConsent);
    return { consent, pending: row?.unrelatedWorkspaceConsentPending };
  }

  const createTurn = (
    manager: WorkspaceTurnManager,
    parentId: string,
    workspace: { mode: "new"; disposable?: boolean } | { mode: "existing"; workspaceId: string },
    modelString?: string
  ) =>
    manager.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace,
      ...(modelString != null ? { modelString } : {}),
    });

  const start = async (...args: Parameters<typeof createTurn>) =>
    expect((await createTurn(...args)).success).toBe(true);

  /** The owner process died: its lock record names a token no live process holds. */
  async function markCreatorDead() {
    const lockPath = workspaceTurnOwnerLockPath(rootDir, "wst_handle");
    const lock = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as object;
    await fsPromises.writeFile(lockPath, JSON.stringify({ ...lock, token: "dead-owner" }));
  }

  const endTurn = (
    manager: WorkspaceTurnManager,
    parentId: string,
    handle = "handle",
    turn = "turn"
  ) =>
    finalizeWorkspaceTurnStreamEndForTest(manager, {
      ...workspaceTurnStreamEndEvent(parentId, `msg_${handle}`, "done", {
        taskHandleId: `wst_${handle}`,
        turnId: turn,
      }),
      workspaceId: TARGET,
    });

  const settleBy = {
    completed: (manager: WorkspaceTurnManager, parentId: string) => endTurn(manager, parentId),
    error: (manager: WorkspaceTurnManager) =>
      manager.finalizeWorkspaceTurnFromStreamError({
        type: "error",
        workspaceId: TARGET,
        messageId: "msg_1",
        error: "Provider failed",
        errorType: "authentication",
      }),
    interrupted: (manager: WorkspaceTurnManager, parentId: string) =>
      manager.interruptWorkspaceTurn(parentId, "wst_handle"),
  };

  for (const [outcome, settle] of Object.entries(settleBy)) {
    test(`unreachable while the creating turn runs, opted in once it ends (${outcome})`, async () => {
      const { config, manager, parentId } = await setUp();
      await start(manager, parentId, { mode: "new" });
      expect(targetRow(config)).toEqual({ consent: undefined, pending: true });

      await settle(manager, parentId);

      const after = targetRow(config);
      expect(after.consent).toBeDefined();
      expect(after.pending).toBeUndefined();
    });
  }

  test("a disposable target is never marked or opted in", async () => {
    const { config, manager, parentId } = await setUp();
    await start(manager, parentId, { mode: "new", disposable: true });
    expect(targetRow(config)).toEqual({ consent: undefined, pending: undefined });
    await endTurn(manager, parentId);
    expect(targetRow(config).consent).toBeUndefined();
  });

  for (const toggler of ["this backend", "another backend"] as const) {
    test(`a toggle during the creating turn wins (${toggler})`, async () => {
      const { config, real, manager, parentId } = await setUp();
      await start(manager, parentId, { mode: "new" });
      const toggling = toggler === "this backend" ? real : (await backend()).real;

      expect((await toggling.setUnrelatedWorkspaceConsent(TARGET, false)).success).toBe(true);
      await endTurn(manager, parentId);
      expect(targetRow(config)).toEqual({ consent: undefined, pending: undefined });
    });
  }

  test("an opt-in during the turn keeps its generation, and mode existing never re-grants", async () => {
    const { config, real, manager, parentId } = await setUp();
    await start(manager, parentId, { mode: "new" });
    await real.setUnrelatedWorkspaceConsent(TARGET, true);
    const minted = targetRow(config).consent;
    await endTurn(manager, parentId);
    expect(targetRow(config)).toEqual({ consent: minted, pending: undefined });

    await real.setUnrelatedWorkspaceConsent(TARGET, false);
    await start(manager, parentId, { mode: "existing", workspaceId: TARGET });
    await endTurn(manager, parentId, "handle2", "turn2");
    expect(targetRow(config)).toEqual({ consent: undefined, pending: undefined });
  });

  test("another backend's stale settlement of a dead creator clears, never grants", async () => {
    const { config, manager, parentId } = await setUp();
    await start(manager, parentId, { mode: "new" });
    await markCreatorDead();
    const b = await backend();

    expect(await b.manager.countActiveWorkspaceTurns()).toBe(0);

    expect(targetRow(config)).toEqual({ consent: undefined, pending: undefined });
  });

  const archive = (config: Config, workspaceId: string) =>
    config.editConfig((cfg) => {
      const row = findWorkspaceEntry(cfg, workspaceId)?.workspace;
      if (row) row.archivedAt = new Date().toISOString();
      return cfg;
    });
  const exitsBeforeRecord: Record<
    string,
    {
      afterCreate?: (a: Awaited<ReturnType<typeof setUp>>) => unknown;
      extra?: Partial<Parameters<WorkspaceTurnManager["createWorkspaceTurn"]>[0]>;
      error: string;
    }
  > = {
    "an invalid explicit model": { extra: { modelString: "::" }, error: "::" },
    "an AI-settings resolution that throws": {
      afterCreate: ({ aiService }) =>
        spyOn(aiService, "getProvidersConfig").mockImplementation(() => {
          throw new Error("providers unreadable");
        }),
      error: "providers unreadable",
    },
    "a reawaken snapshot for a new target": {
      extra: {
        agentTaskAi: {
          snapshot: {
            agentId: "exec",
            taskModelString: "anthropic:claude-opus-4-6",
            canonicalModel: "anthropic:claude-opus-4-6",
            thinkingLevel: "high",
            reasoningMode: "standard",
          },
          inputsKey: "inputs",
          contextKey: "context",
        },
      },
      error: TARGET,
    },
    "the target archived during creation": {
      afterCreate: ({ config }) => archive(config, TARGET),
      error: "target workspace was archived",
    },
    "the owner archived during creation": {
      afterCreate: ({ config, parentId }) => archive(config, parentId),
      error: "owner workspace was archived",
    },
  };
  // #4819: without a handle record nothing owns the target (a mode "existing" retry is
  // invalid_scope), so each exit removes it; #4453: and still releases the live-owner lock.
  for (const [exit, { afterCreate, extra, error }] of Object.entries(exitsBeforeRecord)) {
    test(`an exit before the handle record persists removes the target (${exit})`, async () => {
      const late: { a?: Awaited<ReturnType<typeof setUp>> } = {};
      const a = await setUp({ afterCreate: async () => void (await afterCreate?.(late.a!)) });
      late.a = a;
      const created = await a.manager
        .createWorkspaceTurn({
          ownerWorkspaceId: a.parentId,
          prompt: "Summarize",
          title: "Workspace turn",
          workspace: { mode: "new" },
          ...extra,
        })
        .catch((thrown: unknown) => ({ success: false as const, error: String(thrown) }));

      expect(created.success).toBe(false);
      expect(created.success ? "" : created.error).toContain(error);
      expect(findWorkspaceEntry(a.config.loadConfigOrDefault(), TARGET)).toBeNull();
      expect(findWorkspaceEntry(a.config.loadConfigOrDefault(), a.parentId)).not.toBeNull();
      // The local target shares the parent's directory; removal must leave it.
      expect(await fsPromises.stat(a.projectPath).then(() => true)).toBe(true);
      const lock = workspaceTurnOwnerLockPath(rootDir, "wst_handle");
      expect(await fsPromises.stat(lock).catch(() => null)).toBeNull();
    });
  }

  test("a failed grant write still settles the turn and leaves the target off", async () => {
    const { config, real, manager, parentId } = await setUp();
    await start(manager, parentId, { mode: "new" });
    // Only the grant's config write fails (#4444: editConfig rejects when the save fails).
    const grant = real.grantPendingDefaultUnrelatedWorkspaceConsent.bind(real);
    spyOn(real, "grantPendingDefaultUnrelatedWorkspaceConsent").mockImplementation((id) => {
      spyOn(config, "editConfig").mockRejectedValueOnce(new Error("EACCES: permission denied"));
      return grant(id);
    });

    await endTurn(manager, parentId);

    expect(await workspaceTurnSnapshot(manager, parentId)).toMatchObject({ status: "completed" });
    expect(targetRow(config)).toEqual({ consent: undefined, pending: true });

    // The next startup's resolver clears it (the lock was released with the settlement).
    await (await backend()).manager.clearOrphanedDelegatedConsentDefaults();
    expect(targetRow(config)).toEqual({ consent: undefined, pending: undefined });
  });

  test("the startup resolver ignores a caller-supplied handle tag with no lock or record", async () => {
    const { config, parentId } = await setUp();
    const tags = { "mux.taskHandleId": "wst_forged", "mux.taskOwnerWorkspaceId": parentId };
    await config.editConfig((cfg) => {
      const row = { path: rootDir, id: TARGET, name: "forged", tags };
      cfg.projects.set(rootDir, {
        workspaces: [{ ...row, unrelatedWorkspaceConsentPending: true }],
      });
      return cfg;
    });

    await (await backend()).manager.clearOrphanedDelegatedConsentDefaults();
    expect(targetRow(config).pending).toBe(true);
  });

  for (const creator of ["alive", "dead"] as const) {
    test(`the startup resolver clears a mark only when its creator is dead (${creator})`, async () => {
      const [created, paused] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const a = await setUp({ afterCreate: () => (created.resolve(), paused.promise) });
      const creating = createTurn(a.manager, a.parentId, { mode: "new" });
      await created.promise; // The row exists with its mark; the handle record does not yet.
      if (creator === "dead") await markCreatorDead();

      await a.manager.clearOrphanedDelegatedConsentDefaults();
      await (await backend()).manager.clearOrphanedDelegatedConsentDefaults();
      expect(targetRow(a.config).pending).toBe(creator === "alive" ? true : undefined);

      paused.resolve();
      expect((await creating).success).toBe(true);
      await endTurn(a.manager, a.parentId);
      expect(targetRow(a.config).consent === undefined).toBe(creator === "dead");
    });
  }
});
