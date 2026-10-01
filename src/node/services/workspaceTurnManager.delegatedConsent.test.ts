import { execFileSync } from "child_process";
import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { Config } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { workspace as workspaceApi } from "@/common/orpc/schemas/api";
import { createMuxMessage } from "@/common/types/message";
import { HistoryService } from "@/node/services/historyService";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
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
  initGitRepo,
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
    const { aiService } = createAIServiceMocks(config);
    // Shared so removal resolves the target's metadata (and so its runtime) from config.
    const real = createWorkspaceServiceForTest({ config, aiService });
    const host = createWorkspaceServiceMocks({
      create: mock(async (...args: Parameters<WorkspaceHost["create"]>) => {
        const result = await real.create(...args);
        await options.afterCreate?.();
        return result;
      }),
      createScratch: mock(async (...args: Parameters<WorkspaceHost["createScratch"]>) => {
        const result = await real.createScratch(...args);
        await options.afterCreate?.();
        return result;
      }),
      grantPendingDefaultUnrelatedWorkspaceConsent: mock((id: string) =>
        real.grantPendingDefaultUnrelatedWorkspaceConsent(id)
      ),
      clearPendingDefaultUnrelatedConsent: mock((id: string) =>
        real.clearPendingDefaultUnrelatedConsent(id)
      ),
      removeWhileTaskTreeLocked: mock(
        (...args: Parameters<WorkspaceHost["removeWhileTaskTreeLocked"]>) =>
          real.removeWhileTaskTreeLocked(...args)
      ),
      clearDelegatedCreationMark: mock((id: string, handleId: string) =>
        real.clearDelegatedCreationMark(id, handleId)
      ),
      markDelegatedCreationInterrupted: mock((id: string, handleId: string) =>
        real.markDelegatedCreationInterrupted(id, handleId)
      ),
    });
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

  /** #4983: the creator-written mark on a row (TARGET unless another id is given). */
  const mark = (config: Config, workspaceId = TARGET) =>
    findWorkspaceEntry(config.loadConfigOrDefault(), workspaceId)?.workspace.delegatedCreation;

  /** The owner's task tool call started the creation, so the owner has a transcript. */
  async function ownerMidTurn(config: Config, parentId: string) {
    const turn = createMuxMessage("msg_owner", "user", "delegate");
    expect((await new HistoryService(config).appendToHistory(parentId, turn)).success).toBe(true);
  }

  /**
   * #4983: the creator died (SIGKILL, power loss) after create() registered the target and before
   * its handle record persisted. The in-test creator stays paused until `finish`.
   */
  async function crashBeforeRecord(options: { disposable?: boolean } = {}) {
    const [created, paused] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const a = await setUp({ afterCreate: () => (created.resolve(), paused.promise) });
    const creating = createTurn(a.manager, a.parentId, {
      mode: "new",
      disposable: options.disposable,
    }).catch(() => undefined);
    await created.promise;
    await ownerMidTurn(a.config, a.parentId);
    await markCreatorDead();
    const finish = async () => {
      paused.resolve();
      await creating;
    };
    return { ...a, finish };
  }

  const handleRecordPath = (parentId: string) =>
    path.join(rootDir, "sessions", parentId, "task-handles", "wst_handle.json");

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

  // The forced removal runs `git branch -D`: only a branch this creation made may go.
  test.each([
    { label: "keeps a branch it reused", existing: true },
    { label: "deletes a branch it made", existing: false },
  ])("an exit before the handle record on a worktree target $label", async ({ existing }) => {
    const a = await setUp();
    initGitRepo(a.projectPath);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: a.projectPath, encoding: "utf8" }).trim();
    // One commit ahead of main, so only `git branch -D` would delete it.
    if (existing) {
      git("branch", "reused", git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "own work"));
    }
    const srcBaseDir = path.join(rootDir, "src");
    await a.config.editConfig((cfg) => {
      const parent = findWorkspaceEntry(cfg, a.parentId)?.workspace;
      if (parent) parent.runtimeConfig = { type: "worktree", srcBaseDir };
      return cfg;
    });
    const branch = existing ? "reused" : "fresh";
    const tipBefore = existing ? git("rev-parse", branch) : undefined;

    const created = await a.manager.createWorkspaceTurn({
      ownerWorkspaceId: a.parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new", branchName: branch, trunkBranch: "main" },
      modelString: "::",
    });

    expect(created.success).toBe(false);
    expect(findWorkspaceEntry(a.config.loadConfigOrDefault(), TARGET)).toBeNull();
    expect(git("worktree", "list")).not.toContain(path.join(srcBaseDir, "repo", branch));
    expect(git("branch", "--list", branch) === "").toBe(!existing);
    if (tipBefore !== undefined) expect(git("rev-parse", branch)).toBe(tipBefore);
  });

  /** A project-less scratch chat as the owner; its workdir sits under the managed scratch root. */
  async function setUpScratchOwner(options: Parameters<typeof backend>[0] = {}) {
    const a = await backend(options);
    const parentId = "5555555555";
    const parentPath = path.join(rootDir, "scratch", parentId);
    await fsPromises.mkdir(parentPath, { recursive: true });
    await a.config.editConfig((cfg) => {
      cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
        projectKind: "system",
        trusted: true,
        workspaces: [
          {
            kind: "scratch",
            path: parentPath,
            id: parentId,
            name: `scratch-${parentId}`,
            createdAt: new Date().toISOString(),
            runtimeConfig: { type: "local" },
            aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
          },
        ],
      });
      cfg.taskSettings = { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 };
      return cfg;
    });
    return { ...a, parentId, parentPath };
  }

  test("a scratch owner's mode new creates a scratch target under the same consent contract", async () => {
    const { config, manager, parentId } = await setUpScratchOwner();
    // Scratch chats have no git branch to name or base on.
    const refused = await manager.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new", branchName: "feature" },
    });
    expect(refused.success ? "" : refused.error).toContain("no git branch");
    expect(findWorkspaceEntry(config.loadConfigOrDefault(), TARGET)).toBeNull();

    await start(manager, parentId, { mode: "new" });
    const entry = findWorkspaceEntry(config.loadConfigOrDefault(), TARGET);
    expect(entry?.projectPath).toBe(SCRATCH_PROJECT_CONFIG_KEY);
    expect(entry?.workspace.kind).toBe("scratch");
    expect(entry?.workspace.parentWorkspaceId).toBeUndefined();
    expect(await fsPromises.stat(entry!.workspace.path).then((st) => st.isDirectory())).toBe(true);
    expect(targetRow(config)).toEqual({ consent: undefined, pending: true });
    // The handle record persisted, so the creator's crash-binding mark was dropped.
    expect(mark(config)).toBeUndefined();

    await endTurn(manager, parentId);
    expect(targetRow(config).consent).toBeDefined();
    expect(targetRow(config).pending).toBeUndefined();
  });

  test("a scratch owner's exit before the handle record removes only the new scratch target", async () => {
    const late: { a?: Awaited<ReturnType<typeof setUpScratchOwner>> } = {};
    const a = await setUpScratchOwner({
      afterCreate: () => archive(late.a!.config, late.a!.parentId),
    });
    late.a = a;
    const created = await createTurn(a.manager, a.parentId, { mode: "new" });

    expect(created.success ? "" : created.error).toContain("owner workspace was archived");
    expect(findWorkspaceEntry(a.config.loadConfigOrDefault(), TARGET)).toBeNull();
    expect(
      await fsPromises.stat(path.join(rootDir, "scratch", TARGET)).catch(() => null)
    ).toBeNull();
    expect(await fsPromises.stat(a.parentPath).then(() => true)).toBe(true);
  });

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
    await (await backend()).manager.resolveOrphanedDelegatedTargets();
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

    await (await backend()).manager.resolveOrphanedDelegatedTargets();
    expect(targetRow(config).pending).toBe(true);
  });

  for (const creator of ["alive", "dead"] as const) {
    test(`the startup resolver clears a mark only when its creator is dead (${creator})`, async () => {
      const [created, paused] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const a = await setUp({ afterCreate: () => (created.resolve(), paused.promise) });
      const creating = createTurn(a.manager, a.parentId, { mode: "new" });
      await created.promise; // The row exists with its mark; the handle record does not yet.
      const binding = { handleId: "wst_handle", ownerWorkspaceId: a.parentId };
      expect(mark(a.config)).toEqual(binding);
      await ownerMidTurn(a.config, a.parentId);
      if (creator === "dead") await markCreatorDead();

      await a.manager.resolveOrphanedDelegatedTargets();
      await (await backend()).manager.resolveOrphanedDelegatedTargets();
      expect(targetRow(a.config).pending).toBe(creator === "alive" ? true : undefined);
      // #4983: only a dead creator's target is flagged, and flagging removes nothing.
      const flaggedAt = mark(a.config)?.interruptedAt;
      expect(flaggedAt === undefined).toBe(creator === "alive");
      const lock = workspaceTurnOwnerLockPath(rootDir, "wst_handle");
      expect((await fsPromises.stat(lock).catch(() => null)) === null).toBe(creator === "dead");
      // A later startup leaves a flagged row as it is.
      await (await backend()).manager.resolveOrphanedDelegatedTargets();
      expect(mark(a.config)?.interruptedAt).toBe(flaggedAt);

      paused.resolve();
      expect((await creating).success).toBe(true);
      // A persisted record ends the unconfirmed mark; a confirmed flag stays for the user.
      expect(mark(a.config)).toEqual(
        creator === "alive" ? undefined : { ...binding, interruptedAt: flaggedAt }
      );
      await endTurn(a.manager, a.parentId);
      expect(targetRow(a.config).consent === undefined).toBe(creator === "dead");
    });
  }

  test("a disposable target is marked too and flagged when its creator dies (#4983)", async () => {
    const a = await crashBeforeRecord({ disposable: true });
    expect(mark(a.config)?.interruptedAt).toBeUndefined();

    await (await backend()).manager.resolveOrphanedDelegatedTargets();

    expect(mark(a.config)?.interruptedAt).toBeString();
    await a.finish();
  });

  test("copied reserved tags never make a workspace an orphan (#4983)", async () => {
    // A real orphan leaves a lock with a dead holder; a public create copies its tags.
    const a = await crashBeforeRecord();
    const tags = { "mux.taskHandleId": "wst_handle", "mux.taskOwnerWorkspaceId": a.parentId };
    const input = workspaceApi.create.input.parse({
      projectPath: a.projectPath,
      branchName: "forged",
      tags,
      delegatedCreation: { handleId: "wst_handle", ownerWorkspaceId: a.parentId },
    });
    expect(input).not.toHaveProperty("delegatedCreation");
    const forged = await a.real.create(
      input.projectPath,
      input.branchName,
      "main",
      undefined,
      {
        type: "local",
      },
      undefined,
      false,
      input.tags
    );
    expect(forged.success).toBe(true);
    const forgedId = forged.success ? forged.data.metadata.id : "";

    await (await backend()).manager.resolveOrphanedDelegatedTargets();

    expect(mark(a.config)?.interruptedAt).toBeString();
    expect(findWorkspaceEntry(a.config.loadConfigOrDefault(), forgedId)?.workspace).toBeDefined();
    expect(mark(a.config, forgedId)).toBeUndefined();
    await a.finish();
  });

  test("a handle record file, even an unreadable one, means the target is not an orphan (#4983)", async () => {
    const a = await crashBeforeRecord();
    // Corrupt, or written by a newer build: getWorkspaceTurn() reads it as null.
    await fsPromises.mkdir(path.dirname(handleRecordPath(a.parentId)), { recursive: true });
    await fsPromises.writeFile(handleRecordPath(a.parentId), "{ not json");

    await (await backend()).manager.resolveOrphanedDelegatedTargets();

    // Not flagged, and the mark stays: the unreadable record cannot bind the target itself.
    expect(mark(a.config)).toEqual({ handleId: "wst_handle", ownerWorkspaceId: a.parentId });
    await fsPromises.rm(handleRecordPath(a.parentId));
    await a.finish();
  });

  test("a mark left beside a persisted record is cleared, not flagged (#4983)", async () => {
    const { config, manager, parentId } = await setUp();
    await start(manager, parentId, { mode: "new" });
    expect(mark(config)).toBeUndefined();
    // The creator died between its record write and the mark's clear.
    await config.editConfig((cfg) => {
      const row = findWorkspaceEntry(cfg, TARGET)?.workspace;
      if (row) row.delegatedCreation = { handleId: "wst_handle", ownerWorkspaceId: parentId };
      return cfg;
    });
    await markCreatorDead();

    await (await backend()).manager.resolveOrphanedDelegatedTargets();

    expect(mark(config)).toBeUndefined();
  });

  test("an orphan whose owner is gone is left unflagged (#4983)", async () => {
    const a = await crashBeforeRecord();
    // Records are deleted with the owner's session dir, so a missing record proves nothing.
    await fsPromises.rm(path.join(rootDir, "sessions", a.parentId), {
      recursive: true,
      force: true,
    });

    await (await backend()).manager.resolveOrphanedDelegatedTargets();

    expect(mark(a.config)?.interruptedAt).toBeUndefined();
    await a.finish();
  });

  test("an orphan being removed is left unflagged (#4983)", async () => {
    const a = await crashBeforeRecord();
    await a.config.editConfig((cfg) => {
      const row = findWorkspaceEntry(cfg, TARGET)?.workspace;
      if (row) {
        const identity = { birth: null, bootId: null, pidNs: null, machineId: null };
        row.pendingRemoval = {
          removalId: "removal",
          instanceId: "other",
          // Another live process (init), so no self-heal takes the marker over.
          pid: 1,
          identity: { ...identity, platform: process.platform, hostname: null },
          at: new Date().toISOString(),
        };
      }
      return cfg;
    });

    await (await backend()).manager.resolveOrphanedDelegatedTargets();

    expect(
      findWorkspaceEntry(a.config.loadConfigOrDefault(), TARGET)?.workspace.pendingRemoval
    ).toBeDefined();
    expect(mark(a.config)?.interruptedAt).toBeUndefined();
    await a.finish();
  });

  test("the resolver never touches the target's runtime (#4983)", async () => {
    const a = await crashBeforeRecord();
    // An SSH host that cannot resolve: any probe would fail or hang instead of flagging.
    await a.config.editConfig((cfg) => {
      const row = findWorkspaceEntry(cfg, TARGET)?.workspace;
      if (row) row.runtimeConfig = { type: "ssh", host: "orphan.invalid", srcBaseDir: "/src" };
      return cfg;
    });

    await (await backend()).manager.resolveOrphanedDelegatedTargets();

    expect(mark(a.config)?.interruptedAt).toBeString();
    await a.finish();
  });

  test("a flagged orphan whose consent clear failed gets it cleared next time (#4983)", async () => {
    const a = await crashBeforeRecord();
    const b = await backend();
    // The consent clear's write fails (it only logs); the flag write after it succeeds.
    spyOn(b.config, "editConfig").mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await b.manager.resolveOrphanedDelegatedTargets();
    expect(mark(a.config)?.interruptedAt).toBeString();
    expect(targetRow(a.config).pending).toBe(true);

    await (await backend()).manager.resolveOrphanedDelegatedTargets();
    expect(targetRow(a.config).pending).toBeUndefined();
    await a.finish();
  });

  test("the flag reaches workspace metadata, and Keep drops only a flagged mark (#4983)", async () => {
    const a = await crashBeforeRecord();
    const flagOf = async () =>
      (await a.config.getAllWorkspaceMetadata()).find((meta) => meta.id === TARGET)
        ?.delegatedCreationInterrupted;
    // Keep cannot erase the binding of a creation nobody flagged.
    expect((await a.real.keepInterruptedDelegatedWorkspace(TARGET)).success).toBe(true);
    expect(mark(a.config)?.handleId).toBe("wst_handle");

    await (await backend()).manager.resolveOrphanedDelegatedTargets();
    expect(await flagOf()).toBe(true);

    const published: unknown[] = [];
    a.real.on("metadata", (event: { workspaceId: string; metadata: unknown }) => {
      if (event.workspaceId !== TARGET) return;
      published.push(
        (event.metadata as { delegatedCreationInterrupted?: true } | null)
          ?.delegatedCreationInterrupted
      );
    });
    expect((await a.real.keepInterruptedDelegatedWorkspace(TARGET)).success).toBe(true);
    expect(mark(a.config)).toBeUndefined();
    expect(await flagOf()).toBeUndefined();
    // Keep publishes the cleared flag, so the banner goes away without a reload.
    expect(published).toHaveLength(1);
    expect(published[0]).toBeUndefined();
    await a.finish();
  });

  test("the startup pass publishes the flag without probing a stalled checkout (#4983, #5189)", async () => {
    const a = await crashBeforeRecord();
    const b = await backend();
    const checkoutPath = (
      await b.config.getWorkspaceMetadataById(TARGET, { probeCheckouts: false })
    )?.namedWorkspacePath;
    expect(checkoutPath).toBeString();
    // Building metadata probes every checkout, which a stalled mount blocks indefinitely.
    const build = spyOn(b.config, "getAllWorkspaceMetadata");
    const realAccess = fs.promises.access.bind(fs.promises);
    const access = spyOn(fs.promises, "access").mockImplementation((target, mode) =>
      target === checkoutPath ? new Promise<void>(() => undefined) : realAccess(target, mode)
    );
    // A renderer that loaded before the flag still needs it.
    const published: unknown[] = [];
    b.real.on(
      "metadata",
      (event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => {
        if (event.workspaceId !== TARGET) return;
        published.push(event.metadata?.delegatedCreationInterrupted);
      }
    );

    try {
      await b.manager.resolveOrphanedDelegatedTargets();
      expect(access.mock.calls.some(([target]) => target === checkoutPath)).toBe(false);
    } finally {
      access.mockRestore();
    }

    expect(mark(a.config)?.interruptedAt).toBeString();
    expect(published).toEqual([true]);
    expect(build).not.toHaveBeenCalled();
    await a.finish();
  });

  test("the startup pass does not publish a flagged workspace that list snapshots hide", async () => {
    const a = await crashBeforeRecord();
    // Multi-project workspaces stay hidden while that experiment is off.
    await a.config.editConfig((config) => {
      const entry = findWorkspaceEntry(config, TARGET)?.workspace;
      if (entry == null) throw new Error("target row missing");
      entry.projects = [
        { projectPath: a.projectPath, projectName: "one" },
        { projectPath: path.join(rootDir, "other"), projectName: "other" },
      ];
      return config;
    });
    const b = await backend();
    const published: string[] = [];
    b.real.on("metadata", (event: { workspaceId: string }) => {
      published.push(event.workspaceId);
    });

    await b.manager.resolveOrphanedDelegatedTargets();

    expect(mark(a.config)?.interruptedAt).toBeString();
    expect(published).not.toContain(TARGET);
    await a.finish();
  });

  test("Keep also drops a pending consent default the resolver failed to clear (#4983)", async () => {
    const a = await crashBeforeRecord();
    const b = await backend();
    spyOn(b.config, "editConfig").mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await b.manager.resolveOrphanedDelegatedTargets();
    expect(targetRow(a.config).pending).toBe(true);

    expect((await a.real.keepInterruptedDelegatedWorkspace(TARGET)).success).toBe(true);

    expect(mark(a.config)).toBeUndefined();
    expect(targetRow(a.config).pending).toBeUndefined();
    await a.finish();
  });

  test("Keep republishes an already kept workspace, so a retry clears a stale banner (#5199)", async () => {
    const a = await crashBeforeRecord();
    await (await backend()).manager.resolveOrphanedDelegatedTargets();
    // Another backend kept it: this backend's renderer never saw the cleared flag.
    expect((await (await backend()).real.keepInterruptedDelegatedWorkspace(TARGET)).success).toBe(
      true
    );
    const published: unknown[] = [];
    a.real.on("metadata", (event: { workspaceId: string; metadata: unknown }) => {
      if (event.workspaceId !== TARGET) return;
      published.push(
        (event.metadata as { delegatedCreationInterrupted?: true } | null)
          ?.delegatedCreationInterrupted
      );
    });

    expect((await a.real.keepInterruptedDelegatedWorkspace(TARGET)).success).toBe(true);

    expect(published).toHaveLength(1);
    expect(published[0]).toBeUndefined();
    await a.finish();
  });

  test("a failed flag write never fails startup and is retried next time (#4983)", async () => {
    const a = await crashBeforeRecord({ disposable: true }); // No consent write comes first.
    const b = await backend();
    spyOn(b.config, "editConfig").mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await b.manager.resolveOrphanedDelegatedTargets();
    expect(mark(a.config)?.interruptedAt).toBeUndefined();

    // The lock was released, so the next startup takes it again and flags.
    await (await backend()).manager.resolveOrphanedDelegatedTargets();
    expect(mark(a.config)?.interruptedAt).toBeString();
    await a.finish();
  });
});
