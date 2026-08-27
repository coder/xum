import { describe, expect, test } from "bun:test";
import type { ORPCClient } from "./serverConnection";
import {
  sendAcpWorkspaceMessage,
  updateAcpWorkspaceAgentAISettings,
} from "./workspaceAiSettingsSync";

describe("ACP workspace AI settings writes", () => {
  test("preserves initiation order across sends and settings updates", async () => {
    let resolveSend!: () => void;
    const sendCommit = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const started: string[] = [];
    let persistedAgentId = "plan";
    const client = {
      workspace: {
        sendMessage: async (input: { options: { agentId?: string } }) => {
          started.push(input.options.agentId ?? "missing");
          await sendCommit;
          persistedAgentId = input.options.agentId ?? persistedAgentId;
          return { success: true as const, data: {} };
        },
        updateAgentAISettings: (input: { agentId: string }) => {
          started.push(input.agentId);
          persistedAgentId = input.agentId;
          return Promise.resolve({ success: true as const, data: undefined });
        },
      },
    } as unknown as ORPCClient;

    const planSend = sendAcpWorkspaceMessage(client, {
      workspaceId: "workspace-1",
      message: "Plan",
      options: { agentId: "plan", model: "openai:plan", thinkingLevel: "high" },
    });
    const execUpdate = updateAcpWorkspaceAgentAISettings(client, {
      workspaceId: "workspace-1",
      agentId: "exec",
      aiSettings: { model: "openai:exec", thinkingLevel: "medium" },
      persistSelectedAgentId: true,
    });

    await Promise.resolve();
    expect(started).toEqual(["plan"]);

    resolveSend();
    await Promise.all([planSend, execUpdate]);

    expect(started).toEqual(["plan", "exec"]);
    expect(persistedAgentId).toBe("exec");
  });
});
