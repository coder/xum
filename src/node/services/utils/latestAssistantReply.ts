import type { HistoryService } from "@/node/services/historyService";

/** How many trailing rows to search: replies are recent, and this bounds the read. */
const LATEST_REPLY_SEARCH_ROWS = 50;

/**
 * Text of a workspace's newest assistant message with visible text, or null when there is none
 * (or history is unreadable). Used to report what a workspace said once it went idle.
 */
export async function readLatestAssistantReply(
  historyService: Pick<HistoryService, "getLastMessages">,
  workspaceId: string
): Promise<{ text: string; messageId: string } | null> {
  const result = await historyService.getLastMessages(workspaceId, LATEST_REPLY_SEARCH_ROWS);
  if (!result.success) return null;
  for (const message of result.data.toReversed()) {
    if (message.role !== "assistant") continue;
    const text = message.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (text.length > 0) return { text, messageId: message.id };
  }
  return null;
}
