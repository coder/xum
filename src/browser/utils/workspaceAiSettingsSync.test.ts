import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import {
  getAgentIdKey,
  getModelKey,
  getReasoningModeKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { APIClient } from "@/browser/contexts/API";
import {
  clearPendingWorkspaceAgentId,
  markPendingWorkspaceAgentId,
  revertRejectedAgentSwitch,
  sendWorkspaceMessage,
  shouldApplyWorkspaceAgentIdFromBackend,
  updateWorkspaceAgentAISettings,
} from "./workspaceAiSettingsSync";

const WORKSPACE_ID = "ws-revert";

function makeMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: WORKSPACE_ID,
    projectPath: "/tmp/project",
    projectName: "project",
    name: "main",
    namedWorkspacePath: `/tmp/project/${WORKSPACE_ID}`,
    createdAt: "2025-01-01T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/.mux/src" },
    ...overrides,
  };
}

function seed(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function read(key: string): unknown {
  const raw = window.localStorage.getItem(key);
  return raw == null ? null : JSON.parse(raw);
}

describe("workspace agent persistence guard", () => {
  test("retains the latest selection until every older write settles", () => {
    markPendingWorkspaceAgentId(WORKSPACE_ID, "plan");
    markPendingWorkspaceAgentId(WORKSPACE_ID, "review");

    // The latest echo applies, but it must not consume the only ordering guard.
    expect(shouldApplyWorkspaceAgentIdFromBackend(WORKSPACE_ID, "review")).toBe(true);
    expect(shouldApplyWorkspaceAgentIdFromBackend(WORKSPACE_ID, "plan")).toBe(false);

    // Even when the latest write settles first, the older write can still echo.
    clearPendingWorkspaceAgentId(WORKSPACE_ID, "review");
    expect(shouldApplyWorkspaceAgentIdFromBackend(WORKSPACE_ID, "plan")).toBe(false);

    clearPendingWorkspaceAgentId(WORKSPACE_ID, "plan");
    expect(shouldApplyWorkspaceAgentIdFromBackend(WORKSPACE_ID, "plan")).toBe(true);
  });

  test("commits settings updates and sends in initiation order", async () => {
    let resolvePlan!: () => void;
    const planCommit = new Promise<void>((resolve) => {
      resolvePlan = resolve;
    });
    const started: string[] = [];
    let persistedAgentId = "exec";
    const api = {
      workspace: {
        updateAgentAISettings: async (
          input: Parameters<APIClient["workspace"]["updateAgentAISettings"]>[0]
        ) => {
          started.push(input.agentId);
          await planCommit;
          persistedAgentId = input.agentId;
          return { success: true as const, data: undefined };
        },
        sendMessage: (input: Parameters<APIClient["workspace"]["sendMessage"]>[0]) => {
          started.push(input.options.agentId ?? "missing");
          persistedAgentId = input.options.agentId ?? persistedAgentId;
          return Promise.resolve({ success: true as const, data: {} });
        },
      },
    };

    const planWrite = updateWorkspaceAgentAISettings(api, {
      workspaceId: WORKSPACE_ID,
      agentId: "plan",
      aiSettings: { model: "openai:plan", thinkingLevel: "high" },
      persistSelectedAgentId: true,
    });
    const execSend = sendWorkspaceMessage(api, {
      workspaceId: WORKSPACE_ID,
      message: "Implement the plan",
      options: { agentId: "exec", model: "openai:exec", thinkingLevel: "medium" },
    });

    await Promise.resolve();
    expect(started).toEqual(["plan"]);
    expect(persistedAgentId).toBe("exec");

    resolvePlan();
    await Promise.all([planWrite, execSend]);

    expect(started).toEqual(["plan", "exec"]);
    expect(persistedAgentId).toBe("exec");
  });
});

describe("revertRejectedAgentSwitch", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("hydrates the backend bucket when the backend already stores the rejected agent", () => {
    // A transport-failed switch previously left the renderer diverged; the
    // user switched back to the backend's agent, carrying over unpriced
    // settings, and that write was rejected. Identity needs no change, but
    // the settings must still restore from the backend's own bucket.
    seed(getAgentIdKey(WORKSPACE_ID), "exec");
    seed(getModelKey(WORKSPACE_ID), "openai:unpriced-x");
    seed(getThinkingLevelKey(WORKSPACE_ID), "high");
    seed(getReasoningModeKey(WORKSPACE_ID), "standard");

    revertRejectedAgentSwitch({
      workspaceId: WORKSPACE_ID,
      rejectedAgentId: "exec",
      applied: { model: "openai:unpriced-x", thinkingLevel: "high", reasoningMode: "standard" },
      previous: {
        agentId: "plan",
        model: "openai:unpriced-x",
        thinkingLevel: "high",
        reasoningMode: "standard",
      },
      backendMetadata: makeMetadata({
        agentId: "exec",
        aiSettingsByAgent: { exec: { model: "openai:priced", thinkingLevel: "low" } },
      }),
    });

    expect(read(getAgentIdKey(WORKSPACE_ID))).toBe("exec");
    expect(read(getModelKey(WORKSPACE_ID))).toBe("openai:priced");
    expect(read(getThinkingLevelKey(WORKSPACE_ID))).toBe("low");
    expect(read(getReasoningModeKey(WORKSPACE_ID))).toBe("standard");
  });

  test("falls back to the legacy shared blob for the restore target's settings", () => {
    seed(getAgentIdKey(WORKSPACE_ID), "exec");
    seed(getModelKey(WORKSPACE_ID), "openai:unpriced-x");
    seed(getThinkingLevelKey(WORKSPACE_ID), "high");

    revertRejectedAgentSwitch({
      workspaceId: WORKSPACE_ID,
      rejectedAgentId: "exec",
      applied: { model: "openai:unpriced-x", thinkingLevel: "high", reasoningMode: "standard" },
      previous: {
        agentId: "plan",
        model: "openai:unpriced-x",
        thinkingLevel: "high",
        reasoningMode: "standard",
      },
      backendMetadata: makeMetadata({
        agentId: "exec",
        aiSettings: { model: "openai:legacy-priced", thinkingLevel: "off" },
      }),
    });

    expect(read(getModelKey(WORKSPACE_ID))).toBe("openai:legacy-priced");
    expect(read(getThinkingLevelKey(WORKSPACE_ID))).toBe("off");
  });

  test("atomically hydrates another agent after the rejected agent was edited", () => {
    seed(getAgentIdKey(WORKSPACE_ID), "plan");
    // The user edits plan's model while its persistence request is in flight.
    // Reverting identity to exec must not leave that plan model in the shared composer.
    seed(getModelKey(WORKSPACE_ID), "openai:user-picked-for-plan");
    seed(getThinkingLevelKey(WORKSPACE_ID), "high");
    seed(getReasoningModeKey(WORKSPACE_ID), "standard");

    revertRejectedAgentSwitch({
      workspaceId: WORKSPACE_ID,
      rejectedAgentId: "plan",
      applied: { model: "openai:unpriced-x", thinkingLevel: "high", reasoningMode: "standard" },
      previous: {
        agentId: "exec",
        model: "openai:old-exec",
        thinkingLevel: "off",
        reasoningMode: "standard",
      },
      backendMetadata: makeMetadata({
        agentId: "exec",
        aiSettingsByAgent: {
          exec: { model: "openai:priced-exec", thinkingLevel: "low", reasoningMode: "pro" },
        },
      }),
    });

    expect(read(getAgentIdKey(WORKSPACE_ID))).toBe("exec");
    expect(read(getModelKey(WORKSPACE_ID))).toBe("openai:priced-exec");
    expect(read(getThinkingLevelKey(WORKSPACE_ID))).toBe("low");
    expect(read(getReasoningModeKey(WORKSPACE_ID))).toBe("pro");
  });

  test("newer user edits are never clobbered by the revert", () => {
    seed(getAgentIdKey(WORKSPACE_ID), "exec");
    // The user picked a different model after the rejected switch wrote its
    // settings; only keys still holding the applied values may be restored.
    seed(getModelKey(WORKSPACE_ID), "openai:user-picked");
    seed(getThinkingLevelKey(WORKSPACE_ID), "high");

    revertRejectedAgentSwitch({
      workspaceId: WORKSPACE_ID,
      rejectedAgentId: "exec",
      applied: { model: "openai:unpriced-x", thinkingLevel: "high", reasoningMode: "standard" },
      previous: {
        agentId: "plan",
        model: "openai:old",
        thinkingLevel: "off",
        reasoningMode: "standard",
      },
      backendMetadata: makeMetadata({
        agentId: "exec",
        aiSettingsByAgent: { exec: { model: "openai:priced", thinkingLevel: "low" } },
      }),
    });

    expect(read(getModelKey(WORKSPACE_ID))).toBe("openai:user-picked");
    expect(read(getThinkingLevelKey(WORKSPACE_ID))).toBe("low");
  });
});
