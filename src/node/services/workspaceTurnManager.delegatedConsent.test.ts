import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import cjsFs from "fs";
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

/**
 * #4453: a delegated task(kind:"workspace") target gets default unrelated-messaging consent once,
 * when its creating turn settles in the creating process. Each backend is a real
 * WorkspaceTurnManager over a real WorkspaceService (create, grant, clear, toggle) on its own Config
 * for the same root; only the turn's stream is driven by hand.
 */
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
    });
    const { taskService: manager } = createWorkspaceTurnManagerHarness(config, {
      aiService: createAIServiceMocks(config).aiService,
      workspaceService: host.workspaceService,
    });
    return { config, real, manager };
  }

  async function setUp(options: Parameters<typeof backend>[0] = {}) {
    const a = await backend(options);
    const { parentId } = await saveLocalParentWorkspace(a.config, rootDir);
    return { ...a, parentId };
  }

  function targetRow(config: Config) {
    const row = findWorkspaceEntry(config.loadConfigOrDefault(), TARGET)?.workspace;
    return {
      exists: row != null,
      consent: getValidUnrelatedWorkspaceConsent(row?.unrelatedWorkspaceConsent),
      pending: row?.unrelatedWorkspaceConsentPending,
    };
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
      expect((await createTurn(manager, parentId, { mode: "new" })).success).toBe(true);
      expect(targetRow(config)).toEqual({ exists: true, consent: undefined, pending: true });

      await settle(manager, parentId);

      const after = targetRow(config);
      expect(after.consent).toBeDefined();
      expect(after.pending).toBeUndefined();
    });
  }

  test("a disposable target is never marked or opted in", async () => {
    const { config, manager, parentId } = await setUp();
    expect((await createTurn(manager, parentId, { mode: "new", disposable: true })).success).toBe(
      true
    );
    expect(targetRow(config)).toEqual({ exists: true, consent: undefined, pending: undefined });
    await endTurn(manager, parentId);
    expect(targetRow(config).consent).toBeUndefined();
  });

  for (const toggler of ["this backend", "another backend"] as const) {
    test(`a toggle during the creating turn wins (${toggler})`, async () => {
      const { config, real, manager, parentId } = await setUp();
      expect((await createTurn(manager, parentId, { mode: "new" })).success).toBe(true);
      const toggling =
        toggler === "this backend"
          ? real
          : createWorkspaceServiceForTest({ config: await createTestConfig(rootDir) });

      expect((await toggling.setUnrelatedWorkspaceConsent(TARGET, false)).success).toBe(true);
      await endTurn(manager, parentId);
      expect(targetRow(config)).toEqual({ exists: true, consent: undefined, pending: undefined });
    });
  }

  test("an opt-in during the turn keeps its generation, and mode existing never re-grants", async () => {
    const { config, real, manager, parentId } = await setUp();
    expect((await createTurn(manager, parentId, { mode: "new" })).success).toBe(true);
    await real.setUnrelatedWorkspaceConsent(TARGET, true);
    const minted = targetRow(config).consent;
    await endTurn(manager, parentId);
    expect(targetRow(config)).toEqual({ exists: true, consent: minted, pending: undefined });

    await real.setUnrelatedWorkspaceConsent(TARGET, false);
    expect(
      (await createTurn(manager, parentId, { mode: "existing", workspaceId: TARGET })).success
    ).toBe(true);
    await endTurn(manager, parentId, "handle2", "turn2");
    expect(targetRow(config)).toEqual({ exists: true, consent: undefined, pending: undefined });
  });

  test("another backend's stale settlement of a dead creator clears, never grants", async () => {
    const { config, manager, parentId } = await setUp();
    expect((await createTurn(manager, parentId, { mode: "new" })).success).toBe(true);
    const lockPath = workspaceTurnOwnerLockPath(rootDir, "wst_handle");
    const lock = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as object;
    await fsPromises.writeFile(lockPath, JSON.stringify({ ...lock, token: "dead-owner" }));
    const b = await backend();

    expect(await b.manager.countActiveWorkspaceTurns()).toBe(0);

    expect(targetRow(config)).toEqual({ exists: true, consent: undefined, pending: undefined });
  });

  const exitsBeforeRecord = {
    "an invalid explicit model": {
      afterCreate: undefined,
      modelString: "::",
    },
    "the target archived during creation": {
      afterCreate: (config: Config) =>
        config.editConfig((cfg) => {
          const row = findWorkspaceEntry(cfg, TARGET)?.workspace;
          if (row) row.archivedAt = new Date().toISOString();
          return cfg;
        }),
      modelString: undefined,
    },
  };
  for (const [exit, { afterCreate, modelString }] of Object.entries(exitsBeforeRecord)) {
    test(`an exit before the handle record persists clears the mark (${exit})`, async () => {
      let config: Config | undefined;
      const a = await setUp({ afterCreate: async () => void (await afterCreate?.(config!)) });
      config = a.config;
      const created = await createTurn(a.manager, a.parentId, { mode: "new" }, modelString);

      expect(created.success).toBe(false);
      expect(created.success ? "" : created.error).toContain(modelString ?? "archived");
      expect(targetRow(a.config)).toEqual({ exists: true, consent: undefined, pending: undefined });
      expect(
        await fsPromises.access(workspaceTurnOwnerLockPath(rootDir, "wst_handle")).then(
          () => true,
          () => false
        )
      ).toBe(false);
    });
  }

  test("a failed grant write still settles the turn and leaves the target off", async () => {
    const { config, real, manager, parentId } = await setUp();
    expect((await createTurn(manager, parentId, { mode: "new" })).success).toBe(true);
    // Only the grant's config.json publication fails (#4444: editConfig rejects).
    const grant = real.grantPendingDefaultUnrelatedWorkspaceConsent.bind(real);
    spyOn(real, "grantPendingDefaultUnrelatedWorkspaceConsent").mockImplementation(async (id) => {
      const realRename = cjsFs.rename.bind(cjsFs);
      const publish = spyOn(cjsFs, "rename").mockImplementation(((
        from: cjsFs.PathLike,
        to: cjsFs.PathLike,
        callback: cjsFs.NoParamCallback
      ) => {
        if (path.basename(String(to)) !== "config.json") return realRename(from, to, callback);
        callback(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
      }) as typeof cjsFs.rename);
      try {
        await grant(id);
      } finally {
        publish.mockRestore();
      }
    });

    await endTurn(manager, parentId);

    expect(await workspaceTurnSnapshot(manager, parentId)).toMatchObject({ status: "completed" });
    expect(targetRow(config)).toEqual({ exists: true, consent: undefined, pending: true });
  });
});
