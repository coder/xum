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

// Merge/delete semantics for programmatic workspace tags (modeled on
// workspaceService.goalDefaults.test.ts). Invariants under test:
//   - merge updates preserve unrelated keys
//   - null value deletes a key
//   - the tags record is dropped entirely when the last key is removed
//   - unknown workspaces fail without persisting anything

const TEST_WORKSPACE_ID = "test-ws";
const TEST_WORKSPACE_PATH = "/test/path";
const TEST_PROJECT_PATH = "/test/project";

function createWorkspace(tags?: Record<string, string>): Workspace {
  return {
    id: TEST_WORKSPACE_ID,
    path: TEST_WORKSPACE_PATH,
    name: "test",
    ...(tags != null ? { tags } : {}),
  } as unknown as Workspace;
}

describe("WorkspaceService.updateTags", () => {
  let currentProjectsConfig: ProjectsConfig;
  let service: WorkspaceService;

  beforeEach(() => {
    const projectConfig: ProjectConfig = { workspaces: [createWorkspace()] };
    currentProjectsConfig = { projects: new Map([[TEST_PROJECT_PATH, projectConfig]]) };

    const mockConfig = {
      loadConfigOrDefault: mock(() => currentProjectsConfig),
      findWorkspace: mock((workspaceId: string) =>
        workspaceId === TEST_WORKSPACE_ID
          ? { workspacePath: TEST_WORKSPACE_PATH, projectPath: TEST_PROJECT_PATH }
          : null
      ),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        currentProjectsConfig = fn(currentProjectsConfig);
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
      {} as ExtensionMetadataService,
      {} as BackgroundProcessManager
    );
    (
      service as unknown as { emitCurrentWorkspaceMetadata: () => Promise<void> }
    ).emitCurrentWorkspaceMetadata = mock(() => Promise.resolve());
  });

  afterEach(() => {
    mock.restore();
  });

  function storedTags(): Record<string, string> | undefined {
    return currentProjectsConfig.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0)?.tags;
  }

  test("merges new keys while preserving existing ones", async () => {
    await service.updateTags(TEST_WORKSPACE_ID, { workItemKey: "issue-1" });
    const result = await service.updateTags(TEST_WORKSPACE_ID, { stage: "investigate" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual({ workItemKey: "issue-1", stage: "investigate" });
    }
    expect(storedTags()).toEqual({ workItemKey: "issue-1", stage: "investigate" });
  });

  test("null deletes a key; removing the last key drops the record", async () => {
    await service.updateTags(TEST_WORKSPACE_ID, { workItemKey: "issue-1", stage: "investigate" });
    const afterDelete = await service.updateTags(TEST_WORKSPACE_ID, { stage: null });
    expect(afterDelete.success).toBe(true);
    expect(storedTags()).toEqual({ workItemKey: "issue-1" });

    await service.updateTags(TEST_WORKSPACE_ID, { workItemKey: null });
    expect(storedTags()).toBeUndefined();
  });

  test("fails for unknown workspaces without persisting", async () => {
    const result = await service.updateTags("missing", { workItemKey: "x" });
    expect(result.success).toBe(false);
    expect(storedTags()).toBeUndefined();
  });

  test("fails instead of silently succeeding when no config entry matches the id", async () => {
    // findWorkspace can match legacy entries via metadata fallback while the
    // config entry lacks the id; updateTags must report the miss, not Ok({}).
    const project = currentProjectsConfig.projects.get(TEST_PROJECT_PATH);
    if (!project) throw new Error("test project missing");
    const legacyEntry: Workspace = { ...project.workspaces[0], id: "different-id" };
    project.workspaces[0] = legacyEntry;

    const result = await service.updateTags(TEST_WORKSPACE_ID, { workItemKey: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not found/i);
    }
    expect(storedTags()).toBeUndefined();
  });
});
