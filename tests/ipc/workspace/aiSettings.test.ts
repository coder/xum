/**
 * IPC tests for workspace-scoped AI settings persistence.
 *
 * Verifies that model + thinking level can be persisted per workspace and
 * are returned via metadata APIs (list/getInfo).
 */

import { createTestEnvironment, cleanupTestEnvironment } from "../setup";
import type { TestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createWorkspace,
} from "../helpers";
import { resolveOrpcClient } from "../helpers";

describe("workspace.updateAgentAISettings", () => {
  test("persists aiSettingsByAgent and returns them via workspace.getInfo and workspace.list", async () => {
    const env: TestEnvironment = await createTestEnvironment();
    const tempGitRepo = await createTempGitRepo();

    try {
      const branchName = generateBranchName("ai-settings");
      const createResult = await createWorkspace(env, tempGitRepo, branchName);
      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;
      expect(workspaceId).toBeTruthy();

      const client = resolveOrpcClient(env);
      const updateResult = await client.workspace.updateAgentAISettings({
        workspaceId: workspaceId!,
        agentId: "exec",
        aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "xhigh" },
      });
      expect(updateResult.success).toBe(true);

      const info = await client.workspace.getInfo({ workspaceId: workspaceId! });
      expect(info?.aiSettingsByAgent?.exec).toEqual({
        model: "openai:gpt-5.2",
        thinkingLevel: "xhigh",
      });

      const list = await client.workspace.list();
      const fromList = list.find((m) => m.id === workspaceId);
      expect(fromList?.aiSettingsByAgent?.exec).toEqual({
        model: "openai:gpt-5.2",
        thinkingLevel: "xhigh",
      });
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    }
  }, 60000);

  test("keeps ask-scoped settings separate from exec when persisting agent settings", async () => {
    const env: TestEnvironment = await createTestEnvironment();
    const tempGitRepo = await createTempGitRepo();

    try {
      const branchName = generateBranchName("ai-settings-ask");
      const createResult = await createWorkspace(env, tempGitRepo, branchName);
      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;
      expect(workspaceId).toBeTruthy();

      const client = resolveOrpcClient(env);
      const updateResult = await client.workspace.updateAgentAISettings({
        workspaceId: workspaceId!,
        agentId: "ask",
        aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "low" },
      });
      expect(updateResult.success).toBe(true);

      const info = await client.workspace.getInfo({ workspaceId: workspaceId! });
      expect(info?.aiSettingsByAgent?.ask).toEqual({
        model: "anthropic:claude-opus-4-6",
        thinkingLevel: "low",
      });
      expect(info?.aiSettingsByAgent?.exec).toBeUndefined();
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    }
  }, 60000);

  test("preserves explicit gateway model IDs when persisting agent settings", async () => {
    const env: TestEnvironment = await createTestEnvironment();
    const tempGitRepo = await createTempGitRepo();

    try {
      const branchName = generateBranchName("ai-settings-gateway-model");
      const createResult = await createWorkspace(env, tempGitRepo, branchName);
      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;
      expect(workspaceId).toBeTruthy();

      const client = resolveOrpcClient(env);
      const updateResult = await client.workspace.updateAgentAISettings({
        workspaceId: workspaceId!,
        agentId: "exec",
        aiSettings: { model: "openrouter:openai/gpt-5", thinkingLevel: "off" },
      });
      expect(updateResult.success).toBe(true);

      const info = await client.workspace.getInfo({ workspaceId: workspaceId! });
      expect(info?.aiSettingsByAgent?.exec).toEqual({
        model: "openrouter:openai/gpt-5",
        thinkingLevel: "off",
      });

      const list = await client.workspace.list();
      const fromList = list.find((m) => m.id === workspaceId);
      expect(fromList?.aiSettingsByAgent?.exec).toEqual({
        model: "openrouter:openai/gpt-5",
        thinkingLevel: "off",
      });
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    }
  }, 60000);

  test("compaction requests do not override workspace agent settings", async () => {
    const env: TestEnvironment = await createTestEnvironment();
    const tempGitRepo = await createTempGitRepo();

    try {
      const branchName = generateBranchName("ai-settings-compact");
      const createResult = await createWorkspace(env, tempGitRepo, branchName);
      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;
      expect(workspaceId).toBeTruthy();

      const client = resolveOrpcClient(env);

      // Set initial workspace AI settings
      const updateResult = await client.workspace.updateAgentAISettings({
        workspaceId: workspaceId!,
        agentId: "exec",
        aiSettings: { model: "anthropic:claude-sonnet-4-20250514", thinkingLevel: "medium" },
      });
      expect(updateResult.success).toBe(true);

      // Send a compaction request with a different model
      // The muxMetadata type: "compaction-request" should prevent AI settings from being persisted
      await client.workspace.sendMessage({
        workspaceId: workspaceId!,
        message: "Summarize the conversation",
        options: {
          model: "openai:gpt-4.1-mini", // Different model for compaction
          thinkingLevel: "off",
          agentId: "compact",
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
          },
        },
      });

      // Verify the original workspace AI settings were NOT overwritten
      const info = await client.workspace.getInfo({ workspaceId: workspaceId! });
      expect(info?.aiSettingsByAgent?.exec).toEqual({
        model: "anthropic:claude-sonnet-4-20250514",
        thinkingLevel: "medium",
      });
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    }
  }, 60000);
});
