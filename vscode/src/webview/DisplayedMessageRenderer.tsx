import type { DisplayedMessage } from "xum/common/types/message";

import { MessageRenderer } from "xum/browser/features/Messages/MessageRenderer";

// Renders the desktop MessageRenderer so every DisplayedMessage type (machine wakes, peer
// messages, context-budget warnings, compaction boundaries, the plan-display preview) matches
// desktop (#4971).
// Desktop props this wrapper deliberately omits:
// - onEditUserMessage: messageEditing is "planned" in chatUiCapabilities.ts.
// - onReviewNote: reviewAnnotations is "unsupported" in chatUiCapabilities.ts.
// - bashOutputGroup, taskReportLinking, userMessageNavigation: ChatPane-level transcript features
//   computed over the whole transcript; the webview does not wire them yet (follow-up to #4971).
export function DisplayedMessageRenderer(props: {
  message: DisplayedMessage;
  workspaceId: string;
  isLatestProposePlan?: boolean;
  isCompacting: boolean;
  onCloseEphemeral: (historyId: string) => void;
  onShowAllHistory: () => void;
}): JSX.Element {
  return (
    <MessageRenderer
      message={props.message}
      workspaceId={props.workspaceId}
      isLatestProposePlan={props.isLatestProposePlan}
      isCompacting={props.isCompacting}
      onCloseEphemeral={props.onCloseEphemeral}
      onShowAllHistory={props.onShowAllHistory}
    />
  );
}
