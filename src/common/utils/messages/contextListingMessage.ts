import type { MuxMessage } from "@/common/types/message";

/** ID prefix of durable context listing rows (#5248, see node contextListing.ts). */
export const CONTEXT_LISTING_MESSAGE_ID_PREFIX = "context-listing-";

/**
 * A context listing row: model-visible catalog data (memory index, skills, sub-agents, MCP
 * prompts), not conversation. isModelHiddenMessage hides it from every history reader; only
 * provider request assembly (prepareProviderRequestMessages) opts it back in.
 */
export function isContextListingMessage(message: MuxMessage): boolean {
  return message.role === "user" && message.id.startsWith(CONTEXT_LISTING_MESSAGE_ID_PREFIX);
}
