import type { TurnCompletion } from "./streamManager";
import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";
import { registerInProcessWorkflowRun } from "@/node/services/workflows/workflowArchiveAdmission";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import type { InitStateManager, InitStatus } from "./initStateManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { TerminalService } from "@/node/services/terminalService";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { WorktreeArchiveSnapshot } from "@/common/schemas/project";
import type { BashToolResult } from "@/common/types/tools";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { WorkspaceServiceArgs, MockWorkspaceConfig } from "./workspaceService.testHarness";
import {
  addToArchivingWorkspaces,
  createDeferred,
  mockInitStateManager,
  createTestBackgroundProcessManager,
  createWorkspaceServiceForTest,
} from "./workspaceService.testHarness";

describe("WorkspaceService archive lifecycle hooks", () => {
  const workspaceId = "ws-archive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive";
  const sessionsDir = "/tmp/test/sessions";
  const externalEditorMarkerPath = path.join(sessionsDir, workspaceId, "external-editor-opened");

  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let mockStreamManager: { getStreamInfo: ReturnType<typeof mock> };
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let historyConfig: Config;
  let backgroundProcessManager: BackgroundProcessManager;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
  };

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    ({
      historyService,
      config: historyConfig,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir,
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    mockStreamManager = { ...createStreamLifecycleMocks(), getStreamInfo: mock(() => undefined) };
    backgroundProcessManager = createTestBackgroundProcessManager();
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
      backgroundProcessManager,
      streamManager: mockStreamManager as unknown as WorkspaceServiceArgs[12],
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archive refuses to hide a parent while descendant sub-agents remain active", async () => {
    const hasActiveDescendantAgentTasksForWorkspace = mock(() => true);
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        hasActiveDescendantAgentTasksForWorkspace,
      })
    );

    const preflight = await workspaceService.preflightArchive(workspaceId);
    const archive = await workspaceService.archive(workspaceId);

    const expectedError =
      "This workspace has active descendant sub-agents. Stop them before archiving their parent.";
    expect(preflight).toEqual(Err(expectedError));
    expect(archive).toEqual(Err(expectedError));
    expect(hasActiveDescendantAgentTasksForWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(editConfigSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["shared", "interrupted", "owner"],
    ["isolated", "queued", undefined],
  ] as const)(
    "archiving a %s queued child leaves its task status %s",
    async (_kind, expectedStatus, taskDesktopOwnerWorkspaceId) => {
      const project = configState.projects.get(projectPath);
      if (!project) throw new Error("project fixture must exist");
      project.workspaces.unshift({ path: "/tmp/project/owner", id: "owner" });
      Object.assign(project.workspaces[1], {
        parentWorkspaceId: "owner",
        taskStatus: "queued",
        taskPrompt: "brief",
        ...(taskDesktopOwnerWorkspaceId !== undefined ? { taskDesktopOwnerWorkspaceId } : {}),
      });

      expect(await workspaceService.archive(workspaceId)).toEqual(Ok({ kind: "archived" }));

      // A shared child must not stay an active borrower of the owner's desktop while archived;
      // the queued brief survives for the reawaken path.
      const entry = project.workspaces.find((w) => w.id === workspaceId);
      expect(entry?.archivedAt).toBeTruthy();
      expect(entry?.taskStatus).toBe(expectedStatus);
      expect(entry?.taskPrompt).toBe("brief");
    }
  );

  test("returns Err and does not persist archivedAt when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    expect(editConfigSpy).toHaveBeenCalledTimes(0);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
  });

  test("does not interrupt an active stream when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const interruptStreamSpy = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.interruptStream =
      interruptStreamSpy as unknown as typeof workspaceService.interruptStream;

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(interruptStreamSpy).toHaveBeenCalledTimes(0);
  });

  test("archive() stays successful when post-persist terminal teardown fails", async () => {
    const closeWorkspaceSessions = mock(() => {
      throw new Error("terminal close failed");
    });
    const terminalService = {
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });

  test("archive() disposes a transient startup-recovery session once archivedAt is durable", async () => {
    let editConfigCallsAtDispose = -1;
    const dispose = mock(() => {
      editConfigCallsAtDispose = editConfigSpy.mock.calls.length;
    });
    const access = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
    };
    access.transientStartupRecoverySessions.set(workspaceId, {
      dispose,
    } as unknown as AgentSession);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(editConfigCallsAtDispose).toBe(1);
    expect(access.transientStartupRecoverySessions.has(workspaceId)).toBe(false);
  });

  test("archive() closes workspace terminal sessions on success", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(closeWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(closeWorkspaceSessions).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close terminal sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
  });

  test("archive() releases desktop viewers before persisting the archived identity", async () => {
    const started = createDeferred<void>();
    const released = createDeferred<void>();
    const close = mock(() => {
      started.resolve();
      return released.promise;
    });
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const archiving = workspaceService.archive(workspaceId);
    await started.promise;
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    try {
      expect(entry?.archivedAt).toBeUndefined();
    } finally {
      released.resolve();
    }
    const result = await archiving;

    expect(result.success).toBe(true);
    expect(entry?.archivedAt).toBeTruthy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close desktop sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  test("persists archivedAt when beforeArchive hooks succeed", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(editConfigSpy).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("persists archivedAt before afterArchive hooks run and treats hook failures as best-effort", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.archivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterArchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("archive() removes DevTools data only after archivedAt is persisted", async () => {
    const removeWorkspaceData = mock((id: string) => {
      // devtools cleanup must run only once the archived state is durable
      expect(id).toBe(workspaceId);
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.archivedAt).toBeTruthy();
      return Promise.resolve();
    });
    workspaceService.setDevToolsService({
      hasWorkspaceData: () => Promise.resolve(true),
      removeWorkspaceData,
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(removeWorkspaceData).toHaveBeenCalledTimes(1);
  });

  test("archive() stays successful when DevTools cleanup fails", async () => {
    workspaceService.setDevToolsService({
      hasWorkspaceData: () => Promise.resolve(true),
      removeWorkspaceData: mock(() => Promise.reject(new Error("disk error"))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });

  test("archive() honors the caller's pinned Coder policy over a flipped config read", async () => {
    // Dedicated (mux-created) Coder workspace: the remote-deletion guard only applies to these.
    (mockAIService.getWorkspaceMetadata as ReturnType<typeof mock>).mockReturnValue(
      Promise.resolve(
        Ok({
          ...workspaceMetadata,
          runtimeConfig: {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          },
        })
      )
    );
    // Simulate a keep → delete settings flip landing AFTER the caller read "keep" and committed
    // to the archive (e.g. by interrupting turns based on that read).
    configState.coderWorkspaceArchiveBehavior = "delete";

    const hooks = new WorkspaceLifecycleHooks();
    let hookBehavior: string | undefined;
    hooks.registerBeforeArchive((args) => {
      hookBehavior = args.coderWorkspaceArchiveBehavior;
      return Promise.resolve(Ok(undefined));
    });
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    // Without a pinned read, the sink's fresh config read refuses under the flipped policy.
    const unpinned = await workspaceService.archive(workspaceId, undefined, {
      forbidCoderWorkspaceDeletion: true,
    });
    expect(unpinned.success).toBe(false);
    if (!unpinned.success) {
      expect(unpinned.error).toContain("Coder workspace archive behavior");
    }

    // With the caller's pinned read, the same flipped config cannot change the operation: the
    // guard passes and the before-archive hook receives the pinned value.
    const pinned = await workspaceService.archive(workspaceId, undefined, {
      forbidCoderWorkspaceDeletion: true,
      coderWorkspaceArchiveBehaviorOverride: "keep",
    });
    expect(pinned).toEqual(Ok({ kind: "archived" }));
    expect(hookBehavior).toBe("keep");
  });

  test("archive() under refuseLiveUserActivity closes an idle desktop process instead of refusing", async () => {
    // The desktop process an agent started lingers after its turn finished; nobody is attached,
    // so an agent-driven archive must proceed and close it like the user-driven path does.
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
      has: () => true,
      hasAttachedViewers: () => false,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result).toEqual(Ok({ kind: "archived" }));
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() under refuseLiveUserActivity refuses while a desktop viewer is attached", async () => {
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
      has: () => true,
      hasAttachedViewers: () => true,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("desktop viewer");
    }
    expect(close).not.toHaveBeenCalled();
  });

  test("archive() refuses while in-process workflow work exists under refuseLiveUserActivity", async () => {
    // Simulates a workflow admission/runner that entered before the archive gate armed: the
    // sink's synchronous gate must observe it and refuse instead of orphaning the run.
    const release = registerInProcessWorkflowRun(workspaceId);
    try {
      const refused = await workspaceService.archive(workspaceId, undefined, {
        refuseLiveUserActivity: true,
      });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("workflow run starting or running");
      }
    } finally {
      release();
    }

    const archived = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    expect(archived).toEqual(Ok({ kind: "archived" }));
  });

  test("acquirePreInterruptionArchiveHold validates and arms the gate before turn interruption", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // In-flight user activity must refuse BEFORE the caller destroys delegated turns: the
    // sink's own gate runs only after interruption, when the turns are already lost.
    const release = registerInProcessWorkflowRun(workspaceId);
    let refused: ReturnType<typeof workspaceService.acquirePreInterruptionArchiveHold>;
    try {
      refused = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
        queuedDelegatedTurnCount: 0,
        expectedDelegatedTurnCorrelations: [],
      });
    } finally {
      release();
    }
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain("workflow run");
    }

    // MCP prompt discovery admitted before the hold pairs the same way: its counter refuses
    // the hold before any delegated turn is interrupted.
    const discovery = workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId);
    expect(discovery).toBeDefined();
    const refusedByDiscovery = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(refusedByDiscovery.success).toBe(false);
    if (!refusedByDiscovery.success) {
      expect(refusedByDiscovery.error).toContain("MCP prompt discovery in progress");
    }
    discovery![Symbol.dispose]();

    // In-flight editor/terminal opens are visible only through the pending-open counters
    // until their durable markers persist; the hold must refuse on them before the caller
    // interrupts anything (the sink's untrackable-app check would refuse only afterwards).
    const pendingOpen = workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    const refusedByOpen = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(refusedByOpen.success).toBe(false);
    if (!refusedByOpen.success) {
      expect(refusedByOpen.error).toContain("external editor open in progress");
    }
    const admittedOpen = await pendingOpen;
    expect(admittedOpen.success).toBe(true);
    if (admittedOpen.success) {
      await admittedOpen.data.rollbackAfterFailedLaunch();
    }

    // A refused hold releases the gate; a granted one arms it for the caller to carry
    // through the sink, refusing new user admissions exactly like the sink's own gate.
    const hold = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(hold.success).toBe(true);
    if (!hold.success) return;
    try {
      const refusedOpen = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-hold");
      expect(refusedOpen.success).toBe(false);
      if (!refusedOpen.success) {
        expect(refusedOpen.error).toContain("being archived");
      }
      expect(workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId)).toBeUndefined();
    } finally {
      hold.data[Symbol.dispose]();
    }

    // Released (e.g. the archive failed): admissions flow again.
    const allowed = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-hold-2");
    expect(allowed.success).toBe(true);
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("acquirePreInterruptionArchiveHold binds the stream exemption to the delegated turns", () => {
    const delegated = { taskHandleId: "wt-1", ownerWorkspaceId: "owner-1", turnId: "turn-1" };
    const streamMeta: Record<string, unknown> = { type: "workspace-turn-task", ...delegated };
    Object.assign(mockAIService, { isStreaming: mock(() => true) });
    // The delegated-turn correlation is read from the engine, not the AI facade.
    mockStreamManager.getStreamInfo = mock(() => ({ muxMetadata: streamMeta }));

    // The active stream carries the collected turn's exact correlation: interruptible
    // delegated work, so the hold is granted.
    const held = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(held.success).toBe(true);
    if (held.success) held.data[Symbol.dispose]();

    // A stream correlated to a DIFFERENT turn (the collected turn ended and something else
    // took the workspace's stream slot) must refuse — interruption would stopStream() it.
    streamMeta.turnId = "turn-2";
    const refusedMismatch = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedMismatch.success).toBe(false);
    if (!refusedMismatch.success) {
      expect(refusedMismatch.error).toContain("not attributable to the delegated turns");
    }

    // A stream with no correlation metadata (a plain user stream that replaced the ended
    // delegated stream) also refuses, even though a running delegated turn was collected —
    // the stale collection must not exempt whichever stream happens to be active now.
    Object.assign(mockAIService, {
      getStreamInfo: mock(() => ({ muxMetadata: undefined })),
    });
    const refusedPlain = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedPlain.success).toBe(false);
    if (!refusedPlain.success) {
      expect(refusedPlain.error).toContain("not attributable to the delegated turns");
    }
  });

  test("acquirePreInterruptionArchiveHold freezes queue dispatch for the hold's lifetime", () => {
    // A queued delegated entry that dispatched into PREPARING between the hold and turn
    // interruption would evade the interrupt's targeted queue removal, so the hold must
    // acquire the session's turn-admission block when it arms and release it on dispose.
    const session = workspaceService.getOrCreateSession(workspaceId);
    const realHoldTurnAdmission = session.holdTurnAdmission.bind(session);
    let releases = 0;
    const holdTurnAdmissionSpy = mock(() => {
      const inner = realHoldTurnAdmission();
      return {
        [Symbol.dispose]: () => {
          releases += 1;
          inner[Symbol.dispose]();
        },
      };
    });
    session.holdTurnAdmission = holdTurnAdmissionSpy;

    const held = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(held.success).toBe(true);
    expect(holdTurnAdmissionSpy).toHaveBeenCalledTimes(1);
    if (!held.success) return;
    // Held across interruption and the sink — not released before the caller disposes.
    expect(releases).toBe(0);
    held.data[Symbol.dispose]();
    expect(releases).toBe(1);

    // A refused hold must not leak the admission block either.
    Object.assign(mockAIService, {
      isStreaming: mock(() => true),
      getStreamInfo: mock(() => undefined),
    });
    const refused = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(refused.success).toBe(false);
    expect(releases).toBe(2);
  });

  test("acquirePreInterruptionArchiveHold exempts only a stoppable PREPARING delegated turn", () => {
    const delegated = { taskHandleId: "wt-1", ownerWorkspaceId: "owner-1", turnId: "turn-1" };
    const session = workspaceService.getOrCreateSession(workspaceId);
    session.isPreparingTurn = () => true;
    let stoppable: typeof delegated | undefined = delegated;
    session.getStoppablePreparingWorkspaceTurn = () => stoppable;
    let queued = 0;
    session.queuedMessageEntryCount = () => queued;

    // The collected turn itself is PREPARING with its startup registered: interruptWorkspaceTurn's
    // stopStream cancels it, so the hold is granted.
    const held = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(held.success).toBe(true);
    if (held.success) held.data[Symbol.dispose]();

    // A user entry queued behind the exempt delegated turn is still user work.
    queued = 1;
    const refusedQueued = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedQueued.success).toBe(false);
    if (!refusedQueued.success) {
      expect(refusedQueued.error).toContain("queued messages beyond the delegated turns");
      expect(refusedQueued.error).not.toContain("a message dispatching");
    }
    queued = 0;

    // PREPARING for a different turn than the collected one (the collected turn ended and
    // another delegated turn took the session) is not the work the caller is interrupting.
    stoppable = { ...delegated, turnId: "turn-2" };
    const refusedMismatch = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedMismatch.success).toBe(false);
    if (!refusedMismatch.success) {
      expect(refusedMismatch.error).toContain("a message dispatching");
    }

    // PREPARING work that has not handed its startup to the engine (or a user send) reports no
    // stoppable turn: a stop there would not cancel it, so the hold fails closed.
    stoppable = undefined;
    const refusedUnstoppable = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedUnstoppable.success).toBe(false);
    if (!refusedUnstoppable.success) {
      expect(refusedUnstoppable.error).toContain("a message dispatching");
    }
  });

  test("archive sink admits a PREPARING delegated turn once its interruption has settled", async () => {
    // End to end through a real session: the delegated send is PREPARING with its startup
    // registered, the hold exempts it, the engine-side stop cancels it, and the sink accepts
    // only after the aborted turn has unwound (stopStream resolves before that happens).
    const delegated = { taskHandleId: "wt-prep", ownerWorkspaceId: "owner-1", turnId: "turn-prep" };
    const syntheticMessageId = "starting-prep";
    const aiEmitter = new EventEmitter();
    const entered = Promise.withResolvers<void>();
    const abortController = new AbortController();
    // StreamManager.stopStream for a pending start: abort it and deliver the startup abort.
    const stopStream = mock(() => {
      abortController.abort("system");
      aiEmitter.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: syntheticMessageId,
        abortReason: "system",
        metadata: {},
      });
      return Promise.resolve(Ok(undefined));
    });
    const harness = await createAgentSessionHarness({
      workspaceId,
      config: historyConfig,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage: mock(async (request: Parameters<AIService["streamMessage"]>[0]) => {
          // StreamManager registers the pending start before its first await.
          request.onStreamStarting?.(syntheticMessageId);
          entered.resolve();
          await new Promise<void>((resolve) => {
            abortController.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          const completion: TurnCompletion = { status: "aborted", abortReason: "system" };
          return Ok({ messageId: syntheticMessageId, completion: Promise.resolve(completion) });
        }),
        stopStream,
      },
    });
    const internal = workspaceService as unknown as {
      sessions: Map<string, AgentSession>;
      aiService: typeof harness.aiService;
    };
    internal.sessions.set(workspaceId, harness.session);
    internal.aiService = harness.aiService;
    try {
      const sent = harness.session.sendMessage(
        "Summarize",
        {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          muxMetadata: { type: "workspace-turn-task", ...delegated },
        },
        { startStreamInBackground: true }
      );
      await entered.promise;
      // The PREPARING send reads as a queued message to the coarse activity snapshot; the
      // correlation is what tells it apart from user input.
      expect(workspaceService.listLiveWorkspaceActivity(workspaceId).queuedMessages).toBe(true);
      expect(workspaceService.getStoppablePreparingWorkspaceTurn(workspaceId)).toEqual(delegated);

      const refused = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
        queuedDelegatedTurnCount: 0,
        expectedDelegatedTurnCorrelations: [],
      });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("a message dispatching");
      }
      expect(harness.session.isPreparingTurn()).toBe(true);

      const hold = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
        queuedDelegatedTurnCount: 0,
        expectedDelegatedTurnCorrelations: [delegated],
      });
      expect(hold.success).toBe(true);
      if (!hold.success) return;
      try {
        // What interruptWorkspaceTurn does for a running handle. The engine has aborted when
        // this resolves, but the session's aborted turn has not reached policy yet.
        expect((await stopStream()).success).toBe(true);
        expect(harness.session.isPreparingTurn()).toBe(true);

        await workspaceService.waitForIdle(workspaceId);
        expect((await sent).success).toBe(true);
        expect(harness.session.hasActiveOrPendingTurnWork()).toBe(false);
        expect(
          await workspaceService.archive(workspaceId, undefined, { refuseLiveUserActivity: true })
        ).toEqual(Ok({ kind: "archived" }));
      } finally {
        hold.data[Symbol.dispose]();
      }
    } finally {
      internal.sessions.delete(workspaceId);
      await harness.session.dispose();
    }
  });

  test("fork() refuses while the source workspace is being archived", async () => {
    // Source-fork admission pairs with the archive gates: a Coder-stop archive must not stop
    // the dedicated remote workspace mid-clone while a fork shares it.
    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.fork(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
  });

  test("archive() rechecks durably active workflow runs after arming the admission gate", async () => {
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        hasActiveTopLevelWorkflowRunsForWorkspace: mock(() => Promise.resolve(true)),
      })
    );

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("active workflow runs");
    }
  });

  test("archive() refuses when durable spawn records show crash-orphaned background processes", async () => {
    // Simulates the post-unclean-restart state: the manager's in-memory map is empty but a
    // durable spawn record still points at a live nohup/setsid child (probe behavior itself
    // is covered in backgroundProcessManager.test.ts).
    spyOn(backgroundProcessManager, "hasOrphanedRunningBackgroundProcesses").mockResolvedValueOnce(
      true
    );

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("previous app session");
    }
  });

  test("recordExternalEditorOpen refuses while the workspace is being archived", async () => {
    // A crashed prior run may have leaked the shared-session-dir marker; clear it first.
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-refused");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
    // The refused open launched nothing, so its reservation rolls back: a sticky entry would
    // permanently refuse model-driven snapshot/Coder-stop archives after unarchive.
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("recordExternalEditorOpen rejects workspace IDs without a config entry", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Unknown IDs never reach the marker path (which joins the raw ID beneath the sessions
    // directory), closing both stale-ID requests and traversal-crafted IDs.
    const result = await workspaceService.recordExternalEditorOpen("../../etc-trap", "tok-trap");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found");
    }
    let markerExists = true;
    try {
      await fsPromises.access(externalEditorMarkerPath);
    } catch {
      markerExists = false;
    }
    expect(markerExists).toBe(false);
    // The rejected reservation rolled back too.
    expect(await workspaceService.hasUntrackableExternalAppOpen("../../etc-trap")).toBe(false);
  });

  test("recordExternalEditorOpen marks the workspace as having an untrackable app open", async () => {
    // A crashed prior run may have leaked the shared-session-dir marker; clear it first.
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);

    const result = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-marks");
    expect(result.success).toBe(true);
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    // The durable marker outlives this test run; remove it so "not yet opened" assertions in
    // future runs (this fixture shares one session dir) stay deterministic.
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("recordExternalEditorOpenForLaunch rolls back a freshly created marker after a failed launch", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    const admitted = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    expect(admitted.success).toBe(true);
    if (!admitted.success) return;
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    // EditorService failures occur only before its detached spawn (missing executable,
    // unsupported runtime), so nothing launched: the marker this recording created must not
    // permanently refuse future model-driven snapshot/Coder-stop archives.
    await admitted.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("rollbackAfterFailedLaunch removes the marker when every open in a concurrent batch fails", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Two first-time recordings overlap in flight: the second sees the marker written by the
    // first, but that in-flight marker must not masquerade as evidence of a real prior
    // launch — when both launches fail, the whole batch failed and the marker must go.
    const [first, second] = await Promise.all([
      workspaceService.recordExternalEditorOpenForLaunch(workspaceId),
      workspaceService.recordExternalEditorOpenForLaunch(workspaceId),
    ]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    await first.data.rollbackAfterFailedLaunch();
    // One failed launch alone must not delete the marker (the other may still launch).
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);
    await second.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("rollbackRecordedEditorOpen redeems a renderer launch token", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Client-generated token: the renderer knows it even when the recording response is
    // lost, so an ambiguous outcome can still be reconciled.
    const recorded = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-redeem");
    expect(recorded.success).toBe(true);
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    // The renderer's placeholder window was closed before navigation: the deep link provably
    // never launched, so redeeming the token must roll the durable marker back.
    const rolledBack = await workspaceService.rollbackRecordedEditorOpen(workspaceId, "tok-redeem");
    expect(rolledBack.success).toBe(true);
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);

    // Idempotent: redeeming again (or redeeming a token that was never committed) is a
    // safe no-op.
    expect(
      (await workspaceService.rollbackRecordedEditorOpen(workspaceId, "tok-redeem")).success
    ).toBe(true);
    expect(
      (await workspaceService.rollbackRecordedEditorOpen(workspaceId, "tok-never-committed"))
        .success
    ).toBe(true);
  });

  test("rollbackRecordedEditorOpen tombstones a token whose recording is still in flight", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // The renderer saw its recording RPC reject at the transport while the backend handler
    // was still persisting the marker, and rolled back immediately. The not-yet-registered
    // token must not no-op: the handler would then commit a durable marker for a launch the
    // renderer already abandoned, permanently refusing future model-driven archives.
    const pending = workspaceService.recordExternalEditorOpen(workspaceId, "tok-inflight");
    const rolledBack = await workspaceService.rollbackRecordedEditorOpen(
      workspaceId,
      "tok-inflight"
    );
    expect(rolledBack.success).toBe(true);

    const recorded = await pending;
    expect(recorded.success).toBe(false);
    if (!recorded.success) {
      expect(recorded.error).toContain("rolled back");
    }
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("a failed marker persistence does not leave stale ancestry for the next attempt", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Same filesystem hiccup hits both the probe (EACCES -> fail-closed "unknown", so the
    // batch records markerPreexisted: true) and the write. The failed attempt must discard
    // that batch; otherwise the retry below would join it and its rollback would preserve a
    // marker no launch ever backed.
    const accessSpy = spyOn(fsPromises, "access").mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
    );
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))
    );
    try {
      const failed = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
      expect(failed.success).toBe(false);

      const retried = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
      expect(retried.success).toBe(true);
      if (!retried.success) return;
      await retried.data.rollbackAfterFailedLaunch();
      expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
    } finally {
      accessSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test("archive gating stays closed while an editor recording is in flight", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Freeze the recording at its marker write: the pending-recording count must keep the
    // untrackable-app probe true for the whole in-flight window even though no durable
    // marker or cache entry exists yet (a concurrent rollback may have collapsed them).
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementationOnce(async () => {
      await writeGate;
    });
    try {
      const pending = workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
      expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

      releaseWrite();
      const admitted = await pending;
      expect(admitted.success).toBe(true);
      if (!admitted.success) return;
      // Clean up: the gated write never created a real marker, so a failed-launch rollback
      // clears the in-memory record.
      await admitted.data.rollbackAfterFailedLaunch();
      expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("rollbackAfterFailedLaunch preserves a marker that predates the recording", async () => {
    // An earlier session's editor may still be running behind a pre-existing marker; a later
    // failed launch must not delete the evidence protecting it.
    await fsPromises.mkdir("/tmp/test/sessions", { recursive: true });
    await fsPromises.writeFile(externalEditorMarkerPath, "earlier session");

    const admitted = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    expect(admitted.success).toBe(true);
    if (!admitted.success) return;
    await admitted.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("rollbackAfterFailedLaunch preserves the marker while another open holds launch evidence", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    const failing = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    expect(failing.success).toBe(true);
    // A deep-link open recorded meanwhile launches in the renderer unconditionally; its
    // evidence must keep protecting the marker when the custom-editor launch fails.
    const deepLink = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-deep-link");
    expect(deepLink.success).toBe(true);
    if (!failing.success) return;

    await failing.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("archive waits for a retained background-init settlement before proceeding", async () => {
    // Aborting init only signals: the fire-and-forget init hook process settles later, and
    // snapshot capture / checkout deletion / Coder hooks must not run under its writes.
    let releaseInit!: () => void;
    const settlement = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (workspaceService as any).initSettlementPromises.set(workspaceId, settlement);

    let archiveSettled = false;
    const archivePromise = workspaceService.archive(workspaceId).then((result) => {
      archiveSettled = true;
      return result;
    });
    // Generous scheduling room: without the settlement await, this mock-backed archive
    // completes within these turns and the assertion below goes red.
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(archiveSettled).toBe(false);

    releaseInit();
    expect(await archivePromise).toEqual(Ok({ kind: "archived" }));
  });

  test("resumeStream refuses while the workspace is being archived", async () => {
    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    } satisfies SendMessageOptions);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      if (result.error.type === "unknown") {
        expect(result.error.raw).toContain("being archived");
      }
    }
  });

  test("resumeStream refuses archived workspaces", async () => {
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry).toBeDefined();
    if (entry) {
      entry.archivedAt = "2026-01-01T00:00:00.000Z";
    }

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    } satisfies SendMessageOptions);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      if (result.error.type === "unknown") {
        expect(result.error.raw).toContain("archived");
      }
    }
  });
});

describe("WorkspaceService archive init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("emits metadata when it cancels init but beforeArchive hook fails", async () => {
    const workspaceId = "ws-archive-init-cancel";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws-archive-init-cancel";

    const initStates = new Map<string, InitStatus>([
      [
        workspaceId,
        {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        },
      ],
    ]);

    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
      deleteInitStatus: mock(() => Promise.resolve()),
    };

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    const editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const frontendMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      namedWorkspacePath: workspacePath,
    };

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([frontendMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };

    const mockAIService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      new ContextManagementService({
        config: mockConfig as Config,
        historyService,
        aiService: mockAIService,
      }),
      mockInitStateManager as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );

    // Seed abort controller so archive() can cancel init.
    const abortController = new AbortController();
    const initAbortControllers = (
      workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
    ).initAbortControllers;
    initAbortControllers.set(workspaceId, abortController);

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

    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    // Ensure we didn't persist archivedAt on hook failure.
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();

    expect(abortController.signal.aborted).toBe(true);
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

    expect(metadataEvents.length).toBeGreaterThanOrEqual(1);
    expect(metadataEvents.at(-1)?.isInitializing).toBe(undefined);
  });
});

describe("WorkspaceService unarchive lifecycle hooks", () => {
  const workspaceId = "ws-unarchive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                archivedAt: "2020-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test.each([
    ["shared", "interrupted", "owner"],
    ["isolated", "queued", undefined],
  ] as const)(
    "unarchiving a legacy archived %s queued child leaves its task status %s",
    async (_kind, expectedStatus, taskDesktopOwnerWorkspaceId) => {
      const project = configState.projects.get(projectPath);
      if (!project) throw new Error("project fixture must exist");
      project.workspaces.unshift({ path: "/tmp/project/owner", id: "owner" });
      Object.assign(project.workspaces[1], {
        parentWorkspaceId: "owner",
        taskStatus: "queued",
        ...(taskDesktopOwnerWorkspaceId !== undefined ? { taskDesktopOwnerWorkspaceId } : {}),
      });

      expect(await workspaceService.unarchive(workspaceId)).toEqual(Ok(undefined));

      // Records archived before archive-time settlement must not resurface as a second active
      // controller in the same edit that makes them visible again.
      const entry = project.workspaces.find((w) => w.id === workspaceId);
      expect(entry?.unarchivedAt).toBeTruthy();
      expect(entry?.taskStatus).toBe(expectedStatus);
    }
  );

  test("persists unarchivedAt and runs afterUnarchive hooks (best-effort)", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.unarchivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterUnarchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("does not run afterUnarchive hooks when workspace is not archived", async () => {
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    if (!entry) {
      throw new Error("Missing workspace entry");
    }
    entry.archivedAt = undefined;

    const hooks = new WorkspaceLifecycleHooks();
    const afterHook = mock(() => Promise.resolve(Ok(undefined)));
    hooks.registerAfterUnarchive(afterHook);
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(0);
  });
  test("unarchiving with missing managed worktree does not recreate the directory", async () => {
    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(
      await fsPromises
        .access(workspacePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(entry?.path).toBe(workspacePath);
  });
});

describe("WorkspaceService archive snapshots", () => {
  const workspaceId = "ws-archive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-archive-snapshot",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archive() persists captured snapshot metadata together with archivedAt", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.worktreeArchiveSnapshot).toEqual(snapshot);
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: undefined,
    });
  });

  test("archive() stops cached MCP servers before snapshot capture", async () => {
    const order: string[] = [];
    const stopServers = mock(
      (_workspaceId: string, _options?: { retainRestartOptions?: boolean }) => {
        order.push("stop-mcp");
        return Promise.resolve();
      }
    );
    workspaceService.setMCPServerManager({ stopServers } as unknown as MCPServerManager);
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [],
    };
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => {
        order.push("capture");
        return Promise.resolve(Ok(snapshot));
      }),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    // Removal-style stop (no retainRestartOptions) so its stop epoch retires in-flight startups.
    expect(stopServers).toHaveBeenCalledWith(workspaceId);
    expect(order).toEqual(["stop-mcp", "capture"]);
  });

  test("in-flight MCP prompt discovery holds the model-facing archive gate until released", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const admission = workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId);
    expect(admission).toBeDefined();

    const refused = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain("an MCP prompt discovery in progress");
    }
    expect(configState.projects.get(projectPath)?.workspaces[0]?.archivedAt).toBeUndefined();

    admission![Symbol.dispose]();

    const afterRelease = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    if (!afterRelease.success) {
      expect(afterRelease.error).not.toContain("MCP prompt discovery");
    }
  });

  test("acquireMcpPromptDiscoveryAdmission refuses archiving and archived workspaces", () => {
    addToArchivingWorkspaces(workspaceService, workspaceId);
    expect(workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId)).toBeUndefined();

    // Discovery on an archived workspace would re-wake its runtime; refuse it durably too.
    const archivedService = createWorkspaceServiceForTest({
      config: {
        srcDir: "/tmp/src",
        sessionsDir: "/tmp/test/sessions",
        loadConfigOrDefault: mock(() => ({
          projects: new Map([
            [
              projectPath,
              {
                workspaces: [
                  {
                    path: workspacePath,
                    id: workspaceId,
                    name: "ws-archive-snapshot",
                    archivedAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          ]),
        })),
      } as unknown as Config,
      historyService,
    });
    expect(archivedService.acquireMcpPromptDiscoveryAdmission(workspaceId)).toBeUndefined();
    expect(archivedService.acquireMcpPromptDiscoveryAdmission("ws-other")).toBeDefined();
  });

  test("archive() does not close live sessions when archive readiness checks fail", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    workspaceService.setTerminalService({
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService);

    const closeDesktopSession = mock(() => Promise.resolve(undefined));
    workspaceService.setDesktopSessionManager({
      close: closeDesktopSession,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager);

    const stopServers = mock(() => Promise.resolve());
    workspaceService.setMCPServerManager({ stopServers } as unknown as MCPServerManager);

    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Err("snapshot failed"))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Err("snapshot failed"));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
    expect(closeDesktopSession).not.toHaveBeenCalled();
    expect(stopServers).not.toHaveBeenCalled();
  });

  test("archive() skips snapshot capture for multi-project workspaces", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const multiProjectMetadata = {
      ...workspaceMetadata,
      projects: [
        { projectPath, projectName: "proj" },
        { projectPath: "/tmp/project-b", projectName: "proj-b" },
      ],
    } satisfies WorkspaceMetadata;
    const aiService = workspaceService as unknown as { aiService: AIService };
    aiService.aiService.getWorkspaceMetadata = mock(() =>
      Promise.resolve(Ok(multiProjectMetadata))
    );

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive() aborts when snapshot capture fails", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("snapshot failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("snapshot failed");
    }
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
    expect(entry?.worktreeArchiveSnapshot).toBeUndefined();
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
  });

  test("unarchive reconciles workflow attention only after snapshot restoration", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const order: string[] = [];
    const noteWorkspaceUnarchived = mock((_workspaceId: string) => {
      order.push("reconcile");
      return Promise.resolve();
    });
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ noteWorkspaceUnarchived })
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Ok(snapshot))),
      restoreSnapshotAfterUnarchive: mock(() => {
        order.push("restore");
        return Promise.resolve(Ok("skipped" as const));
      }),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    expect((await workspaceService.archive(workspaceId)).success).toBe(true);
    expect((await workspaceService.unarchive(workspaceId)).success).toBe(true);
    // The reconciliation drain can admit a synthetic agent turn, which must never run
    // against a half-restored checkout.
    expect(order).toEqual(["restore", "reconcile"]);
  });

  test("a failed snapshot restoration skips workflow attention reconciliation", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const noteWorkspaceUnarchived = mock((_workspaceId: string) => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ noteWorkspaceUnarchived })
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Ok(snapshot))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Err("restore failed"))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    expect((await workspaceService.archive(workspaceId)).success).toBe(true);
    const result = await workspaceService.unarchive(workspaceId);
    expect(result.success).toBe(false);
    // The failed restoration rolled the unarchive back; reconciling would admit a synthetic
    // turn into a workspace that is still archived.
    expect(noteWorkspaceUnarchived).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService preflightArchive and acknowledged archive", () => {
  const workspaceId = "ws-preflight-archive";
  const projectPath = "/tmp/project-preflight";
  const workspacePath = "/tmp/project-preflight/ws-preflight-archive";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-preflight-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-preflight-archive",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) return null;
        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("preflightArchive returns ready for scratch workspaces under snapshot behavior", async () => {
    // Scratch chats run on the plain local runtime, so the worktree snapshot
    // preflight must short-circuit instead of consulting the snapshot service
    // (whose non-worktree path would reject and block archiving).
    const scratchMetadata: WorkspaceMetadata = {
      kind: "scratch",
      id: workspaceId,
      name: "ws-preflight-archive",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-preflight-archive",
      runtimeConfig: { type: "local" },
    };
    (workspaceService as unknown as { aiService: AIService }).aiService.getWorkspaceMetadata = mock(
      () => Promise.resolve(Ok(scratchMetadata))
    );
    const getUnsupportedUntrackedPaths = mock(() =>
      Promise.resolve(Err("Archive snapshots are only supported for worktree runtimes"))
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths,
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result).toEqual(Ok({ kind: "ready" }));
    expect(getUnsupportedUntrackedPaths).not.toHaveBeenCalled();
  });

  test("preflightArchive returns ready when no untracked files", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "ready" });
    }
  });

  test("preflightArchive returns confirm-lossy-untracked-files with paths", async () => {
    const untrackedPaths = [".ruff_cache/", "tmp/scratch.txt"];
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        kind: "confirm-lossy-untracked-files",
        paths: untrackedPaths,
      });
    }
  });

  test("preflightArchive returns error when getUnsupportedUntrackedPaths fails", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Err("Failed to check: dirty submodule"))
      ),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("dirty submodule");
    }
  });

  test("archive with matching acknowledgedUntrackedPaths succeeds", async () => {
    const untrackedPaths = [".cache/", "temp.txt"];
    const snapshot: WorktreeArchiveSnapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-preflight-archive",
          headSha: "abc123",
          baseSha: "def456",
          trunkBranch: "main",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.archive(workspaceId, untrackedPaths);

    expect(result).toEqual(Ok({ kind: "archived" }));
    // The capture should have been called with acknowledgedUntrackedPaths.
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: untrackedPaths,
    });
  });

  test("archive returns refreshed confirmation when capture detects new untracked files", async () => {
    const captureSnapshotForArchive = mock(() =>
      Promise.resolve(
        Err({
          kind: "confirm-lossy-untracked-files" as const,
          paths: [".cache/", "new-file.txt"],
        })
      )
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/", "temp.txt"]))),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt"],
      })
    );
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: [".cache/", "temp.txt"],
    });
  });

  test("archive returns refreshed confirmation when acknowledged paths drift before capture", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Ok([".cache/", "new-file.txt", "temp.txt"]))
      ),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt", "temp.txt"],
      })
    );
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive without acknowledgedUntrackedPaths returns confirmation for untracked files", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/"]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "confirm-lossy-untracked-files", paths: [".cache/"] }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService unarchive snapshot restore", () => {
  const workspaceId = "ws-unarchive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-unarchive-snapshot",
                archivedAt: "2020-01-01T00:00:00.000Z",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
                worktreeArchiveSnapshot: {
                  version: 1,
                  capturedAt: "2026-03-30T00:00:00.000Z",
                  stateDirPath: "archive-state",
                  projects: [
                    {
                      projectPath,
                      projectName: "proj",
                      storageKey: "proj",
                      branchName: "ws-unarchive-snapshot",
                      trunkBranch: "main",
                      baseSha: "base-sha",
                      headSha: "head-sha",
                    },
                  ],
                },
              },
            ],
          },
        ],
      ]),
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("unarchive() returns Err when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() rolls back legacy path-only entries when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const config = workspaceService as unknown as { config: Config };
    await config.config.editConfig((currentConfig) => {
      const workspaceEntry = currentConfig.projects.get(projectPath)?.workspaces[0];
      if (!workspaceEntry) {
        throw new Error("Missing workspace entry");
      }
      delete workspaceEntry.id;
      return currentConfig;
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() invokes snapshot restore when snapshot metadata is present", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Ok("restored" as const)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(restoreSnapshotAfterUnarchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
    });
  });
});

describe("WorkspaceService archiveMergedInProject", () => {
  const TARGET_PROJECT_PATH = "/tmp/project";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  function createMetadata(
    id: string,
    options?: { projectPath?: string; archivedAt?: string; unarchivedAt?: string }
  ): FrontendWorkspaceMetadata {
    const projectPath = options?.projectPath ?? TARGET_PROJECT_PATH;

    return {
      id,
      name: id,
      projectName: "test-project",
      projectPath,
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(projectPath, id),
      archivedAt: options?.archivedAt,
      unarchivedAt: options?.unarchivedAt,
    };
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function bashToolFailure(error: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: false,
        error,
        exitCode: 1,
        wall_duration_ms: 0,
      },
    };
  }

  function executeBashFailure(error: string): Result<BashToolResult> {
    return { success: false, error };
  }

  type ExecuteBashFn = (
    workspaceId: string,
    script: string,
    options?: {
      timeout_secs?: number;
    }
  ) => Promise<Result<BashToolResult>>;

  type ArchiveFn = (workspaceId: string) => Promise<Result<{ kind: "archived" }>>;

  function archiveSuccess(): Promise<Result<{ kind: "archived" }>> {
    return Promise.resolve(Ok({ kind: "archived" }));
  }

  function createServiceHarness(
    allMetadata: FrontendWorkspaceMetadata[],
    executeBashImpl: ExecuteBashFn,
    archiveImpl: ArchiveFn
  ): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    archiveMock: ReturnType<typeof mock>;
  } {
    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getAllWorkspaceMetadata: mock(() => Promise.resolve(allMetadata)),
    };

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const executeBashMock = mock(executeBashImpl);
    const archiveMock = mock(archiveImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
      archive: typeof archiveMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;
    svc.archive = archiveMock;

    return { workspaceService, executeBashMock, archiveMock };
  }

  test("treats workspaces with later unarchivedAt as eligible", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-merged-unarchived", {
        archivedAt: "2025-01-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
      createMetadata("ws-still-archived", {
        archivedAt: "2025-03-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-merged-unarchived": bashOk('{"state":"MERGED"}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged-unarchived"]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged-unarchived");

    // Should only query GitHub for the workspace that is considered unarchived.
    expect(executeBashMock).toHaveBeenCalledTimes(1);
  });
  test("archives only MERGED workspaces", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-merged"),
      createMetadata("ws-no-pr"),
      createMetadata("ws-other-project", { projectPath: "/tmp/other" }),
      createMetadata("ws-already-archived", { archivedAt: "2025-01-01T00:00:00.000Z" }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-merged": bashOk('{"state":"MERGED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId, script, options) => {
        expect(script).toContain("gh pr view --json state");
        expect(options?.timeout_secs).toBe(15);

        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged"]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged");

    expect(executeBashMock).toHaveBeenCalledTimes(3);
  });

  test("skips no_pr and non-merged states", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-closed"),
      createMetadata("ws-no-pr"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-closed": bashOk('{"state":"CLOSED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-closed", "ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });

  test("records errors for malformed JSON and executeBash failures", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-bad-json"),
      createMetadata("ws-exec-failed"),
      createMetadata("ws-bash-failed"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-bad-json": bashOk("not-json"),
      "ws-exec-failed": executeBashFailure("executeBash failed"),
      "ws-bash-failed": bashToolFailure("gh failed"),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toHaveLength(3);

    const badJsonError = result.data.errors.find((e) => e.workspaceId === "ws-bad-json");
    expect(badJsonError).toBeDefined();
    expect(badJsonError?.error).toContain("Failed to parse gh output");

    const execFailedError = result.data.errors.find((e) => e.workspaceId === "ws-exec-failed");
    expect(execFailedError).toBeDefined();
    expect(execFailedError?.error).toBe("executeBash failed");

    const bashFailedError = result.data.errors.find((e) => e.workspaceId === "ws-bash-failed");
    expect(bashFailedError).toBeDefined();
    expect(bashFailedError?.error).toBe("gh failed");

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });
});
