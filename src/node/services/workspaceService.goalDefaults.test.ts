import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Workspace } from "@/common/types/project";
import { saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

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

function createWorkspace(): Workspace {
  return { id: TEST_WORKSPACE_ID, path: TEST_WORKSPACE_PATH, name: "test" };
}

describe("WorkspaceService goal-defaults override", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceServiceHarness["service"];

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    service = harness.service;
    await saveWorkspaces(harness.config, TEST_PROJECT_PATH, [createWorkspace()]);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function storedGoalDefaults() {
    return harness.config.loadConfigOrDefault().projects.get(TEST_PROJECT_PATH)?.workspaces.at(0)
      ?.goalDefaults;
  }

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
    expect(storedGoalDefaults()).toEqual({
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
    expect(storedGoalDefaults()).toBeUndefined();
  });

  test("no-op writes are short-circuited (no saveConfig call)", async () => {
    const editConfig = spyOn(harness.config, "editConfig");
    await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 200,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    const baseline = editConfig.mock.calls.length;

    // Identical second write should not queue another editConfig — keeps
    // ~/.mux/config.json untouched + avoids spurious metadata emits.
    const result = await service.setWorkspaceGoalDefaults(TEST_WORKSPACE_ID, {
      defaultBudgetCents: 200,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(true);
    expect(editConfig.mock.calls.length).toBe(baseline);
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
    const result = await service.setWorkspaceGoalDefaults("missing-ws", {
      defaultBudgetCents: 100,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(result.success).toBe(false);
  });
});
