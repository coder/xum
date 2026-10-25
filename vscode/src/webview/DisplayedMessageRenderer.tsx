import type { DisplayedMessage } from "xum/common/types/message";
import type { BashOutputGroupInfo } from "xum/browser/utils/messages/messageUtils";
import type { TaskReportLinking } from "xum/browser/utils/messages/taskReportLinking";
import type { UserMessageNavigation } from "xum/browser/features/Messages/UserMessage";

import { MessageRenderer } from "xum/browser/features/Messages/MessageRenderer";

// Renders the desktop MessageRenderer so every DisplayedMessage type (machine wakes, peer
// messages, context-budget warnings, compaction boundaries, the plan-display preview) matches
// desktop (#4971).
// Desktop props this wrapper deliberately omits:
// - onEditUserMessage: messageEditing is "planned" in chatUiCapabilities.ts.
// - onReviewNote: reviewAnnotations is "unsupported" in chatUiCapabilities.ts.
// bashOutputGroup, taskReportLinking and userMessageNavigation come from the whole-transcript
// derivations App shares with ChatPane (transcriptRowDerivations, #5002).
export function DisplayedMessageRenderer(props: {
  message: DisplayedMessage;
  workspaceId: string;
  isLatestProposePlan?: boolean;
  isCompacting: boolean;
  onCloseEphemeral: (historyId: string) => void;
  onShowAllHistory: () => void;
  bashOutputGroup?: BashOutputGroupInfo;
  taskReportLinking?: TaskReportLinking;
  userMessageNavigation?: UserMessageNavigation;
}): JSX.Element {
  return (
    <MessageRenderer
      message={props.message}
      workspaceId={props.workspaceId}
      isLatestProposePlan={props.isLatestProposePlan}
      isCompacting={props.isCompacting}
      onCloseEphemeral={props.onCloseEphemeral}
      onShowAllHistory={props.onShowAllHistory}
      bashOutputGroup={props.bashOutputGroup}
      taskReportLinking={props.taskReportLinking}
      userMessageNavigation={props.userMessageNavigation}
    />
  );
}
