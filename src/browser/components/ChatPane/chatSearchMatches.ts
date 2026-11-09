import type { DisplayedMessage, MuxMessage } from "@/common/types/message";
import { isPlanReviewRecordMessage } from "@/common/utils/planReview/planReviewEnvelope";
import { isWorkflowResultMessage } from "@/common/utils/workflowRunMessages";
import { restoreContextBudgetRejectedMessageForDisplay } from "@/common/utils/messages/contextBudgetRejection";
import { buildDisplayedMessagesForMessage } from "@/browser/utils/messages/displayedMessageBuilder";

export interface ChatSearchMatch {
  messageId: string;
  displayedMessageId: string;
  match: string;
  after: string;
}

function isHiddenChatSearchMessage(message: MuxMessage): boolean {
  // Model-only context has no transcript row to reveal.
  return (
    (message.metadata?.synthetic === true && message.metadata.uiVisible !== true) ||
    isPlanReviewRecordMessage(message) ||
    isWorkflowResultMessage(message)
  );
}

type ChatSearchRow = Extract<DisplayedMessage, { type: "user" | "assistant" | "plan-display" }>;

function getChatSearchRows(message: MuxMessage): ChatSearchRow[] {
  // Search displayed text, not model-facing command expansions or persisted summary labels.
  return buildDisplayedMessagesForMessage({
    message,
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  }).filter(
    (row): row is ChatSearchRow =>
      row.type === "assistant" ||
      row.type === "plan-display" ||
      (row.type === "user" && row.agentPeerTriggerPayload == null)
  );
}

function findFirstMatchingRow(message: MuxMessage, pattern: RegExp): ChatSearchMatch | undefined {
  for (const row of getChatSearchRows(message)) {
    const match = pattern.exec(row.content);
    if (!match) continue;
    // Keep the row ID: several text rows can share one history message.
    const matchEnd = match.index + match[0].length;
    const lineEnd = row.content.indexOf("\n", matchEnd);
    return {
      messageId: message.id,
      displayedMessageId: row.id,
      match: match[0],
      after: row.content.slice(matchEnd, lineEnd === -1 ? undefined : lineEnd),
    };
  }
  return undefined;
}

/** Search message text, including rows that the transcript does not mount. */
export function findChatSearchMatches(
  messages: readonly MuxMessage[],
  query: string
): ChatSearchMatch[] {
  if (!query.trim()) return [];

  // Escape the query so punctuation searches literally, not as a regular expression.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const matches: ChatSearchMatch[] = [];
  for (const sourceMessage of messages) {
    const message = restoreContextBudgetRejectedMessageForDisplay(sourceMessage);
    if (isHiddenChatSearchMessage(message)) continue;
    const match = findFirstMatchingRow(message, pattern);
    if (match) matches.push(match);
  }
  return matches;
}
