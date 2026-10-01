import type { MuxMessage } from "@/common/types/message";
import { isDurableCompactedMarker } from "@/common/utils/messages/compactionBoundary";
import type { HistoryService } from "@/node/services/historyService";

/** Wall-clock allowance for the newest-first walk; the reply is normally in the first page. */
const LATEST_REPLY_SCAN_DEADLINE_MS = 5_000;

function assistantText(message: MuxMessage): string | null {
  if (message.role !== "assistant") return null;
  // Machine rows are not replies: compaction summaries (the newest row after an idle compaction)
  // and synthetic rows such as peer-message envelopes.
  if (
    message.metadata?.synthetic === true ||
    message.metadata?.compactionBoundary === true ||
    // Legacy rows may carry `compacted: false` on ordinary replies; only durable markers count.
    isDurableCompactedMarker(message.metadata?.compacted)
  ) {
    return null;
  }
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

export type LatestAssistantReplyResult =
  | { ok: true; reply: { text: string; messageId: string } | null }
  | { ok: false };

/**
 * The newest assistant reply with visible text since the workspace's latest manual reset.
 * `reply: null` means the read finished and found none; `ok: false` means history could not be
 * read (missing, rewritten concurrently, or out of time), so callers can retry instead of
 * treating a failed read as "no reply".
 *
 * Other workspaces read this (task_await workspace_ids, redirected-turn reports), so it uses the
 * bounded history scanner: like session_history, it never crosses the target's manual-reset
 * privacy floor, and it never creates a session for a workspace without history.
 * An aborted `signal` stops the walk between pages and reports `ok: false`, so a detached
 * waiter does not stay attached for the whole scan.
 */
export async function readLatestAssistantReply(
  historyService: Pick<HistoryService, "scanHistoryBounded">,
  workspaceId: string,
  signal?: AbortSignal
): Promise<LatestAssistantReplyResult> {
  const deadline = performance.now() + LATEST_REPLY_SCAN_DEADLINE_MS;
  let found: { text: string; messageId: string } | null = null;
  let cursor: Awaited<ReturnType<HistoryService["scanHistoryBounded"]>>["cursor"];
  try {
    for (;;) {
      if (signal?.aborted) return { ok: false };
      const page = await historyService.scanHistoryBounded(workspaceId, {
        cursor,
        recentFirst: true,
        deadline,
        requireExistingHistory: true,
        ...(signal != null ? { abortSignal: signal } : {}),
        visit: ({ message }) => {
          const text = assistantText(message);
          if (text == null) return true;
          found = { text, messageId: message.id };
          return false;
        },
      });
      if (signal?.aborted) return { ok: false };
      if (found != null || page.cursor == null) return { ok: true, reply: found };
      if (performance.now() >= deadline) return { ok: false };
      cursor = page.cursor;
    }
  } catch (error) {
    // A workspace without retained history has no reply; anything else is a failed read.
    if (error instanceof Error && error.message === "session_unavailable") {
      return { ok: true, reply: null };
    }
    return { ok: false };
  }
}
