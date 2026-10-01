import type { MuxMessage } from "@/common/types/message";
import type { HistoryService } from "@/node/services/historyService";

/** Wall-clock allowance for the newest-first walk; the reply is normally in the first page. */
const LATEST_REPLY_SCAN_DEADLINE_MS = 5_000;

function assistantText(message: MuxMessage): string | null {
  if (message.role !== "assistant") return null;
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Text of a workspace's newest assistant message with visible text since its latest manual
 * reset, or null when there is none, history is unreadable, or the walk runs out of time.
 *
 * Other workspaces read this (task_await workspace_ids, redirected-turn reports), so it uses the
 * bounded history scanner: like session_history, it never crosses the target's manual-reset
 * privacy floor, and it never creates a session for a workspace without history.
 */
export async function readLatestAssistantReply(
  historyService: Pick<HistoryService, "scanHistoryBounded">,
  workspaceId: string
): Promise<{ text: string; messageId: string } | null> {
  const deadline = performance.now() + LATEST_REPLY_SCAN_DEADLINE_MS;
  let found: { text: string; messageId: string } | null = null;
  let cursor: Awaited<ReturnType<HistoryService["scanHistoryBounded"]>>["cursor"];
  try {
    for (;;) {
      const page = await historyService.scanHistoryBounded(workspaceId, {
        cursor,
        recentFirst: true,
        deadline,
        requireExistingHistory: true,
        visit: ({ message }) => {
          const text = assistantText(message);
          if (text == null) return true;
          found = { text, messageId: message.id };
          return false;
        },
      });
      if (found != null || page.cursor == null || performance.now() >= deadline) return found;
      cursor = page.cursor;
    }
  } catch {
    // Missing, removed or concurrently rewritten history: report no reply rather than fail.
    return null;
  }
}
