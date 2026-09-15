import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import type { ProjectConfig, ProjectsConfig, Workspace } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";

// Round-trip + edge-case tests for the per-workspace goal-defaults override.
// Modeled on workspaceService.heartbeatSettings.test.ts so the two
// override-style settings test the same invariants:
//   - sparse override fields persist independently
//   - all-null override drops the record entirely
//   - reads return a normalized {field: value|null} shape
//   - no-op writes don't churn the workspace config

const TEST_WORKSPACE_ID = "test-ws";
const TEST_WORKSPACE_PATH = "/test/path";
const TEST_PROJECT_PATH = "/test/project";

function createProjectsConfig(workspace: Workspace): ProjectsConfig {
  const projectConfig: ProjectConfig = {
    workspaces: [workspace],
  };
  return {
    projects: new Map([[TEST_PROJECT_PATH, projectConfig]]),
  };
}

function createWorkspace(
  goalDefaults?: {
    defaultBudgetCents?: number | null;
    defaultTurnCap?: number | null;
    alwaysRequireExplicitBudget?: boolean | null;
  } | null
): Workspace {
  return {
    id: TEST_WORKSPACE_ID,
    path: TEST_WORKSPACE_PATH,
    name: "test",
    ...(goalDefaults != null ? { goalDefaults } : {}),
  } as unknown as Workspace;
}

describe("WorkspaceService goal-defaults override", () => {
  let currentProjectsConfig: ProjectsConfig;
  let mockConfig: Config;
  let service: WorkspaceService;
  let saveConfigCalls: number;

  beforeEach(() => {
    saveConfigCalls = 0;
    currentProjectsConfig = createProjectsConfig(createWorkspace(null));

    mockConfig = {
      loadConfigOrDefault: mock(() => currentProjectsConfig),
      findWorkspace: mock(() => ({
        workspacePath: TEST_WORKSPACE_PATH,
        projectPath: TEST_PROJECT_PATH,
      })),
      // Goal-defaults writes mutate inside serialized editConfig transforms (saveConfig
      // is private); mirror that by applying the transform and counting queued writes.
      editConfig: mock((transform: (config: ProjectsConfig) => ProjectsConfig) => {
        currentProjectsConfig = transform(currentProjectsConfig);
        saveConfigCalls += 1;
        return Promise.resolve();
      }),
    } as unknown as Config;

    const historyService = {} as unknown as HistoryService;
    const aiService = new EventEmitter() as unknown as AIService;
    service = new WorkspaceService(
      mockConfig,
      historyService,
      aiService,
      new ContextManagementService({ config: mockConfig, historyService, aiService }),
      new EventEmitter() as unknown as InitStateManager,
      {
        updateRecency: mock(() =>
          Promise.resolve({
            recency: Date.now(),
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: null,
          })
        ),
      } as unknown as ExtensionMetadataService,
      {} as BackgroundProcessManager
    );
    (
      service as unknown as { emitCurrentWorkspaceMetadata: () => Promise<void> }
    ).emitCurrentWorkspaceMetadata = mock(() => Promise.resolve());
  });

  afterEach(() => {
    mock.restore();
  });

  test("getWorkspaceGoalDefaults returns null when no override is set", () => {
    expect(service.getWorkspaceGoalDefaults(TEST_WORKSPACE_ID)).toBeNull();
  });

  test("persists a partial override and round-trips through get", async () => {
    const result = await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 1500,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(true);
    expect(service.getWorkspaceGoalDefaults(TEST_WORKSPACE_ID)).toEqual({
      defaultBudgetCents: 1500,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    const stored = currentProjectsConfig.projects
      .get(TEST_PROJECT_PATH)
      ?.workspaces.at(0)?.goalDefaults;
    expect(stored).toEqual({
      defaultBudgetCents: 1500,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
  });

  test("persists a fully-populated override (budget + turn cap + explicit-budget)", async () => {
    await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 500,
      defaultTurnCap: 12,
      alwaysRequireExplicitBudget: false,
    });
    expect(service.getWorkspaceGoalDefaults(TEST_WORKSPACE_ID)).toEqual({
      defaultBudgetCents: 500,
      defaultTurnCap: 12,
      alwaysRequireExplicitBudget: false,
    });
  });

  test("all-null override clears any stored record entirely", async () => {
    // Prime an override first so we can verify the cleanup path.
    await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 999,
      defaultTurnCap: 4,
      alwaysRequireExplicitBudget: true,
    });
    expect(service.getWorkspaceGoalDefaults(TEST_WORKSPACE_ID)).not.toBeNull();

    const result = await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: null,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(true);
    expect(service.getWorkspaceGoalDefaults(TEST_WORKSPACE_ID)).toBeNull();
    const stored = currentProjectsConfig.projects
      .get(TEST_PROJECT_PATH)
      ?.workspaces.at(0)?.goalDefaults;
    expect(stored).toBeUndefined();
  });

  test("no-op writes are short-circuited (no saveConfig call)", async () => {
    await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 200,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    const baseline = saveConfigCalls;

    // Identical second write should not bump saveConfigCalls — keeps
    // ~/.mux/config.json untouched + avoids spurious metadata emits.
    const result = await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 200,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(true);
    expect(saveConfigCalls).toBe(baseline);
  });

  test("rejects negative budget input", async () => {
    const result = await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: -1,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive turn cap", async () => {
    const result = await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: null,
      defaultTurnCap: 0,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(false);
  });

  test("returns Err when workspace cannot be located", async () => {
    (mockConfig.findWorkspace as unknown as ReturnType<typeof mock>).mockImplementation(() => null);
    const result = await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 100,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(false);
  });
});
