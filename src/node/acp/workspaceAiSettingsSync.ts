import { serializeWorkspaceAiSettingsWrite } from "@/common/utils/ai/workspaceAiSettingsWrite";
import type { ORPCClient } from "./serverConnection";

type SendMessageInput = Parameters<ORPCClient["workspace"]["sendMessage"]>[0];
type UpdateAgentAISettingsInput = Parameters<ORPCClient["workspace"]["updateAgentAISettings"]>[0];
type UpdateModeAISettingsInput = Parameters<ORPCClient["workspace"]["updateModeAISettings"]>[0];

export function sendAcpWorkspaceMessage(
  client: ORPCClient,
  input: SendMessageInput
): ReturnType<ORPCClient["workspace"]["sendMessage"]> {
  const send = () => client.workspace.sendMessage(input);
  return input.options.skipAiSettingsPersistence === true
    ? send()
    : serializeWorkspaceAiSettingsWrite(input.workspaceId, send);
}

export function updateAcpWorkspaceAgentAISettings(
  client: ORPCClient,
  input: UpdateAgentAISettingsInput
): ReturnType<ORPCClient["workspace"]["updateAgentAISettings"]> {
  return serializeWorkspaceAiSettingsWrite(input.workspaceId, () =>
    client.workspace.updateAgentAISettings(input)
  );
}

export function updateAcpWorkspaceModeAISettings(
  client: ORPCClient,
  input: UpdateModeAISettingsInput
): ReturnType<ORPCClient["workspace"]["updateModeAISettings"]> {
  return serializeWorkspaceAiSettingsWrite(input.workspaceId, () =>
    client.workspace.updateModeAISettings(input)
  );
}
