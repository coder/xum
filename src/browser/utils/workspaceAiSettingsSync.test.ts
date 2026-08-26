import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import {
  getAgentIdKey,
  getModelKey,
  getReasoningModeKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { revertRejectedAgentSwitch } from "./workspaceAiSettingsSync";

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
