import { describe, expect, test, mock, spyOn } from "bun:test";
import type { AgentSession } from "./agentSession";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import path from "path";
import { Err, Ok } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import type { SecretsStore } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import type { WorkspaceServiceArgs, WorkspaceServiceHarness } from "./workspaceService.testHarness";
import {
  createCompactionAdmissionMocks,
  createWorkspaceServiceHarness,
} from "./workspaceService.testHarness";

function mockCreateWorkspace(workspacePath: string) {
  const createWorkspace = mock(() => Promise.resolve({ success: true as const, workspacePath }));
  const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
    createWorkspace,
  } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
  return { createWorkspace, createRuntimeSpy };
}

function mockDeleteWorkspace(
  deleteWorkspace: () => Promise<
    { success: true; deletedPath: string } | { success: false; error: string }
  >
) {
  const deleteWorkspaceMock = mock(deleteWorkspace);
  const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
    deleteWorkspace: deleteWorkspaceMock,
  } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
  return { deleteWorkspaceMock, createRuntimeSpy };
}

describe("WorkspaceService init cancellation", () => {
  test("scratch workspace deletion preserves shared workdirs until the last reference", async () => {
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;
    const parentId = "1111111111";
    const childId = "2222222222";
    spyOn(config, "generateStableId").mockReturnValue(parentId);

    const created = await workspaceService.createScratch("Scratch test");
    expect(created.success).toBe(true);
    if (!created.success) return;

    const scratchPath = created.data.metadata.namedWorkspacePath;
    await config.editConfig((current) => {
      const scratchProject = current.projects.get(SCRATCH_PROJECT_CONFIG_KEY);
      if (!scratchProject) throw new Error("Scratch project missing");
      scratchProject.workspaces.push({
        kind: "scratch",
        path: scratchPath,
        id: childId,
        name: `agent-explore-${childId}`,
        parentWorkspaceId: parentId,
        taskIsolation: "none",
        taskStatus: "reported",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return current;
    });

    expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
    expect(await workspaceService.remove(parentId, true)).toEqual(Ok(undefined));
    expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
    expect(await workspaceService.remove(childId, true)).toEqual(Ok(undefined));
    expect(
      await fsPromises
        .stat(scratchPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  test("new scratch workspaces opt in with distinct generations and a later opt-out persists", async () => {
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;

    const first = await workspaceService.createScratch("First scratch");
    const second = await workspaceService.createScratch("Second scratch");
    if (!first.success || !second.success) {
      throw new Error("Expected both scratch workspaces to be created");
    }
    const firstId = first.data.metadata.id;
    const secondId = second.data.metadata.id;
    const consentOf = async (workspaceId: string) =>
      (await config.getAllWorkspaceMetadata()).find((m) => m.id === workspaceId)
        ?.unrelatedWorkspaceConsent;

    const firstConsent = await consentOf(firstId);
    const secondConsent = await consentOf(secondId);
    // The returned metadata already carries the grant, so the UI switch starts on.
    expect(first.data.metadata.unrelatedWorkspaceConsent).toBe(firstConsent);
    expect(getValidUnrelatedWorkspaceConsent(firstConsent)).toBe(firstConsent);
    expect(getValidUnrelatedWorkspaceConsent(secondConsent)).toBe(secondConsent);
    // Each workspace owns its own revocation generation.
    expect(firstConsent).not.toBe(secondConsent);

    // Opting out deletes the field; nothing re-mints it on reload (no startup backfill).
    expect((await workspaceService.setUnrelatedWorkspaceConsent(firstId, false)).success).toBe(
      true
    );
    expect(await consentOf(firstId)).toBeUndefined();
    expect(await consentOf(secondId)).toBe(secondConsent);
  });

  test("scratch removal refuses to delete a workdir the workspace does not own", async () => {
    // A stale or hand-edited config entry can point at another chat's dir
    // under the scratch root; removal must not recursively delete it.
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;
    const victimId = "3333333333";
    const malformedId = "4444444444";
    spyOn(config, "generateStableId").mockReturnValue(victimId);

    const created = await workspaceService.createScratch("Victim scratch");
    expect(created.success).toBe(true);
    if (!created.success) return;
    const victimPath = created.data.metadata.namedWorkspacePath;

    // Remove the victim's config entry (keep the dir) so the malformed
    // entry is the workdir's only reference; then point the malformed
    // root entry (no task ancestry) at the victim's dir.
    await config.editConfig((current) => {
      const scratchProject = current.projects.get(SCRATCH_PROJECT_CONFIG_KEY);
      if (!scratchProject) throw new Error("Scratch project missing");
      scratchProject.workspaces = scratchProject.workspaces.filter(
        (workspace) => workspace.id !== victimId
      );
      scratchProject.workspaces.push({
        kind: "scratch",
        path: victimPath,
        id: malformedId,
        name: `scratch-${malformedId}`,
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return current;
    });

    expect(await workspaceService.remove(malformedId, true)).toEqual(Ok(undefined));
    // Config cleanup proceeded, but the victim's dir must survive.
    expect(await fsPromises.stat(victimPath).then(() => true)).toBe(true);
  });

  test("createScratch rejects when policy disallows the local runtime", async () => {
    const policyService = {
      isEnforced: mock(() => true),
      isRuntimeAllowed: mock(() => false),
    } as unknown as WorkspaceServiceArgs[8];
    await using harness = await createWorkspaceServiceHarness({ policyService });
    const { config, service: workspaceService } = harness;

    const result = await workspaceService.createScratch("Blocked scratch");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not allowed by policy");
    }
    // No config entry or workdir may be left behind by the rejected create.
    expect((await config.getAllWorkspaceMetadata()).length).toBe(0);
  });

  test("create() rejects untrusted projects", async () => {
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;
    const projectPath = path.join(harness.rootDir, "proj");
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [], trusted: false });
      return cfg;
    });
    const generateStableId = spyOn(config, "generateStableId");

    const result = await workspaceService.create(projectPath, "ws-branch", undefined, "title", {
      type: "local",
    });

    expect(result).toEqual(
      Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      )
    );
    expect(generateStableId).not.toHaveBeenCalled();
    expect(config.loadConfigOrDefault().projects.get(projectPath)?.workspaces).toEqual([]);
  });

  test("create() rejects slash branches whose sanitized workspace name already exists", async () => {
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;
    const projectPath = path.join(harness.rootDir, "proj");
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "feature-foo", "existing"),
    ]);
    const generateStableId = spyOn(config, "generateStableId");

    const result = await workspaceService.create(projectPath, "feature/foo", undefined, "title", {
      type: "local",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Branch "feature/foo"');
      expect(result.error).toContain('workspace name "feature-foo"');
    }
    expect(generateStableId).not.toHaveBeenCalled();
    expect(
      config
        .loadConfigOrDefault()
        .projects.get(projectPath)
        ?.workspaces.map((ws) => ws.id)
    ).toEqual(["existing"]);
  });

  test("archive() aborts init and still archives when init is running", async () => {
    const workspaceId = "ws-init-running";
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService, initStateManager } = harness;
    const projectPath = path.join(harness.rootDir, "proj");
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "ws", workspaceId, { runtimeConfig: { type: "local" } }),
    ]);
    initStateManager.startInit(workspaceId, projectPath);

    // Make it obvious if archive() incorrectly chooses deletion.
    // Records calls only: a wrong deletion would also remove the entry asserted below.
    const removeSpy = spyOn(workspaceService, "remove");

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(
      config.loadConfigOrDefault().projects.get(projectPath)?.workspaces[0]?.archivedAt
    ).toBeDefined();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(initStateManager.getInitState(workspaceId)).toBeUndefined();
  });

  test("archive() uses normal archive flow when init is complete", async () => {
    const workspaceId = "ws-init-complete";
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService, initStateManager } = harness;
    const projectPath = path.join(harness.rootDir, "proj");
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "ws", workspaceId, { runtimeConfig: { type: "local" } }),
    ]);
    initStateManager.startInit(workspaceId, projectPath);
    await initStateManager.endInit(workspaceId, 0);
    expect(initStateManager.getInitState(workspaceId)?.status).toBe("success");

    // Make it obvious if archive() incorrectly chooses deletion.
    // Records calls only: a wrong deletion would also remove the entry asserted below.
    const removeSpy = spyOn(workspaceService, "remove");

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(
      config.loadConfigOrDefault().projects.get(projectPath)?.workspaces[0]?.archivedAt
    ).toBeDefined();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  test("list() includes isInitializing when init state is running", async () => {
    const workspaceId = "ws-list-initializing";
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService, initStateManager } = harness;
    const projectPath = path.join(harness.rootDir, "proj");
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "ws", workspaceId, { runtimeConfig: { type: "local" } }),
    ]);
    initStateManager.startInit(workspaceId, projectPath);

    const list = await workspaceService.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.isInitializing).toBe(true);
  });

  test("create() clears init state + emits updated metadata when skipping background init", async () => {
    const workspaceId = "ws-skip-init";
    const branchName = "ws_branch";
    const secretsStore = {
      getEffectiveSecrets: mock(() => [{ key: "GH_TOKEN", value: "token" }]),
    } as unknown as SecretsStore;
    await using harness = await createWorkspaceServiceHarness({ secretsStore });
    const { config, service: workspaceService, initStateManager } = harness;
    const projectPath = path.join(harness.rootDir, "proj");
    const workspacePath = path.join(projectPath, branchName);
    await saveWorkspaces(config, projectPath, []);
    spyOn(config, "generateStableId").mockReturnValue(workspaceId);
    const clearInMemoryState = spyOn(initStateManager, "clearInMemoryState");
    const { createWorkspace, createRuntimeSpy } = mockCreateWorkspace(workspacePath);

    const sessionEmitter = new EventEmitter();
    const fakeSession = {
      ...createCompactionAdmissionMocks(),
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      emitMetadata: (metadata: FrontendWorkspaceMetadata | null) => {
        sessionEmitter.emit("metadata-event", { workspaceId, metadata });
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    try {
      const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
      workspaceService.on("metadata", (event: unknown) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
        if (parsed.workspaceId === workspaceId) {
          metadataEvents.push(parsed.metadata);
        }
      });

      workspaceService.registerSession(workspaceId, fakeSession);

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
      removingWorkspaces.add(workspaceId);

      const result = await workspaceService.create(projectPath, branchName, undefined, "title", {
        type: "local",
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ env: { GH_TOKEN: "token" } })
      );
      expect(result.data.metadata.isInitializing).toBe(undefined);
      expect(clearInMemoryState).toHaveBeenCalledWith(workspaceId);
      expect(initStateManager.getInitState(workspaceId)).toBeUndefined();

      expect(metadataEvents).toHaveLength(2);
      expect(metadataEvents[0]?.isInitializing).toBe(true);
      expect(metadataEvents[1]?.isInitializing).toBe(undefined);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  async function setUpAutoNamedCreate() {
    // /new mirrors /fork's seamless flow: callers no longer have to invent a
    // workspace name. The backend should derive the next "workspace-N" slot
    // and persist `pendingAutoTitle` so the first message can title the workspace.
    const workspaceId = "ws-auto-named";
    const harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;
    const projectPath = path.join(harness.rootDir, "proj-auto");
    // Two pre-existing workspaces — auto-naming should skip past them.
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "workspace-1", "x"),
      projectWorkspace(projectPath, "workspace-2", "y"),
    ]);
    spyOn(config, "generateStableId").mockReturnValue(workspaceId);
    const { createWorkspace, createRuntimeSpy } = mockCreateWorkspace(
      path.join(projectPath, "workspace-3")
    );
    const readEntry = (id: string) =>
      config
        .loadConfigOrDefault()
        .projects.get(projectPath)
        ?.workspaces.find((entry) => entry.id === id);

    const removingWorkspaces = (workspaceService as unknown as { removingWorkspaces: Set<string> })
      .removingWorkspaces;
    // Skip the background init path so the test stays focused on auto-naming/persistence.
    removingWorkspaces.add(workspaceId);

    // Record the persisted consent while registration-time sanitization runs.
    const consentDuringSanitize: unknown[] = [];
    spyOn(
      workspaceService as unknown as {
        sanitizeStalePluginOverridesForNewWorkspace: (
          workspaceId: string,
          workspacePath: string
        ) => Promise<string | undefined>;
      },
      "sanitizeStalePluginOverridesForNewWorkspace"
    ).mockImplementation((id: string) => {
      consentDuringSanitize.push(readEntry(id)?.unrelatedWorkspaceConsent);
      return Promise.resolve(undefined);
    });
    return {
      harness,
      workspaceId,
      projectPath,
      createWorkspace,
      createRuntimeSpy,
      readEntry,
      consentDuringSanitize,
    };
  }

  test("create() auto-generates a workspace branch name when none is provided", async () => {
    const setup = await setUpAutoNamedCreate();
    await using harness = setup.harness;
    const { workspaceId, projectPath, createWorkspace, readEntry, consentDuringSanitize } = setup;

    try {
      const result = await harness.service.create(
        projectPath,
        // No branchName — backend should auto-generate workspace-3.
        undefined,
        undefined,
        undefined,
        { type: "local" },
        undefined,
        // pendingAutoTitle: true mirrors the /fork-with-message flow.
        true
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      // Backend picked the next "workspace-N" slot and threaded it through to
      // both the runtime call and the persisted config entry.
      expect(createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "workspace-3",
          directoryName: "workspace-3",
        })
      );

      const newEntry = readEntry(workspaceId);
      expect(newEntry?.name).toBe("workspace-3");
      expect(newEntry?.pendingAutoTitle).toBe(true);
      // New root workspaces are opted in to unrelated messaging at creation, but only after
      // registration-time sanitization; the announced metadata carries the same generation.
      expect(consentDuringSanitize).toEqual([undefined]);
      expect(getValidUnrelatedWorkspaceConsent(newEntry?.unrelatedWorkspaceConsent)).toBe(
        newEntry?.unrelatedWorkspaceConsent
      );
      expect(newEntry?.unrelatedWorkspaceConsent).toBeDefined();
      expect(result.data.metadata.unrelatedWorkspaceConsent).toBe(
        newEntry?.unrelatedWorkspaceConsent
      );
    } finally {
      setup.createRuntimeSpy.mockRestore();
    }
  });

  test("create() with skipDefaultUnrelatedWorkspaceConsent leaves the workspace opted out", async () => {
    const setup = await setUpAutoNamedCreate();
    await using harness = setup.harness;
    const workspaceService = harness.service;
    const { workspaceId, projectPath, createWorkspace, readEntry } = setup;

    try {
      const result = await workspaceService.create(
        projectPath,
        // No branchName — backend should auto-generate workspace-3.
        undefined,
        undefined,
        undefined,
        { type: "local" },
        undefined,
        // pendingAutoTitle: true mirrors the /fork-with-message flow.
        true,
        undefined,
        { skipDefaultUnrelatedWorkspaceConsent: true }
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      // Backend picked the next "workspace-N" slot and threaded it through to
      // both the runtime call and the persisted config entry.
      expect(createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "workspace-3",
          directoryName: "workspace-3",
        })
      );

      const newEntry = readEntry(workspaceId);
      expect(newEntry?.name).toBe("workspace-3");
      expect(newEntry?.pendingAutoTitle).toBe(true);
      // Delegated targets are not opted in (yet): nothing persisted, announced or pending.
      expect(newEntry?.unrelatedWorkspaceConsent).toBeUndefined();
      expect(result.data.metadata.unrelatedWorkspaceConsent).toBeUndefined();
      expect(
        (
          workspaceService as unknown as { pendingDefaultUnrelatedConsent: Set<string> }
        ).pendingDefaultUnrelatedConsent.has(workspaceId)
      ).toBe(false);
    } finally {
      setup.createRuntimeSpy.mockRestore();
    }
  });

  async function seedLocalWorkspace(harness: WorkspaceServiceHarness, workspaceId: string) {
    const projectPath = path.join(harness.rootDir, "proj");
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, "ws", workspaceId, { runtimeConfig: { type: "local" } }),
    ]);
    return projectPath;
  }

  function injectInitAbortController(harness: WorkspaceServiceHarness, workspaceId: string) {
    const abortController = new AbortController();
    const initAbortControllers = (
      harness.service as unknown as { initAbortControllers: Map<string, AbortController> }
    ).initAbortControllers;
    initAbortControllers.set(workspaceId, abortController);
    return { abortController, initAbortControllers };
  }

  test("remove() aborts init and clears state before teardown", async () => {
    const workspaceId = "ws-remove-aborts";
    await using harness = await createWorkspaceServiceHarness();
    const { service: workspaceService, initStateManager } = harness;
    initStateManager.startInit(workspaceId, harness.rootDir);

    // Inject an in-progress init AbortController.
    const { abortController, initAbortControllers } = injectInitAbortController(
      harness,
      workspaceId
    );

    const result = await workspaceService.remove(workspaceId, true);
    expect(result.success).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(initStateManager.getInitState(workspaceId)).toBeUndefined();

    expect(initAbortControllers.has(workspaceId)).toBe(false);
  });

  test("remove() does not clear init state when runtime deletion fails with force=false", async () => {
    const workspaceId = "ws-remove-runtime-delete-fails";
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService, initStateManager } = harness;
    const projectPath = await seedLocalWorkspace(harness, workspaceId);
    initStateManager.startInit(workspaceId, projectPath);
    const { createRuntimeSpy } = mockDeleteWorkspace(() =>
      Promise.resolve({ success: false as const, error: "dirty" })
    );

    try {
      // Inject an in-progress init AbortController.
      const { abortController } = injectInitAbortController(harness, workspaceId);

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(abortController.signal.aborted).toBe(true);

      // If runtime deletion fails with force=false, removal returns early and the workspace remains.
      // Keep init state intact so init-end can refresh metadata and clear isInitializing.
      expect(initStateManager.getInitState(workspaceId)?.status).toBe("running");
      expect(config.findWorkspace(workspaceId)).not.toBeNull();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("remove() holds turn admission on the session until removal settles", async () => {
    const workspaceId = "ws-remove-holds-admission";
    await using harness = await createWorkspaceServiceHarness();
    const workspaceService = harness.service;
    await seedLocalWorkspace(harness, workspaceId);

    let releases = 0;
    let releasesWhenRuntimeDeleted = -1;
    const { deleteWorkspaceMock, createRuntimeSpy } = mockDeleteWorkspace(() => {
      releasesWhenRuntimeDeleted = releases;
      return Promise.resolve({ success: false as const, error: "dirty" });
    });

    try {
      // A session whose startup recovery may be one await away from dispatching.
      const holdTurnAdmission = mock(() => ({
        [Symbol.dispose]: () => {
          releases += 1;
        },
      }));
      const dispose = mock(() => undefined);
      (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
        workspaceId,
        {
          holdTurnAdmission,
          dispose,
        } as unknown as AgentSession
      );

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(deleteWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(holdTurnAdmission).toHaveBeenCalledTimes(1);
      // Held across the runtime deletion, released once the failed removal settles so the
      // still-configured workspace stays usable.
      expect(releasesWhenRuntimeDeleted).toBe(0);
      expect(releases).toBe(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("remove() calls runtime.deleteWorkspace when force=true", async () => {
    const workspaceId = "ws-remove-runtime-delete";
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;
    const projectPath = path.join(harness.rootDir, "proj");
    // addWorkspace registers the project without a trust decision.
    await config.addWorkspace(projectPath, {
      id: workspaceId,
      name: "ws",
      projectPath,
      projectName: "proj",
      runtimeConfig: { type: "local" },
    });
    const { deleteWorkspaceMock, createRuntimeSpy } = mockDeleteWorkspace(() =>
      Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
    );

    try {
      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // trusted defaults to false (untrusted project), so deleteWorkspace gets (path, name, force, undefined, false)
      expect(deleteWorkspaceMock).toHaveBeenCalledWith(projectPath, "ws", true, undefined, false);
      expect(config.findWorkspace(workspaceId)).toBeNull();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
});
