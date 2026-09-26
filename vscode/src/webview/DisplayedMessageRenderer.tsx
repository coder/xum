import type { DisplayedMessage } from "xum/common/types/message";

import { AssistantMessage } from "xum/browser/features/Messages/AssistantMessage";
import { HistoryHiddenMessage } from "xum/browser/features/Messages/HistoryHiddenMessage";
import { InitMessage } from "xum/browser/features/Messages/InitMessage";
import { MarkdownRenderer } from "xum/browser/features/Messages/MarkdownRenderer";
import { MessageWindow } from "xum/browser/features/Messages/MessageWindow";
import { ReasoningMessage } from "xum/browser/features/Messages/ReasoningMessage";
import { StreamErrorMessage } from "xum/browser/features/Messages/StreamErrorMessage";
import { ToolMessage } from "xum/browser/features/Messages/ToolMessage";
import { UserMessage } from "xum/browser/features/Messages/UserMessage";

export function DisplayedMessageRenderer(props: {
  message: DisplayedMessage;
  workspaceId: string | null;
}): JSX.Element | null {
  const message = props.message;

  switch (message.type) {
    case "user":
      return <UserMessage message={message} />;

    case "assistant":
      return <AssistantMessage message={message} workspaceId={props.workspaceId ?? undefined} />;

    case "reasoning":
      return <ReasoningMessage message={message} />;

    case "stream-error":
      return <StreamErrorMessage message={message} />;

    case "history-hidden":
      return <HistoryHiddenMessage message={message} />;

    case "workspace-init":
      return <InitMessage message={message} />;

    case "plan-display": {
      // Ephemeral plan output (e.g. /plan). Render it as an assistant-style markdown block.
      return (
        <MessageWindow label={null} variant="assistant" message={message}>
          <MarkdownRenderer content={message.content} />
        </MessageWindow>
      );
    }

    case "tool":
      return <ToolMessage message={message} workspaceId={props.workspaceId ?? undefined} />;

    case "compaction-boundary":
      // The webview does not render compaction boundaries.
      return null;

    default: {
      const _exhaustive: never = message;
      console.error("mux webview: unknown displayed message", _exhaustive);
      return null;
    }
  }
}
