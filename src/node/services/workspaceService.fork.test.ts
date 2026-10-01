import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { generateForkBranchName, generateForkTitle } from "./workspaceService";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok } from "@/common/types/result";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { SessionUsageService } from "./sessionUsageService";
import { ReviewStateService } from "./reviewStateService";
import { DraftService } from "./draftService";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ExperimentsService } from "./experimentsService";
import { awaitPendingBranchSummary } from "./branchSummary";
import { InitStateManager } from "./initStateManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { AgentSession } from "./agentSession";
import { AUTO_RETRY_PREFERENCE_FILE } from "./rejectedTurnRepairRecord";
import * as branchSummaryModule from "./branchSummary";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { RuntimeError } from "@/node/runtime/Runtime";
import * as forkOrchestratorModule from "@/node/services/utils/forkOrchestrator";
import * as runtimeExecHelpers from "@/node/utils/runtime/helpers";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { stageWorkspaceAttachment } from "@/node/utils/attachments/stageWorkspaceAttachment";
import {
  createMockAIService,
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

    // A trusted project with no registered source checkout (findWorkspace misses).
    await config.editConfig((current) => {
      current.projects.set(sourceProjectPath, { workspaces: [], trusted: true });
      return current;
    });
    spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    // Real init manager: the spies record the lifecycle calls while the real state runs.
    const initStateManager = new InitStateManager(config);
    const startInitMock = spyOn(initStateManager, "startInit");
    const endInitMock = spyOn(initStateManager, "endInit");

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: sourceWorkspaceId,
              name: "source-branch",
              projectPath: sourceProjectPath,
              projectName: "project",
              runtimeConfig: { type: "local" as const },
            })
          )
        ),
      }),
      initStateManager,
      extensionMetadata: new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      ),
    });

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
      // The logger fires endInit without awaiting it; settle its persistence before cleanup.
      await endInitMock.mock.results[0]?.value;
      expect(initStateManager.getInitState(newWorkspaceId)?.status).toBe("error");

      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      expect(initAbortControllers.has(newWorkspaceId)).toBe(false);
    } finally {
      orchestrateForkSpy.mockRestore();
      createRuntimeSpy.mockRestore();
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

    const mockAIService = createMockAIService({
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
    });

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: mockAIService,
      extensionMetadata,
    });
    workspaceService.setWorkspaceGoalService(goalService);

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
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
      generateStableIdSpy.mockRestore();
    }
  });

  test("a consent toggle from another backend during fork setup wins over the default (#4446)", async () => {
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
      current.projects.get(sourceProjectPath)!.trusted = true;
      return current;
    });
    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      }),
    });
    // Backend B: its own Config on the same root.
    const backendB = createWorkspaceServiceForTest({ config: new Config(config.rootDir) });
    spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
    spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined);
    spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime: {
          getWorkspacePath: mock(() => forkedWorkspacePath),
        } as unknown as ReturnType<typeof runtimeFactory.createRuntime>,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );
    // The fork is registered; B sees the row and opts it out before A's grant.
    spyOn(
      workspaceService as unknown as {
        sanitizeStalePluginOverridesForNewWorkspace: (...args: unknown[]) => Promise<undefined>;
      },
      "sanitizeStalePluginOverridesForNewWorkspace"
    ).mockImplementation(async () => {
      expect((await backendB.setUnrelatedWorkspaceConsent(newWorkspaceId, false)).success).toBe(
        true
      );
      return undefined;
    });

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(true);
      const forkEntry = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((entry) => entry.id === newWorkspaceId);
      expect(forkEntry?.unrelatedWorkspaceConsent).toBeUndefined();
      expect(forkEntry?.unrelatedWorkspaceConsentPending).toBeUndefined();
      expect(result.success && result.data.metadata.unrelatedWorkspaceConsent).toBeUndefined();
    } finally {
      mock.restore();
    }
  });

  test("a fork that fails after registration leaves no pending default consent behind (#4455)", async () => {
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
      current.projects.get(sourceProjectPath)!.trusted = true;
      return current;
    });
    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      }),
    });
    // Goal inheritance runs after the fork's row (with its pending mark) is registered.
    workspaceService.setWorkspaceGoalService({
      inheritFromFork: mock(() => Promise.reject(new Error("goal store unavailable"))),
    } as unknown as WorkspaceGoalService);
    spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
    spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined);
    spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime: {
          getWorkspacePath: mock(() => forkedWorkspacePath),
        } as unknown as ReturnType<typeof runtimeFactory.createRuntime>,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );
    spyOn(
      workspaceService as unknown as {
        sanitizeStalePluginOverridesForNewWorkspace: (...args: unknown[]) => Promise<undefined>;
      },
      "sanitizeStalePluginOverridesForNewWorkspace"
    ).mockResolvedValue(undefined);

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(false);
      // The failed fork keeps its row today (tracked separately); the default must not stay
      // pending on it, and no consent was granted.
      const forkEntry = [...new Config(config.rootDir).loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((entry) => entry.id === newWorkspaceId);
      expect(forkEntry?.unrelatedWorkspaceConsentPending).toBeUndefined();
      expect(forkEntry?.unrelatedWorkspaceConsent).toBeUndefined();
    } finally {
      mock.restore();
    }
  });

  // #4826: a plan the source runtime could not read must fail the fork through the
  // same cleanup as other fork-state copies, not yield a fork silently missing its plan.
  test("a plan copy that fails in transport fails and cleans up the fork", async () => {
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
      current.projects.get(sourceProjectPath)!.trusted = true;
      return current;
    });
    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      }),
    });
    let initSignal: AbortSignal | undefined;
    const initAbortedAtDelete: boolean[] = [];
    const deleteWorkspace = mock(() => {
      initAbortedAtDelete.push(initSignal?.aborted === true);
      return Promise.resolve({ success: true as const });
    });
    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    spyOn(runtimeFactory, "runBackgroundInit").mockImplementation((_runtime, params) => {
      initSignal = params.abortSignal;
      return Promise.resolve(undefined);
    });
    spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockRejectedValue(
      new RuntimeError("ssh: connect to host dev port 22: Connection refused", "network")
    );
    spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected the fork to fail");
      expect(result.error).toContain("Connection refused");
      // Init is aborted before its checkout is deleted.
      expect(initAbortedAtDelete).toEqual([true]);
      // The creation-state cleanup ran: no session dir (or init status) survives the failure.
      expect(
        await fsPromises.stat(path.join(config.sessionsDir, newWorkspaceId)).catch(() => null)
      ).toBeNull();
    } finally {
      mock.restore();
    }
  });

  test("resets forked session usage while preserving copied history, review state and the draft", async () => {
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

    // Review notes/read state live in the session dir and must follow the fork.
    const reviewStateService = new ReviewStateService(config);
    await reviewStateService.applyDelta(sourceWorkspaceId, {
      hunkExpand: { set: { "hunk-1": true } },
    });

    const sessionUsageService = new SessionUsageService(config, historyService);
    const sourceUsage = await sessionUsageService.getSessionUsage(sourceWorkspaceId);
    expect(sourceUsage?.byModel["claude-sonnet-4-20250514"]?.input.tokens).toBe(100);

    const mockAIService = createMockAIService({
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
    });

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: mockAIService,
      sessionUsageService,
    });

    // The composer draft follows the fork, minus staged attachments (source-worktree paths).
    const draftService = new DraftService(config);
    workspaceService.setDraftForkCopier(draftService);
    const sourceDraftScope = { kind: "workspace" as const, workspaceId: sourceWorkspaceId };
    await draftService.update({
      scope: sourceDraftScope,
      text: "unsent",
      attachments: [
        {
          kind: "provider",
          id: "img",
          url: "data:image/png;base64,AA==",
          mediaType: "image/png",
        },
        {
          kind: "staged",
          id: "staged",
          mediaType: "text/plain",
          filename: "a.txt",
          sizeBytes: 1,
          stagedPath: "/source/worktree/a.txt",
        },
      ],
    });

    const targetRuntime = {
      getWorkspacePath: mock(() => path.join(sourceProjectPath, "fork-child")),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
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

      const forkedReviewState = await reviewStateService.getSnapshot(newWorkspaceId);
      expect(forkedReviewState.sections.hunkExpand).toEqual({ "hunk-1": true });

      const forkedDraft = await draftService.get({
        kind: "workspace",
        workspaceId: newWorkspaceId,
      });
      expect(forkedDraft.text).toBe("unsent");
      expect(forkedDraft.attachments.map(({ id }) => id)).toEqual(["img"]);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  // #4850: once the source checkout lost its git-excluded copy (for example after a snapshot
  // unarchive that did not rehydrate), the mirror is the only copy; the fork's agent still needs
  // the file at its checkout path.
  async function forkWithMirrorOnlyAttachment(
    prepareTarget: (targetCheckout: string) => Promise<void>
  ) {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceCheckout = path.join(tempDir, "source-checkout");
    const targetCheckout = path.join(tempDir, "fork-checkout");
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: tempDir };
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig,
      namedWorkspacePath: sourceCheckout,
    };
    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await fsPromises.mkdir(sourceCheckout, { recursive: true });
    await fsPromises.mkdir(targetCheckout, { recursive: true });
    await prepareTarget(targetCheckout);
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) throw new Error("Expected test project config to exist");
      project.trusted = true;
      return current;
    });

    const bytes = Buffer.from("mirror only");
    const staged = await stageWorkspaceAttachment({
      runtime: new LocalRuntime(sourceCheckout),
      workspacePath: sourceCheckout,
      sessionDir: path.join(config.sessionsDir, sourceWorkspaceId),
      filename: "notes.md",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    if (!staged.success) throw new Error(staged.error);
    await fsPromises.rm(path.join(sourceCheckout, ".xum"), { recursive: true });
    await historyService.appendToHistory(
      sourceWorkspaceId,
      createMuxMessage("user-1", "user", `Attached \`${staged.data.stagedPath}\``)
    );

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      }),
    });
    const spies = [
      spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId),
      spyOn(runtimeFactory, "createRuntime").mockReturnValue(new LocalRuntime(sourceCheckout)),
      spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined),
      spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined),
      spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
        Ok({
          workspacePath: targetCheckout,
          trunkBranch: "main",
          forkedRuntimeConfig: runtimeConfig,
          targetRuntime: new LocalRuntime(targetCheckout),
          forkedFromSource: true,
          sourceRuntimeConfigUpdated: false,
        })
      ),
    ];

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      return { targetCheckout, stagedPath: staged.data.stagedPath, bytes };
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  test("worktree fork materializes a staged attachment from the source mirror", async () => {
    const { targetCheckout, stagedPath, bytes } = await forkWithMirrorOnlyAttachment(() =>
      Promise.resolve()
    );

    expect(await fsPromises.readFile(path.join(targetCheckout, stagedPath))).toEqual(bytes);
  });

  test("worktree fork never writes a mirrored attachment through a symlinked .xum", async () => {
    const outside = path.join(tempDir, "outside");
    await fsPromises.mkdir(outside);
    // The forked checkout is repo-controlled: a tracked `.xum` symlink must not redirect writes.
    await forkWithMirrorOnlyAttachment((targetCheckout) =>
      fsPromises.symlink(outside, path.join(targetCheckout, ".xum"))
    );

    expect(await fsPromises.readdir(outside)).toEqual([]);
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
    // The live stream's empty placeholder row precedes its partial; the fork copies it.
    const placeholderResult = await historyService.appendToHistory(sourceWorkspaceId, {
      ...sourcePartial,
      parts: [],
    });
    expect(placeholderResult.success).toBe(true);
    const writePartialResult = await historyService.writePartial(sourceWorkspaceId, sourcePartial);
    expect(writePartialResult.success).toBe(true);

    const mockAIService = createMockAIService({
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
    });

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: mockAIService,
    });

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
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
      // The snapshot was committed onto the copied placeholder, not dropped.
      const forkedTail = await historyService.getLastMessages(newWorkspaceId, 1);
      expect(forkedTail.success && forkedTail.data[0]?.parts).toEqual(sourcePartial.parts);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  /**
   * A trusted source workspace plus the fork orchestration mocked out, so fork()
   * exercises only its session-directory work (history copy and follow-ups).
   */
  async function createQuarantineForkFixture(sourceWorkspaceId: string, newWorkspaceId: string) {
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
    const isStreaming = mock(() => false);
    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({
        isStreaming,
        getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      }),
    });
    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
      // The relocated copy-failure catch reads the runtime's Result (#4775).
      deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    const spies = [
      spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId),
      spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
        emitMetadata: mock(() => undefined),
      } as unknown as AgentSession),
      spyOn(runtimeFactory, "createRuntime").mockReturnValue(
        {} as ReturnType<typeof runtimeFactory.createRuntime>
      ),
      spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
        Promise.resolve(undefined)
      ),
      spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined),
      spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
        Ok({
          workspacePath: forkedWorkspacePath,
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          targetRuntime,
          forkedFromSource: true,
          sourceRuntimeConfigUpdated: false,
        })
      ),
    ];
    return {
      workspaceService,
      isStreaming,
      sourceRecordPath: path.join(
        config.sessionsDir,
        sourceWorkspaceId,
        AUTO_RETRY_PREFERENCE_FILE
      ),
      restore: () => {
        for (const spy of spies.reverse()) spy.mockRestore();
      },
    };
  }

  test("fork stamps the source's quarantined rejected rows in the copied history", async () => {
    // A late consent refusal whose row stamp failed leaves the rows unstamped in
    // the source, protected only by that workspace's repair record; the copied
    // chat must not launder them into a fork with an empty quarantine.
    const sourceWorkspaceId = "quarantine-source";
    const newWorkspaceId = "quarantine-fork";
    const fixture = await createQuarantineForkFixture(sourceWorkspaceId, newWorkspaceId);
    for (const row of [
      createMuxMessage("snap-refused", "user", "project skill body", {
        timestamp: 1,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "x" },
      }),
      createMuxMessage("u-refused", "user", "refused prompt", { timestamp: 2 }),
      createMuxMessage("u-later", "user", "later prompt", { timestamp: 3 }),
    ]) {
      expect((await historyService.appendToHistory(sourceWorkspaceId, row)).success).toBe(true);
    }
    await fsPromises.writeFile(
      fixture.sourceRecordPath,
      JSON.stringify({ pendingRejectedTurnRepair: { userMessageIds: ["u-refused"] } })
    );
    try {
      const result = await fixture.workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      const forked = await historyService.getHistoryFromLatestBoundary(newWorkspaceId);
      if (!forked.success) throw new Error(forked.error);
      const stamped = forked.data
        .filter((row) => row.metadata?.preStreamRejected === true)
        .map((row) => row.id)
        .sort();
      // The keyed user row AND its snapshot prefix; unrelated rows untouched.
      expect(stamped).toEqual(["snap-refused", "u-refused"]);
      // The source's own repair still owns its rows: nothing was stamped there.
      const source = await historyService.getHistoryFromLatestBoundary(sourceWorkspaceId);
      if (!source.success) throw new Error(source.error);
      expect(source.data.some((row) => row.metadata?.preStreamRejected === true)).toBe(false);
    } finally {
      fixture.restore();
    }
  });

  test("fork refuses while the source prepares a turn or streams a routed skill turn", async () => {
    // The copied rows inherit only the quarantine known at copy time, and a
    // SUCCESSFUL late stamp in the source is never reported by
    // getQuarantinedRejectedRowIds: a turn refused after the copy would leave
    // the fork holding its rows and finalized partial unprotected.
    const sourceWorkspaceId = "turn-guard-source";
    const newWorkspaceId = "turn-guard-fork";
    const fixture = await createQuarantineForkFixture(sourceWorkspaceId, newWorkspaceId);
    // The registered source session is the fork guard's probe target; no public seam
    // registers a stand-in for a session that is mid-turn.
    const internals = fixture.workspaceService as unknown as {
      sessions: Map<string, unknown>;
    };
    let holds = 0;
    let releases = 0;
    let turnActive = true;
    internals.sessions.set(sourceWorkspaceId, {
      holdTurnAdmission: () => {
        holds += 1;
        return {
          [Symbol.dispose]: () => {
            releases += 1;
          },
        };
      },
      hasActiveOrPendingTurnWork: () => turnActive,
      getQuarantinedRejectedRowIds: () => new Set<string>(),
    });
    try {
      // A turn being prepared (active turn work, nothing streaming yet):
      // refused, retryable, the probe hold released.
      const preparing = await fixture.workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(preparing.success).toBe(false);
      if (!preparing.success) expect(preparing.error).toContain("being sent");
      expect([holds, releases]).toEqual([1, 1]);

      // A routed turn streaming with no committed reply: its per-step gate
      // can still refuse and stamp it, so the fork waits for it to settle.
      fixture.isStreaming.mockReturnValue(true);
      expect(
        (
          await historyService.appendToHistory(
            sourceWorkspaceId,
            createMuxMessage("u-routed", "user", "Use skill done", {
              timestamp: 1,
              retrySendOptions: {
                model: "anthropic:claude-haiku-4-5",
                agentId: "exec",
                routedProjectConsent: true,
              },
            })
          )
        ).success
      ).toBe(true);
      const routedStreaming = await fixture.workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(routedStreaming.success).toBe(false);
      if (!routedStreaming.success) expect(routedStreaming.error).toContain("routed skill turn");

      // The empty assistant placeholder a starting stream appends is not a
      // reply: the turn is still in flight and the fork still waits.
      expect(
        (
          await historyService.appendToHistory(
            sourceWorkspaceId,
            createMuxMessage("a-placeholder", "assistant", "", { timestamp: 2 })
          )
        ).success
      ).toBe(true);
      const placeholderOnly = await fixture.workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(placeholderOnly.success).toBe(false);

      // Reply committed: the turn is settled. The fork proceeds and holds the
      // source's turn admission across the copy (probe + copy), releasing it.
      expect(
        (
          await historyService.appendToHistory(
            sourceWorkspaceId,
            createMuxMessage("a-routed", "assistant", "Applied the skill", { timestamp: 2 })
          )
        ).success
      ).toBe(true);
      turnActive = false;
      fixture.isStreaming.mockReturnValue(false);
      const holdsBefore = holds;
      const settled = await fixture.workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(settled.success).toBe(true);
      expect(holds - holdsBefore).toBe(2);
      expect(releases).toBe(holds);
    } finally {
      fixture.restore();
    }
  });

  test("fork refuses when the source's rejected-turn record is unreadable", async () => {
    // Unknown quarantine state: copying the history could carry refused
    // content nobody can identify afterwards, so the fork fails closed.
    const sourceWorkspaceId = "quarantine-source-unreadable";
    const newWorkspaceId = "quarantine-fork-unreadable";
    const fixture = await createQuarantineForkFixture(sourceWorkspaceId, newWorkspaceId);
    expect(
      (
        await historyService.appendToHistory(
          sourceWorkspaceId,
          createMuxMessage("u-only", "user", "prompt", { timestamp: 1 })
        )
      ).success
    ).toBe(true);
    await fsPromises.writeFile(fixture.sourceRecordPath, "{ not json");
    try {
      const result = await fixture.workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("rejected-turn record");
      // The half-built fork's session directory was rolled back.
      const leftover = await fsPromises
        .stat(path.join(config.sessionsDir, newWorkspaceId))
        .catch(() => null);
      expect(leftover).toBeNull();
    } finally {
      fixture.restore();
    }
  });

  test("fork keeps the source's quarantined turn out of the abandoned tail's summary", async () => {
    // Forking from BEFORE the refused turn moves its rows into the removed
    // tail the background summarizer reads (possibly on another provider):
    // the source's quarantine must filter that tail as well as the kept rows.
    const sourceWorkspaceId = "quarantine-source-tail";
    const newWorkspaceId = "quarantine-fork-tail";
    const fixture = await createQuarantineForkFixture(sourceWorkspaceId, newWorkspaceId);
    for (const row of [
      createMuxMessage("u-before", "user", "before the refusal", { timestamp: 1 }),
      createMuxMessage("a-before", "assistant", "answer before", { timestamp: 2 }),
      createMuxMessage("snap-refused", "user", "project skill body", {
        timestamp: 3,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "x" },
      }),
      createMuxMessage("u-refused", "user", "refused prompt", { timestamp: 4 }),
      createMuxMessage("u-after", "user", "after the refusal", { timestamp: 5 }),
    ]) {
      expect((await historyService.appendToHistory(sourceWorkspaceId, row)).success).toBe(true);
    }
    await fsPromises.writeFile(
      fixture.sourceRecordPath,
      JSON.stringify({ pendingRejectedTurnRepair: { userMessageIds: ["u-refused"] } })
    );
    const summarySpy = spyOn(
      branchSummaryModule,
      "startAbandonedBranchSummaryInBackground"
    ).mockResolvedValue(undefined);
    try {
      const result = await fixture.workspaceService.fork(
        sourceWorkspaceId,
        "fork-child",
        "a-before"
      );
      expect(result.success).toBe(true);
      expect(summarySpy).toHaveBeenCalledTimes(1);
      const abandoned = (
        summarySpy.mock.calls[0][0] as { abandonedMessages: MuxMessage[] }
      ).abandonedMessages.map((row) => row.id);
      // The refused turn (prompt and snapshot prefix) is gone; the rest remains.
      expect(abandoned).toEqual(["u-after"]);
      // The summarizer re-verifies the rows against the SOURCE right before
      // its request: a turn refused and stamped after the copy abandons it.
      const { beforeDispatch } = summarySpy.mock.calls[0][0] as {
        beforeDispatch?: () => Promise<boolean>;
      };
      expect(await beforeDispatch?.()).toBe(true);
      expect(
        (await historyService.markMessagesPreStreamRejected(sourceWorkspaceId, ["u-after"])).success
      ).toBe(true);
      expect(await beforeDispatch?.()).toBe(false);
    } finally {
      summarySpy.mockRestore();
      fixture.restore();
    }
  });

  test("fork summary re-verification sees abandoned rows from a sealed archive", async () => {
    // Forking from a message inside an older epoch abandons the rest of that
    // archive plus the active epoch. The pre-dispatch re-verification must
    // read the FULL history, or every pre-boundary fork would silently skip
    // its abandoned-branch summary.
    const sourceWorkspaceId = "archive-source-tail";
    const newWorkspaceId = "archive-fork-tail";
    const fixture = await createQuarantineForkFixture(sourceWorkspaceId, newWorkspaceId);
    for (const row of [
      createMuxMessage("u1", "user", "first prompt", { timestamp: 1 }),
      createMuxMessage("a1", "assistant", "first answer", { timestamp: 2 }),
      createMuxMessage("u1b", "user", "archived follow-up", { timestamp: 3 }),
      createMuxMessage("a1b", "assistant", "archived answer", { timestamp: 4 }),
      createMuxMessage("summary", "assistant", "Summary so far", {
        timestamp: 5,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      }),
      createMuxMessage("u2", "user", "after the boundary", { timestamp: 6 }),
      createMuxMessage("a2", "assistant", "answer after", { timestamp: 7 }),
    ]) {
      expect((await historyService.appendToHistory(sourceWorkspaceId, row)).success).toBe(true);
    }
    const summarySpy = spyOn(
      branchSummaryModule,
      "startAbandonedBranchSummaryInBackground"
    ).mockResolvedValue(undefined);
    try {
      const result = await fixture.workspaceService.fork(sourceWorkspaceId, "fork-child", "a1");
      expect(result.success).toBe(true);
      expect(summarySpy).toHaveBeenCalledTimes(1);
      const call = summarySpy.mock.calls[0][0] as {
        abandonedMessages: MuxMessage[];
        beforeDispatch?: () => Promise<boolean>;
      };
      expect(call.abandonedMessages.map((row) => row.id)).toContain("u1b");
      expect(await call.beforeDispatch?.()).toBe(true);
      expect(
        (await historyService.markMessagesPreStreamRejected(sourceWorkspaceId, ["u2"])).success
      ).toBe(true);
      expect(await call.beforeDispatch?.()).toBe(false);
    } finally {
      summarySpy.mockRestore();
      fixture.restore();
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

    const mockAIService = createMockAIService({
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
    });

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: mockAIService,
    });

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
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

    const mockAIService = createMockAIService({
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
    });

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: mockAIService,
    });

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
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

    const mockAIService = createMockAIService({
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
    });

    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: mockAIService,
    });

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
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
      const aiService = createMockAIService({
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
      });
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
