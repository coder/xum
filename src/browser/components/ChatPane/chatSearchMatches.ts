import type { MuxMessage } from "@/common/types/message";
import { isPlanReviewRecordMessage } from "@/common/utils/planReview/planReviewEnvelope";
import { isWorkflowResultMessage } from "@/common/utils/workflowRunMessages";
import { restoreContextBudgetRejectedMessageForDisplay } from "@/common/utils/messages/contextBudgetRejection";
import {
  buildDisplayedMessagesForMessage,
  getTextPartContent,
} from "@/browser/utils/messages/displayedMessageBuilder";

export interface ChatSearchMatch {
  messageId: string;
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

function getChatSearchText(message: MuxMessage): string {
  if (message.role === "assistant") return getTextPartContent(message.parts);
  if (message.role !== "user") return "";
  // Commands show their typed text, not the expanded instructions sent to the model.
  return buildDisplayedMessagesForMessage({
    message,
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  })
    .flatMap((row) =>
      row.type === "user" && row.agentPeerTriggerPayload == null ? [row.content] : []
    )
    .join("\n");
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
    const text = getChatSearchText(message);
    const match = pattern.exec(text);
    if (!match) continue;
    // Start at the match so a long prefix cannot hide the result preview.
    const lineEnd = text.indexOf("\n", match.index + match[0].length);
    matches.push({
      messageId: message.id,
      match: match[0],
      after: text.slice(match.index + match[0].length, lineEnd === -1 ? undefined : lineEnd),
    });
  }
  return matches;
}
