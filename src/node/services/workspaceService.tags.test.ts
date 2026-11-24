import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import path from "path";
import type { Workspace } from "@/common/types/project";
import { saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

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
  };
}

describe("WorkspaceService.updateTags", () => {
  let harness: WorkspaceServiceHarness;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    await saveWorkspaces(harness.config, TEST_PROJECT_PATH, [createWorkspace()]);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function storedTags(): Record<string, string> | undefined {
    return harness.config.loadConfigOrDefault().projects.get(TEST_PROJECT_PATH)?.workspaces.at(0)
      ?.tags;
  }

  test("merges new keys while preserving existing ones", async () => {
    await harness.service.updateTags(TEST_WORKSPACE_ID, { workItemKey: "issue-1" });
    const result = await harness.service.updateTags(TEST_WORKSPACE_ID, { stage: "investigate" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual({ workItemKey: "issue-1", stage: "investigate" });
    }
    expect(storedTags()).toEqual({ workItemKey: "issue-1", stage: "investigate" });
  });

  test("null deletes a key; removing the last key drops the record", async () => {
    await harness.service.updateTags(TEST_WORKSPACE_ID, {
      workItemKey: "issue-1",
      stage: "investigate",
    });
    const afterDelete = await harness.service.updateTags(TEST_WORKSPACE_ID, { stage: null });
    expect(afterDelete.success).toBe(true);
    expect(storedTags()).toEqual({ workItemKey: "issue-1" });

    await harness.service.updateTags(TEST_WORKSPACE_ID, { workItemKey: null });
    expect(storedTags()).toBeUndefined();
  });

  test("fails for unknown workspaces without persisting", async () => {
    const result = await harness.service.updateTags("missing", { workItemKey: "x" });
    expect(result.success).toBe(false);
    expect(storedTags()).toBeUndefined();
  });

  test("fails instead of silently succeeding when no config entry matches the id", async () => {
    // findWorkspace can match a legacy (id-less) entry through its session
    // metadata.json while no config entry carries the id; updateTags must
    // report the miss, not Ok({}).
    const legacyDir = "legacy-dir";
    await saveWorkspaces(harness.config, TEST_PROJECT_PATH, [
      { path: path.join(TEST_PROJECT_PATH, legacyDir), name: legacyDir },
    ]);
    const sessionDir = path.join(harness.config.sessionsDir, legacyDir);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "metadata.json"),
      JSON.stringify({
        id: TEST_WORKSPACE_ID,
        name: legacyDir,
        projectName: "project",
        projectPath: TEST_PROJECT_PATH,
      })
    );
    expect(harness.config.findWorkspace(TEST_WORKSPACE_ID)).not.toBeNull();

    const result = await harness.service.updateTags(TEST_WORKSPACE_ID, { workItemKey: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not found/i);
    }
    expect(storedTags()).toBeUndefined();
  });
});
