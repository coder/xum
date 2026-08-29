import type { ORPCContext } from "@/node/orpc/context";
import type { MuxMessage } from "@/common/types/message";

export async function calculateWorkspaceStats(
  context: ORPCContext,
  input: { workspaceId: string; messages: MuxMessage[]; model: string }
) {
  const metadata = await context.aiService.getWorkspaceMetadata(input.workspaceId);
  return context.tokenizerService.calculateStats(
    input.workspaceId,
    input.messages,
    input.model,
    context.providerService.getConfig(),
    metadata.success ? (metadata.data.parentWorkspaceId ?? null) : null
  );
}
