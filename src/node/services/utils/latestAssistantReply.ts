import type { MuxMessage } from "@/common/types/message";
import { isDurableCompactedMarker } from "@/common/utils/messages/compactionBoundary";
import type { HistoryService } from "@/node/services/historyService";

/** Wall-clock allowance for the newest-first walk; the reply is normally in the first page. */
const LATEST_REPLY_SCAN_DEADLINE_MS = 5_000;

/**
 * Visible text of message parts as one Markdown body. Adjacent text parts are provider stream
 * deltas and are concatenated exactly; a tool or reasoning part separates rendered text blocks,
 * so runs on either side of it are joined with a blank line instead of run together.
 */
export function joinVisibleTextRuns(
  parts: ReadonlyArray<{ type: string; text?: unknown }>
): string {
  const runs: string[] = [];
  let current = "";
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      current += part.text;
      continue;
    }
    if (current.length > 0) runs.push(current);
    current = "";
  }
  if (current.length > 0) runs.push(current);
  return runs.join("\n\n").trim();
}

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
  const text = joinVisibleTextRuns(message.parts);
  return text.length > 0 ? text : null;
}

export type LatestAssistantReplyResult =
  | { ok: true; reply: { text: string; messageId: string } | null }
  | { ok: false };

/**
 * The newest turn's assistant reply with visible text, since the workspace's latest manual
 * reset. A newest turn without one (a `/compact`, a failed or cancelled turn) is no reply.
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
  let reachedInput = false;
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
          // A reply must follow the newest input. Any user row (the human's message, a
          // `/compact` request, per-turn snapshots) starts a turn: reaching one first means the
          // newest turn has no text reply (compaction, failure, cancel), so never fall back to an
          // older turn's text.
          if (message.role === "user") {
            reachedInput = true;
            return false;
          }
          // An unfinished row (a cancelled or failed stream's committed partial) means the newest
          // turn did not finish: no reply, and no earlier text of that same turn either.
          if (message.role === "assistant" && message.metadata?.partial === true) {
            reachedInput = true;
            return false;
          }
          const text = assistantText(message);
          if (text == null) return true;
          found = { text, messageId: message.id };
          return false;
        },
      });
      if (signal?.aborted) return { ok: false };
      if (found != null || reachedInput || page.cursor == null) return { ok: true, reply: found };
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
