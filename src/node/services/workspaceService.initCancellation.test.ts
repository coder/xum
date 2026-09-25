import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config, SecretsStore } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import type { InitStateManager, InitStatus } from "./initStateManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { WorkspaceServiceArgs, MockWorkspaceConfig } from "./workspaceService.testHarness";
import {
  createCompactionAdmissionMocks,
  mockInitStateManager,
  mockExtensionMetadataService,
  createTestBackgroundProcessManager,
  createWorkspaceServiceForTest,
} from "./workspaceService.testHarness";

describe("WorkspaceService init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("scratch workspace deletion preserves shared workdirs until the last reference", async () => {
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const parentId = "1111111111";
    const childId = "2222222222";
    const configWithStableId = config as unknown as { generateStableId: () => string };
    configWithStableId.generateStableId = () => parentId;

    const aiService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = (await config.getAllWorkspaceMetadata()).find(
          (workspace) => workspace.id === workspaceId
        );
        return metadata ? Ok(metadata) : Err("not found");
      }),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        aiService,
      });
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
    } finally {
      await cleanup();
    }
  });

  test("new scratch workspaces opt in with distinct generations and a later opt-out persists", async () => {
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const aiService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        aiService,
      });
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
    } finally {
      await cleanup();
    }
  });

  test("scratch removal refuses to delete a workdir the workspace does not own", async () => {
    // A stale or hand-edited config entry can point at another chat's dir
    // under the scratch root; removal must not recursively delete it.
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const victimId = "3333333333";
    const malformedId = "4444444444";
    const configWithStableId = config as unknown as { generateStableId: () => string };
    configWithStableId.generateStableId = () => victimId;

    const aiService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = (await config.getAllWorkspaceMetadata()).find(
          (workspace) => workspace.id === workspaceId
        );
        return metadata ? Ok(metadata) : Err("not found");
      }),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        aiService,
      });
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
    } finally {
      await cleanup();
    }
  });

  test("createScratch rejects when policy disallows the local runtime", async () => {
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const policyService = {
      isEnforced: mock(() => true),
      isRuntimeAllowed: mock(() => false),
    } as unknown as WorkspaceServiceArgs[8];

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        policyService,
      });

      const result = await workspaceService.createScratch("Blocked scratch");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not allowed by policy");
      }
      // No config entry or workdir may be left behind by the rejected create.
      expect((await config.getAllWorkspaceMetadata()).length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("create() rejects untrusted projects", async () => {
    const projectPath = "/tmp/proj";
    const generateStableIdMock = mock(() => "ws-untrusted");

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: generateStableIdMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: false,
            },
          ],
        ]),
      })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const result = await workspaceService.create(projectPath, "ws-branch", undefined, "title", {
      type: "local",
    });

    expect(result).toEqual(
      Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      )
    );
    expect(generateStableIdMock).not.toHaveBeenCalled();
  });

  test("create() rejects slash branches whose sanitized workspace name already exists", async () => {
    const projectPath = "/tmp/proj";
    const generateStableIdMock = mock(() => "ws-conflict");
    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: generateStableIdMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [{ id: "existing", name: "feature-foo", path: "/tmp/proj/feature-foo" }],
              trusted: true,
            },
          ],
        ]),
      })),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });

    const result = await workspaceService.create(projectPath, "feature/foo", undefined, "title", {
      type: "local",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Branch "feature/foo"');
      expect(result.error).toContain('workspace name "feature-foo"');
    }
    expect(generateStableIdMock).not.toHaveBeenCalled();
  });

  test("archive() aborts init and still archives when init is running", async () => {
    const workspaceId = "ws-init-running";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "running",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        })
      ),
      clearInMemoryState: clearInMemoryStateMock,
      deleteInitStatus: mock(() => Promise.resolve()),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() uses normal archive flow when init is complete", async () => {
    const workspaceId = "ws-init-complete";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "success",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: 0,
          endTime: 1,
        })
      ),
      clearInMemoryState: mock((_workspaceId: string) => undefined),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("list() includes isInitializing when init state is running", async () => {
    const workspaceId = "ws-list-initializing";

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local" },
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string): InitStatus | undefined =>
        id === workspaceId
          ? {
              status: "running",
              hookPath: "/tmp/proj",
              startTime: 0,
              lines: [],
              exitCode: null,
              endTime: null,
            }
          : undefined
      ),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const list = await workspaceService.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.isInitializing).toBe(true);
  });

  test("create() clears init state + emits updated metadata when skipping background init", async () => {
    const workspaceId = "ws-skip-init";
    const projectPath = "/tmp/proj";
    const branchName = "ws_branch";
    const workspacePath = "/tmp/proj/ws_branch";

    const initStates = new Map<string, InitStatus>();
    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: branchName,
      title: "title",
      projectName: "proj",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
    };

    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: true,
            },
          ],
        ]),
      })),
    };

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

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
      const workspaceService = createWorkspaceServiceForTest({
        config: mockConfig,
        historyService,
        aiService: mockAIService,
        initStateManager: mockInitStateManager as InitStateManager,
        secretsStore: {
          getEffectiveSecrets: mock(() => [{ key: "GH_TOKEN", value: "token" }]),
        } as unknown as SecretsStore,
      });

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

      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({ env: { GH_TOKEN: "token" } })
      );
      expect(result.data.metadata.isInitializing).toBe(undefined);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(metadataEvents).toHaveLength(2);
      expect(metadataEvents[0]?.isInitializing).toBe(true);
      expect(metadataEvents[1]?.isInitializing).toBe(undefined);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("create() auto-generates a workspace branch name when none is provided", async () => {
    // /new mirrors /fork's seamless flow: callers no longer have to invent a
    // workspace name. The backend should derive the next "workspace-N" slot
    // and persist `pendingAutoTitle` so the first message can title the workspace.
    const workspaceId = "ws-auto-named";
    const projectPath = "/tmp/proj-auto";
    const workspacePath = "/tmp/proj-auto/workspace-3";

    const initStates = new Map<string, InitStatus>();
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: mock((id: string) => {
        initStates.delete(id);
      }),
    };

    // Two pre-existing workspaces — auto-naming should skip past them. loadConfigOrDefault
    // returns the same state editConfig mutates, so post-write re-reads see real writes.
    const configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { id: "x", name: "workspace-1", path: "/tmp/proj-auto/workspace-1" },
              { id: "y", name: "workspace-2", path: "/tmp/proj-auto/workspace-2" },
            ],
            trusted: true,
          },
        ],
      ]),
    };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "workspace-3",
      projectName: "proj-auto",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
      pendingAutoTitle: true,
    };

    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => configState),
    };

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    try {
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
        mockExtensionMetadataService as ExtensionMetadataService,
        createTestBackgroundProcessManager(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore
      );

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
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
        consentDuringSanitize.push(
          configState.projects.get(projectPath)?.workspaces.find((entry) => entry.id === id)
            ?.unrelatedWorkspaceConsent
        );
        return Promise.resolve(undefined);
      });

      const result = await workspaceService.create(
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
      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "workspace-3",
          directoryName: "workspace-3",
        })
      );

      const persisted = configState.projects.get(projectPath)?.workspaces ?? [];
      const newEntry = persisted.find((entry) => entry.id === workspaceId);
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
      createRuntimeSpy.mockRestore();
    }
  });

  test("create() with skipDefaultUnrelatedWorkspaceConsent leaves the workspace opted out", async () => {
    // /new mirrors /fork's seamless flow: callers no longer have to invent a
    // workspace name. The backend should derive the next "workspace-N" slot
    // and persist `pendingAutoTitle` so the first message can title the workspace.
    const workspaceId = "ws-auto-named";
    const projectPath = "/tmp/proj-auto";
    const workspacePath = "/tmp/proj-auto/workspace-3";

    const initStates = new Map<string, InitStatus>();
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: mock((id: string) => {
        initStates.delete(id);
      }),
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "workspace-3",
      projectName: "proj-auto",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
      pendingAutoTitle: true,
    };

    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => null),
      // Two pre-existing workspaces — auto-naming should skip past them.
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [
                { id: "x", name: "workspace-1", path: "/tmp/proj-auto/workspace-1" },
                { id: "y", name: "workspace-2", path: "/tmp/proj-auto/workspace-2" },
              ],
              trusted: true,
            },
          ],
        ]),
      })),
    };

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    try {
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
        mockExtensionMetadataService as ExtensionMetadataService,
        createTestBackgroundProcessManager(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore
      );

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
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
        consentDuringSanitize.push(
          configState.projects.get(projectPath)?.workspaces.find((entry) => entry.id === id)
            ?.unrelatedWorkspaceConsent
        );
        return Promise.resolve(undefined);
      });

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
      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "workspace-3",
          directoryName: "workspace-3",
        })
      );

      const persisted = configState.projects.get(projectPath)?.workspaces ?? [];
      const newEntry = persisted.find((entry) => entry.id === workspaceId);
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
      createRuntimeSpy.mockRestore();
    }
  });

  test("remove() aborts init and clears state before teardown", async () => {
    const workspaceId = "ws-remove-aborts";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-"));
    try {
      const abortController = new AbortController();
      const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
      const mockInitStateManager = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: clearInMemoryStateMock,
      } as unknown as InitStateManager;

      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "na" })),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        new ContextManagementService({
          config: mockConfig as Config,
          historyService,
          aiService: mockAIService,
        }),
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        createTestBackgroundProcessManager()
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(initAbortControllers.has(workspaceId)).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("remove() does not clear init state when runtime deletion fails with force=false", async () => {
    const workspaceId = "ws-remove-runtime-delete-fails";
    const projectPath = "/tmp/proj";

    const abortController = new AbortController();
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
    const mockInitStateManager = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      clearInMemoryState: clearInMemoryStateMock,
    } as unknown as InitStateManager;
    const removeWorkspaceMock = mock(() => Promise.resolve());

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: false as const, error: "dirty" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-fail-"));
    try {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: MockWorkspaceConfig = {
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        new ContextManagementService({
          config: mockConfig as Config,
          historyService,
          aiService: mockAIService,
        }),
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        createTestBackgroundProcessManager()
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(abortController.signal.aborted).toBe(true);

      // If runtime deletion fails with force=false, removal returns early and the workspace remains.
      // Keep init state intact so init-end can refresh metadata and clear isInitializing.
      expect(clearInMemoryStateMock).not.toHaveBeenCalled();
      expect(removeWorkspaceMock).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
  test("remove() holds turn admission on the session until removal settles", async () => {
    const workspaceId = "ws-remove-holds-admission";
    const projectPath = "/tmp/proj";

    let releases = 0;
    let releasesWhenRuntimeDeleted = -1;
    const deleteWorkspaceMock = mock(() => {
      releasesWhenRuntimeDeleted = releases;
      return Promise.resolve({ success: false as const, error: "dirty" });
    });
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-hold-"));
    try {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;
      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };
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
        mockExtensionMetadataService as ExtensionMetadataService,
        createTestBackgroundProcessManager()
      );

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
      expect(holdTurnAdmission).toHaveBeenCalledTimes(1);
      // Held across the runtime deletion, released once the failed removal settles so the
      // still-configured workspace stays usable.
      expect(releasesWhenRuntimeDeleted).toBe(0);
      expect(releases).toBe(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
  test("remove() calls runtime.deleteWorkspace when force=true", async () => {
    const workspaceId = "ws-remove-runtime-delete";
    const projectPath = "/tmp/proj";

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-runtime-"));
    try {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };
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
        mockExtensionMetadataService as ExtensionMetadataService,
        createTestBackgroundProcessManager()
      );

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // trusted defaults to false (no project config), so deleteWorkspace gets (path, name, force, undefined, false)
      expect(deleteWorkspaceMock).toHaveBeenCalledWith(projectPath, "ws", true, undefined, false);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
