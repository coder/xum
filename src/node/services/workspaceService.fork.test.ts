import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService, generateForkBranchName, generateForkTitle } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok } from "@/common/types/result";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import type { Config, SecretsStore } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { SessionUsageService } from "./sessionUsageService";
import type { AIService } from "./aiService";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ExperimentsService } from "./experimentsService";
import { awaitPendingBranchSummary } from "./branchSummary";
import type { InitStateManager, InitStatus } from "./initStateManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { createMuxMessage } from "@/common/types/message";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as forkOrchestratorModule from "@/node/services/utils/forkOrchestrator";
import * as runtimeExecHelpers from "@/node/utils/runtime/helpers";
import { WorkspaceGoalService } from "./workspaceGoalService";
import type { MockWorkspaceConfig } from "./workspaceService.testHarness";
import {
  mockExtensionMetadataService,
  mockBackgroundProcessManager,
  createWorkspaceServiceForTest,
  setWorkspaceGoalOk,
} from "./workspaceService.testHarness";

describe("WorkspaceService fork", () => {
  let config: Config;
  let tempDir: string;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({
      config,
      tempDir,
      historyService,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("cleans up init state when orchestrateFork rejects", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = "/tmp/project";

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: sourceWorkspaceId,
            name: "source-branch",
            projectPath: sourceProjectPath,
            projectName: "project",
            runtimeConfig: { type: "local" },
          })
        )
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const startInitMock = mock(() => undefined);
    const endInitMock = mock(() => Promise.resolve());
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: startInitMock,
      endInit: endInitMock,
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      generateStableId: mock(() => newWorkspaceId),
      findWorkspace: mock(() => null),
      sessionsDir: "/tmp/test/sessions",
      loadConfigOrDefault: mock(() => ({
        projects: new Map([[sourceProjectPath, { workspaces: [], trusted: true }]]),
      })),
    };

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
      secretsStore: { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore,
    });

    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockImplementation(
      () => Promise.reject(new Error("runtime explosion"))
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to fork workspace: runtime explosion");
      }

      expect(startInitMock).toHaveBeenCalledWith(newWorkspaceId, sourceProjectPath);
      expect(endInitMock).toHaveBeenCalledWith(newWorkspaceId, -1);

      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      expect(initAbortControllers.has(newWorkspaceId)).toBe(false);
    } finally {
      orchestrateForkSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
    }
  });
  test("fork inherits a paused goal with fresh accounting and gets its own unrelated-message consent", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const forkedWorkspacePath = path.join(sourceProjectPath, "fork-child");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
      unrelatedWorkspaceConsent: "source-consent",
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);
    const parentGoal = await setWorkspaceGoalOk(goalService, {
      workspaceId: sourceWorkspaceId,
      objective: "Keep fork goal",
      budgetCents: 500,
      turnCap: 8,
    });
    await goalService.recordStreamAccounting({
      workspaceId: sourceWorkspaceId,
      costUsd: 1,
      streamOriginKind: "goal_continuation",
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      new ContextManagementService({ config, historyService, aiService: mockAIService }),
      mockInitStateManager as InitStateManager,
      extensionMetadata,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
    workspaceService.setWorkspaceGoalService(goalService);

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    // Record what other task trees could see while goal inheritance (post-registration fork
    // setup) runs; the real inheritance still executes.
    const consentDuringGoalInheritance: unknown[] = [];
    const originalInheritFromFork = goalService.inheritFromFork.bind(goalService);
    const inheritSpy = spyOn(goalService, "inheritFromFork").mockImplementation(
      async (sourceId: string, targetId: string) => {
        consentDuringGoalInheritance.push(
          (await config.getAllWorkspaceMetadata()).find((entry) => entry.id === targetId)
            ?.unrelatedWorkspaceConsent
        );
        return originalInheritFromFork(sourceId, targetId);
      }
    );

    // Record what other task trees could see while registration-time sanitization runs.
    const consentDuringSanitize: unknown[] = [];
    const sanitizeSpy = spyOn(
      workspaceService as unknown as {
        sanitizeStalePluginOverridesForNewWorkspace: (
          workspaceId: string,
          workspacePath: string
        ) => Promise<string | undefined>;
      },
      "sanitizeStalePluginOverridesForNewWorkspace"
    ).mockImplementation(async (workspaceId: string) => {
      consentDuringSanitize.push(
        (await config.getAllWorkspaceMetadata()).find((entry) => entry.id === workspaceId)
          ?.unrelatedWorkspaceConsent
      );
      return undefined;
    });

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }
      // Consent is granted only after sanitization: while it runs the fork is registered but
      // must not be discoverable or wakeable by unrelated agents.
      expect(consentDuringSanitize).toEqual([undefined]);
      // ...nor while the rest of the fork's setup (goal inheritance) is still running.
      expect(consentDuringGoalInheritance).toEqual([undefined]);

      const metadataAfterFork = await config.getAllWorkspaceMetadata();
      expect(
        metadataAfterFork.find((entry) => entry.id === sourceWorkspaceId)?.unrelatedWorkspaceConsent
      ).toBe("source-consent");
      // New root workspaces are opted in by default, but with a fresh generation: sharing the
      // source's value would let a revocation on one workspace be bypassed through the other.
      const forkConsent = metadataAfterFork.find(
        (entry) => entry.id === newWorkspaceId
      )?.unrelatedWorkspaceConsent;
      expect(forkConsent).toBeDefined();
      expect(getValidUnrelatedWorkspaceConsent(forkConsent)).toBe(forkConsent);
      expect(forkConsent).not.toBe("source-consent");
      // The announced metadata matches what was persisted, so the UI switch starts on.
      expect(result.data.metadata.unrelatedWorkspaceConsent).toBe(forkConsent);

      const forkGoal = await goalService.getGoal(newWorkspaceId);
      expect(forkGoal).toMatchObject({
        objective: "Keep fork goal",
        budgetCents: 500,
        turnCap: 8,
        status: "paused",
        costCents: 0,
        turnsUsed: 0,
        attributedChildren: [],
      });
      expect(forkGoal?.goalId).not.toBe(parentGoal.goalId);
      expect(await goalService.getGoal(sourceWorkspaceId)).toMatchObject({
        goalId: parentGoal.goalId,
        status: "active",
        costCents: 100,
        turnsUsed: 1,
      });
    } finally {
      inheritSpy.mockRestore();
      sanitizeSpy.mockRestore();
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("resets forked session usage while preserving copied history", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    // Seed source history with assistant usage so the source cost ledger is non-empty
    // before we fork. The fork should keep this history but not inherit its costs.
    await historyService.appendToHistory(
      sourceWorkspaceId,
      createMuxMessage("assistant-1", "assistant", "Hello", {
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })
    );

    const sessionUsageService = new SessionUsageService(config, historyService);
    const sourceUsage = await sessionUsageService.getSessionUsage(sourceWorkspaceId);
    expect(sourceUsage?.byModel["claude-sonnet-4-20250514"]?.input.tokens).toBe(100);

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      new ContextManagementService({
        config,
        historyService,
        aiService: mockAIService,
        sessionUsageService,
      }),
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager,
      sessionUsageService
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => path.join(sourceProjectPath, "fork-child")),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: path.join(sourceProjectPath, "fork-child"),
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }
      expect(result.data.metadata.forkFamilyBaseName).toBeUndefined();

      const forkedUsage = await sessionUsageService.getSessionUsage(newWorkspaceId);
      expect(forkedUsage).toEqual({ byModel: {}, version: 1 });

      const forkedMessages: string[] = [];
      const historyResult = await historyService.iterateFullHistory(
        newWorkspaceId,
        "forward",
        (chunk) => {
          forkedMessages.push(...chunk.map((message) => message.id));
        }
      );
      expect(historyResult.success).toBe(true);
      expect(forkedMessages).toContain("assistant-1");
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("fork snapshots persisted partials without mutating the source workspace", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const forkedWorkspacePath = path.join(sourceProjectPath, "fork-child");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const sourcePartial = createMuxMessage(
      "assistant-partial",
      "assistant",
      "Waiting on task_await",
      { historySequence: 1 }
    );
    const writePartialResult = await historyService.writePartial(sourceWorkspaceId, sourcePartial);
    expect(writePartialResult.success).toBe(true);

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      new ContextManagementService({ config, historyService, aiService: mockAIService }),
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      const sourcePartialAfterFork = await historyService.readPartial(sourceWorkspaceId);
      expect(sourcePartialAfterFork?.id).toBe(sourcePartial.id);
      expect(await historyService.readPartial(newWorkspaceId)).toBeNull();

      const forkedMessageIds: string[] = [];
      const historyResult = await historyService.iterateFullHistory(
        newWorkspaceId,
        "forward",
        (chunk) => {
          forkedMessageIds.push(...chunk.map((message) => message.id));
        }
      );
      expect(historyResult.success).toBe(true);
      expect(forkedMessageIds).toContain(sourcePartial.id);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("auto-generated fork names normalize legacy fork families before the validation fallback", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "Feature-fork-2",
      title: "Feature branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "Feature-fork-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "feature-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      new ContextManagementService({ config, historyService, aiService: mockAIService }),
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "feature-1",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("feature-1");
      expect(result.data.metadata.forkFamilyBaseName).toBe("Feature");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("auto-generated fork names increment existing fork suffixes instead of nesting them", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch-2",
      title: "Source branch (2)",
      forkFamilyBaseName: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-3");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      new ContextManagementService({ config, historyService, aiService: mockAIService }),
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "source-branch-3",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("source-branch-3");
      expect(result.data.metadata.title).toBe("Source branch (3)");
      expect(result.data.metadata.forkFamilyBaseName).toBe("source-branch");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("fork marks the new workspace as pending auto-title when a continue message is queued", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      title: "Source branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      new ContextManagementService({ config, historyService, aiService: mockAIService }),
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, undefined, undefined, true);

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.pendingAutoTitle).toBe(true);
      const persistedMetadata = (await config.getAllWorkspaceMetadata()).find(
        (metadata) => metadata.id === newWorkspaceId
      );
      expect(persistedMetadata?.pendingAutoTitle).toBe(true);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
});

// --- Pure helper tests (no mocks needed) ---

describe("generateForkBranchName", () => {
  test("returns -1 when no existing forks", () => {
    expect(generateForkBranchName("sidebar-a1b2", [])).toBe("sidebar-a1b2-1");
  });

  test("increments past the highest existing fork number", () => {
    expect(
      generateForkBranchName("sidebar-a1b2", [
        "sidebar-a1b2-1",
        "sidebar-a1b2-3",
        "other-workspace",
      ])
    ).toBe("sidebar-a1b2-4");
  });

  test("continues numbering for generated forks when given the stable family base name", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-2"])).toBe("ws-3");
  });

  test("preserves numeric suffixes for non-fork names", () => {
    expect(generateForkBranchName("release-2024", ["release-1"])).toBe("release-2024-1");
  });

  test("continues numbering across legacy and new fork name patterns", () => {
    expect(generateForkBranchName("ws", ["ws-fork-1", "ws-2", "ws-fork-3"])).toBe("ws-4");
  });

  test("ignores non-matching workspace names", () => {
    expect(generateForkBranchName("feature", ["feature-branch", "feature-impl", "other-1"])).toBe(
      "feature-1"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-5"])).toBe("ws-6");
  });

  test("ignores non-numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-abc", "ws-fork-"])).toBe("ws-1");
  });

  test("ignores partially numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-1abc", "ws-fork-02x", "ws-3"])).toBe("ws-4");
  });
});

describe("generateForkTitle", () => {
  test("returns (1) when no existing forks", () => {
    expect(generateForkTitle("Fix sidebar layout", [])).toBe("Fix sidebar layout (1)");
  });

  test("increments past the highest existing suffix", () => {
    expect(
      generateForkTitle("Fix sidebar layout", [
        "Fix sidebar layout",
        "Fix sidebar layout (1)",
        "Fix sidebar layout (3)",
      ])
    ).toBe("Fix sidebar layout (4)");
  });

  test("strips existing suffix from parent before computing base", () => {
    // Forking "Fix sidebar (2)" should produce "Fix sidebar (3)", not "Fix sidebar (2) (1)"
    expect(generateForkTitle("Fix sidebar (2)", ["Fix sidebar (1)", "Fix sidebar (2)"])).toBe(
      "Fix sidebar (3)"
    );
  });

  test("ignores non-matching titles", () => {
    expect(generateForkTitle("Refactor auth", ["Fix sidebar layout (1)", "Other task (2)"])).toBe(
      "Refactor auth (1)"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkTitle("Task", ["Task (1)", "Task (5)"])).toBe("Task (6)");
  });

  test("ignores non-numeric suffixes when selecting the next title number", () => {
    expect(generateForkTitle("Task", ["Task (2025 roadmap)", "Task (12abc)", "Task (2)"])).toBe(
      "Task (3)"
    );
  });
});

describe("WorkspaceService.fork branch-summary rollback ordering", () => {
  test("a fork whose setup fails never leaves a summary writer or registration behind", async () => {
    // Codex round-11: the background summary writer used to start BEFORE
    // staged-attachment copying and usage reset. Their failure handler
    // deletes newSessionDir without cancelling the registration, so a racing
    // guarded append (tail verified pre-rollback, append landing after)
    // recreated the failed fork's session dir, and the settled entry leaked
    // forever because the fork never returned. The writer now starts only
    // after all failure-prone setup completed.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-fork-src-"));
    const sourceId = "fork-src-ws";
    // Gate the guarded append so the writer (old ordering) is mid-append when
    // the rollback deletes the session dir — Codex's exact race window.
    let releaseAppend: () => void = () => undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const realGuardedAppend = historyService.appendToHistoryIfTailMatches.bind(historyService);
    const guardedAppendSpy = spyOn(
      historyService,
      "appendToHistoryIfTailMatches"
    ).mockImplementation(async (workspaceId, message, tailMessageId) => {
      await appendGate;
      // Model the lost race deterministically: the tail was verified before
      // the rollback, so the append itself lands unconditionally.
      void tailMessageId;
      const result = await historyService.appendToHistory(workspaceId, message);
      return result.success ? Ok("appended" as const) : result;
    });
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [{ path: projectDir, id: sourceId, name: sourceId }],
        });
        return cfg;
      });
      // Meaty abandoned tail (clears BRANCH_SUMMARY_MIN_SEGMENT_TOKENS).
      const filler = "explored the fork rollback race and traced the write path ".repeat(200);
      const branchPoint = createMuxMessage("fork-bp", "assistant", "branch point", {
        timestamp: 1,
      });
      for (const message of [
        createMuxMessage("fork-m1", "user", "original question", { timestamp: 0 }),
        branchPoint,
        createMuxMessage("fork-tail-u", "user", filler, { timestamp: 2 }),
        createMuxMessage("fork-tail-a", "assistant", filler, { timestamp: 3 }),
      ]) {
        expect((await historyService.appendToHistory(sourceId, message)).success).toBe(true);
      }

      const sourceMetadata: WorkspaceMetadata = {
        id: sourceId,
        name: sourceId,
        projectName: "fork-src",
        projectPath: projectDir,
        runtimeConfig: { type: "local" },
      };
      const summaryChunks: LanguageModelV3StreamPart[] = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "The abandoned branch explored a race." },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ];
      const aiService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock((workspaceId: string) =>
          Promise.resolve(
            workspaceId === sourceId ? Ok(sourceMetadata) : Err("workspace not found")
          )
        ),
        createModelWithPinnedMetadata: mock((modelString: string) =>
          Promise.resolve(
            Ok({
              model: new MockLanguageModelV3({
                doStream: () =>
                  Promise.resolve({ stream: simulateReadableStream({ chunks: summaryChunks }) }),
              }),
              metadataModel: modelString,
            })
          )
        ),
      } as unknown as AIService;
      const initStateManager = {
        on: mock(() => undefined),
        off: mock(() => undefined),
        getInitState: mock(() => undefined),
        startInit: mock(() => undefined),
        appendOutput: mock(() => undefined),
        endInit: mock(() => Promise.resolve()),
        enterHookPhase: mock(() => undefined),
        clearInMemoryState: mock(() => undefined),
      } as unknown as InitStateManager;
      // Failure injection: the usage reset (the LAST failure-prone setup
      // step) rejects, driving the fork into its rollback path.
      const sessionUsageService = {
        resetSessionUsage: mock(() => Promise.reject(new Error("usage reset failed"))),
        recordHeadlessUsage: mock(() => Promise.resolve(undefined)),
      } as unknown as SessionUsageService;
      const experimentsService = {
        isExperimentEnabled: (id: string) =>
          id === EXPERIMENT_IDS.RLM || id === EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
      } as unknown as ExperimentsService;

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService,
        initStateManager,
        sessionUsageService,
        experimentsService,
      });
      let newWorkspaceId = "";
      const realGenerateId = config.generateStableId.bind(config);
      const idSpy = spyOn(config, "generateStableId").mockImplementation(() => {
        newWorkspaceId = realGenerateId();
        return newWorkspaceId;
      });
      try {
        const forkResult = await service.fork(sourceId, "fork-rollback-target", "fork-bp");
        expect(forkResult.success).toBe(false);
        if (forkResult.success) return;
        expect(forkResult.error).toContain("Failed to copy fork state");
        expect(newWorkspaceId.length).toBeGreaterThan(0);

        // Unblock any (old-ordering) writer mid-append and let it settle.
        releaseAppend();
        await new Promise((resolve) => setTimeout(resolve, 50));

        // No writer ran, so no registration leaked and the rolled-back
        // session's chat.jsonl was not recreated by a late guarded append.
        expect(await awaitPendingBranchSummary(newWorkspaceId)).toBeNull();
        expect(guardedAppendSpy).not.toHaveBeenCalled();
        const chatFile = path.join(config.sessionsDir, newWorkspaceId, "chat.jsonl");
        const chatExists = await fsPromises.access(chatFile).then(
          () => true,
          () => false
        );
        expect(chatExists).toBe(false);
      } finally {
        idSpy.mockRestore();
      }
    } finally {
      guardedAppendSpy.mockRestore();
      void realGuardedAppend;
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});
