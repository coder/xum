import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import { HEARTBEAT_DEFAULT_CONTEXT_MODE } from "@/constants/heartbeat";
import { saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const TEST_WORKSPACE_ID = "test-ws";
const TEST_WORKSPACE_PATH = "/test/path";
const TEST_PROJECT_PATH = "/test/project";

const LONG_HEARTBEAT_MESSAGE = "Review pending work and summarize next steps. ".repeat(30).trim();

// expect.any returns `any`; pin the matcher's type once so exact-equality object
// literals with the server-managed stamp stay lint-clean (no-unsafe-assignment).
const anyNumber = expect.any(Number) as number;

function createWorkspace(heartbeat: {
  enabled: boolean;
  intervalMs: number;
  message?: string;
  contextMode?: "normal" | "compact" | "reset";
}): Workspace {
  return {
    id: TEST_WORKSPACE_ID,
    path: TEST_WORKSPACE_PATH,
    name: "test",
    heartbeat,
  };
}

describe("WorkspaceService heartbeat settings", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceServiceHarness["service"];

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    service = harness.service;
    await saveWorkspaces(harness.config, TEST_PROJECT_PATH, [
      createWorkspace({
        enabled: true,
        intervalMs: 30 * 60 * 1000,
        message: "Keep this custom heartbeat message.",
      }),
    ]);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  function persistedWorkspaceHeartbeat() {
    return harness.config.loadConfigOrDefault().projects.get(TEST_PROJECT_PATH)?.workspaces.at(0)
      ?.heartbeat;
  }

  /** Rewrites persisted config the way a hand edit or older build would. */
  async function editPersistedConfig(edit: (config: ProjectsConfig) => void): Promise<void> {
    await harness.config.editConfig((config) => {
      edit(config);
      return config;
    });
  }

  test("updates workspace recency when heartbeat settings change", async () => {
    const updateRecencyTimestamp = spyOn(harness.extensionMetadata, "updateRecency");

    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });

    expect(result.success).toBe(true);
    expect(updateRecencyTimestamp).toHaveBeenCalledTimes(1);
    const recencyUpdateCall = updateRecencyTimestamp.mock.calls.at(0);
    expect(recencyUpdateCall?.[0]).toBe(TEST_WORKSPACE_ID);
    expect(typeof recencyUpdateCall?.[1]).toBe("number");
  });

  test("records a timeline row for user-driven heartbeat changes, but not for no-ops", async () => {
    const record = mock<(workspaceId: string, draft: { kind: string }) => void>(() => undefined);
    service.setTimelineRecorder({
      record,
      closeWorkspace: () => Promise.resolve(),
      reopenWorkspace: () => undefined,
    });

    await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });
    expect(record.mock.calls.map((call) => call[1].kind)).toEqual(["heartbeat.configured"]);

    // Re-applying the same settings changes nothing, so it must not add a row.
    await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });
    expect(record).toHaveBeenCalledTimes(1);

    await service.unsetHeartbeatSettings(TEST_WORKSPACE_ID);
    expect(record).toHaveBeenCalledTimes(2);
  });

  test("does not update workspace recency when heartbeat settings do not change", async () => {
    const updateRecencyTimestamp = spyOn(harness.extensionMetadata, "updateRecency");

    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      message: "Keep this custom heartbeat message.",
    });

    expect(result.success).toBe(true);
    expect(updateRecencyTimestamp).not.toHaveBeenCalled();
  });

  test("unsets heartbeat settings and updates workspace recency", async () => {
    const updateRecencyTimestamp = spyOn(harness.extensionMetadata, "updateRecency");

    const result = await service.unsetHeartbeatSettings(TEST_WORKSPACE_ID);

    expect(result.success).toBe(true);
    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toBeUndefined();
    expect(service.getHeartbeatSettings(TEST_WORKSPACE_ID)).toBeNull();
    expect(updateRecencyTimestamp).toHaveBeenCalledTimes(1);
  });

  test("preserves the existing message when a write omits the message field", async () => {
    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });

    expect(result.success).toBe(true);
    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: "Keep this custom heartbeat message.",
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
      // The interval changed (30m → 45m), so the cadence-edit stamp is expected.
      scheduleUpdatedAt: anyNumber,
    });
  });

  test("preserves custom messages longer than 1000 characters without truncation", async () => {
    expect(LONG_HEARTBEAT_MESSAGE.length).toBeGreaterThan(1_000);

    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: LONG_HEARTBEAT_MESSAGE,
    });

    expect(result.success).toBe(true);
    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: LONG_HEARTBEAT_MESSAGE,
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
      scheduleUpdatedAt: anyNumber,
    });
    expect(service.getHeartbeatSettings(TEST_WORKSPACE_ID)).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: LONG_HEARTBEAT_MESSAGE,
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
      scheduleUpdatedAt: anyNumber,
    });
  });

  test("clears the existing message when a write explicitly sends an empty message", async () => {
    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: "",
    });

    expect(result.success).toBe(true);
    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
      scheduleUpdatedAt: anyNumber,
    });
  });

  test("defaults missing context mode to normal on read", () => {
    expect(service.getHeartbeatSettings(TEST_WORKSPACE_ID)).toEqual({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      message: "Keep this custom heartbeat message.",
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
    });
  });

  test("defaults sparse persisted heartbeat intervals to the global default on read", async () => {
    await editPersistedConfig((config) => {
      config.heartbeatDefaultIntervalMs = 45 * 60 * 1000;
      const persistedHeartbeat = config.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0)
        ?.heartbeat as { intervalMs?: number } | undefined;
      if (!persistedHeartbeat) {
        throw new Error("Expected persisted heartbeat settings");
      }
      delete persistedHeartbeat.intervalMs;
    });

    expect(service.getHeartbeatSettings(TEST_WORKSPACE_ID)).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: "Keep this custom heartbeat message.",
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
    });
  });

  test("round-trips trigger and whenBusy and preserves them when a write omits the keys", async () => {
    const setResult = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      trigger: "interval",
      whenBusy: "tool-end",
    });
    expect(setResult.success).toBe(true);
    expect(service.getHeartbeatSettings(TEST_WORKSPACE_ID)).toMatchObject({
      trigger: "interval",
      whenBusy: "tool-end",
    });

    // An update without the keys preserves the persisted values.
    const omitResult = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      intervalMs: 50 * 60 * 1000,
    });
    expect(omitResult.success).toBe(true);
    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toMatchObject({
      intervalMs: 50 * 60 * 1000,
      trigger: "interval",
      whenBusy: "tool-end",
    });
  });

  test("explicit null clears trigger and whenBusy back to unset", async () => {
    const setResult = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      trigger: "interval",
      whenBusy: "skip",
    });
    expect(setResult.success).toBe(true);

    const clearResult = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      trigger: null,
      whenBusy: null,
    });
    expect(clearResult.success).toBe(true);

    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toBeDefined();
    expect(Object.keys(persistedHeartbeat!)).not.toContain("trigger");
    expect(Object.keys(persistedHeartbeat!)).not.toContain("whenBusy");
  });

  test("unset trigger/whenBusy are never materialized into config by unrelated writes", async () => {
    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });
    expect(result.success).toBe(true);

    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toBeDefined();
    expect(Object.keys(persistedHeartbeat!)).not.toContain("trigger");
    expect(Object.keys(persistedHeartbeat!)).not.toContain("whenBusy");
    const readBack = service.getHeartbeatSettings(TEST_WORKSPACE_ID);
    expect(readBack).not.toBeNull();
    expect(Object.keys(readBack!)).not.toContain("trigger");
    expect(Object.keys(readBack!)).not.toContain("whenBusy");
  });

  test("stamps scheduleUpdatedAt on cadence edits and preserves it on cosmetic edits", async () => {
    const before = Date.now();
    // Trigger change is cadence-affecting: the fixed schedule re-anchors at the edit.
    const triggerResult = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      trigger: "interval",
    });
    expect(triggerResult.success).toBe(true);
    const readPersisted = persistedWorkspaceHeartbeat;
    const stamped = readPersisted()?.scheduleUpdatedAt;
    expect(typeof stamped).toBe("number");
    expect(stamped!).toBeGreaterThanOrEqual(before);

    // A message-only edit is cosmetic: the cadence anchor must survive unchanged, or a
    // restart would defer the next firing past a schedule the user never edited.
    const messageResult = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      message: "Different cosmetic message.",
    });
    expect(messageResult.success).toBe(true);
    expect(readPersisted()?.scheduleUpdatedAt).toBe(stamped);

    // An interval change re-stamps.
    const intervalResult = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      intervalMs: 45 * 60 * 1000,
    });
    expect(intervalResult.success).toBe(true);
    expect(readPersisted()?.scheduleUpdatedAt).toBeGreaterThanOrEqual(stamped!);
  });

  test("an explicit no-op trigger write does not stamp scheduleUpdatedAt", async () => {
    // null → "idle" resolves to the same trigger, so the cadence did not change even
    // though the persisted shape did; the live path would not re-anchor either.
    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      trigger: "idle",
    });
    expect(result.success).toBe(true);
    const persistedHeartbeat = persistedWorkspaceHeartbeat();
    expect(persistedHeartbeat).toMatchObject({ trigger: "idle" });
    expect(Object.keys(persistedHeartbeat!)).not.toContain("scheduleUpdatedAt");
  });

  test("rejects invalid trigger and whenBusy values", async () => {
    const invalidTrigger = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      trigger: "hourly" as never,
    });
    expect(invalidTrigger.success).toBe(false);

    const invalidWhenBusy = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      whenBusy: "interrupt" as never,
    });
    expect(invalidWhenBusy.success).toBe(false);
  });

  test("persists an explicit heartbeat context mode", async () => {
    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      contextMode: "compact",
    });

    expect(result.success).toBe(true);
    expect(service.getHeartbeatSettings(TEST_WORKSPACE_ID)).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: "Keep this custom heartbeat message.",
      contextMode: "compact",
      scheduleUpdatedAt: anyNumber,
    });
  });
});
