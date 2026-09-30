import { describe, expect, mock, test } from "bun:test";

import { Ok } from "@/common/types/result";
import type { HeartbeatToolArgs, HeartbeatToolResult } from "@/common/types/tools";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type {
  WorkspaceHeartbeatSettingsUpdate,
  WorkspaceHeartbeatToolService,
} from "@/common/utils/tools/tools";
import { HEARTBEAT_DEFAULT_CONTEXT_MODE } from "@/constants/heartbeat";
import { createHeartbeatTool } from "./heartbeat";
import { createTestToolConfig, mockToolCallOptions, TestTempDir } from "./testHelpers";

type WorkspaceHeartbeatSettings = NonNullable<WorkspaceMetadata["heartbeat"]>;

function createService(initial: WorkspaceHeartbeatSettings | null = null): {
  service: WorkspaceHeartbeatToolService;
  getStored: () => WorkspaceHeartbeatSettings | null;
} {
  let stored = initial;
  const service: WorkspaceHeartbeatToolService = {
    getHeartbeatSettings: mock((workspaceId: string) => {
      expect(workspaceId).toBe("ws-heartbeat");
      return stored;
    }),
    setHeartbeatSettings: mock(
      (workspaceId: string, settings: WorkspaceHeartbeatSettingsUpdate) => {
        expect(workspaceId).toBe("ws-heartbeat");
        const hasMessageUpdate = Object.prototype.hasOwnProperty.call(settings, "message");
        const nextMessage = hasMessageUpdate ? settings.message?.trim() : stored?.message;
        // Mirror the real service's key-presence semantics for the sparse schedule fields.
        const nextTrigger = Object.prototype.hasOwnProperty.call(settings, "trigger")
          ? (settings.trigger ?? undefined)
          : stored?.trigger;
        const nextWhenBusy = Object.prototype.hasOwnProperty.call(settings, "whenBusy")
          ? (settings.whenBusy ?? undefined)
          : stored?.whenBusy;
        stored = {
          enabled: settings.enabled ?? stored?.enabled ?? true,
          intervalMs: settings.intervalMs ?? stored?.intervalMs ?? 15 * 60 * 1000,
          contextMode:
            settings.contextMode ?? stored?.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE,
          ...(nextMessage ? { message: nextMessage } : {}),
          ...(nextTrigger != null ? { trigger: nextTrigger } : {}),
          ...(nextWhenBusy != null ? { whenBusy: nextWhenBusy } : {}),
        };
        return Promise.resolve(Ok(stored));
      }
    ),
    unsetHeartbeatSettings: mock((workspaceId: string) => {
      expect(workspaceId).toBe("ws-heartbeat");
      stored = null;
      return Promise.resolve(Ok(undefined));
    }),
  };
  return { service, getStored: () => stored };
}

async function execute(
  service: WorkspaceHeartbeatToolService | undefined,
  args: HeartbeatToolArgs
): Promise<HeartbeatToolResult> {
  using tempDir = new TestTempDir("heartbeat-tool-test");
  const tool = createHeartbeatTool({
    ...createTestToolConfig(tempDir.path, { workspaceId: "ws-heartbeat" }),
    ...(service ? { workspaceHeartbeatService: service } : {}),
  });
  const result: unknown = await Promise.resolve(tool.execute!(args, mockToolCallOptions));
  return result as HeartbeatToolResult;
}

describe("heartbeat tool", () => {
  test("gets current heartbeat settings for the owning workspace", async () => {
    const current = {
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "compact" as const,
      message: "Review idle work.",
    };
    const { service } = createService(current);

    const result = await execute(service, { action: "get" });

    expect(result).toEqual({
      success: true,
      action: "get",
      configured: true,
      settings: current,
      summary: "Heartbeat is enabled for this workspace at 30 minutes.",
    });
  });

  test("set creates an enabled heartbeat from global defaults", async () => {
    const { service, getStored } = createService(null);

    const result = await execute(service, { action: "set" });

    expect(result.success).toBe(true);
    expect(getStored()).toEqual({
      enabled: true,
      intervalMs: 15 * 60 * 1000,
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
    });
  });

  test("set updates only provided fields and can clear the custom message", async () => {
    const { service, getStored } = createService({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "reset",
      message: "Old custom prompt",
    });

    const result = await execute(service, {
      action: "set",
      intervalMs: 45 * 60 * 1000,
      message: "",
    });

    expect(result.success).toBe(true);
    expect(getStored()).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      contextMode: "reset",
    });
  });

  test("set passes trigger and whenBusy through and null preserves them at the tool layer", async () => {
    const { service, getStored } = createService({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "normal",
    });

    const setResult = await execute(service, {
      action: "set",
      trigger: "interval",
      whenBusy: "tool-end",
    });
    expect(setResult.success).toBe(true);
    expect(getStored()).toMatchObject({ trigger: "interval", whenBusy: "tool-end" });

    // Strict-mode providers emit explicit null for omitted fields: the tool must treat
    // null as "not provided" and preserve the persisted values (only action=unset clears).
    const nullResult = await execute(service, {
      action: "set",
      enabled: false,
      trigger: null,
      whenBusy: null,
    });
    expect(nullResult.success).toBe(true);
    expect(getStored()).toMatchObject({
      enabled: false,
      trigger: "interval",
      whenBusy: "tool-end",
    });
  });

  test("summary mentions the fixed schedule only for the interval trigger", async () => {
    const { service } = createService({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "normal",
      trigger: "interval",
    });

    const intervalResult = await execute(service, { action: "get" });
    expect(intervalResult.success).toBe(true);
    if (!intervalResult.success) {
      throw new Error("Expected get to succeed");
    }
    expect(intervalResult.summary).toContain("fixed schedule");

    const { service: idleService } = createService({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "normal",
    });
    const idleResult = await execute(idleService, { action: "get" });
    expect(idleResult.success).toBe(true);
    if (!idleResult.success) {
      throw new Error("Expected get to succeed");
    }
    expect(idleResult.summary).not.toContain("fixed schedule");
  });

  test("unset removes heartbeat settings", async () => {
    const { service, getStored } = createService({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "normal",
    });

    const result = await execute(service, { action: "unset" });

    expect(result).toEqual({
      success: true,
      action: "unset",
      configured: false,
      settings: null,
      summary: "Heartbeat settings removed for this workspace.",
    });
    expect(getStored()).toBeNull();
  });

  test("returns a typed error when the service is unavailable", async () => {
    const result = await execute(undefined, { action: "get" });

    expect(result).toEqual({ success: false, error: "Heartbeat service is unavailable" });
  });
});
