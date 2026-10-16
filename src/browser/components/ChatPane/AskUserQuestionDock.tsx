import { useState, useSyncExternalStore } from "react";

import { ToolMessage } from "@/browser/features/Messages/ToolMessage";
import {
  AskUserQuestionPlacementProvider,
  findOpenAskUserQuestions,
  NO_DOCKED_QUESTIONS,
  reconcileDockedQuestionIds,
  releaseDockedQuestionId,
  type AskUserQuestionPlacement,
  type AskUserQuestionToolMessage,
  type DockedQuestionIds,
} from "@/browser/features/Tools/AskUserQuestion/askUserQuestionPlacement";
import { useAcceptedAnswersVersion } from "@/browser/features/Tools/AskUserQuestion/useNonBlockingQuestionAnswers";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { ChatDockSurface } from "./chatDockColumn";

/**
 * Open ask_user_question forms, docked above the chat input so they stay sticky to the bottom of
 * the chat while the transcript scrolls or keeps streaming. ChatPane renders the matching
 * transcript rows as stubs (see askUserQuestionPlacement).
 *
 * Mount with `key={workspaceId}`: a card stays mounted after its questions close (it renders
 * nothing then) until it releases itself, so a blocking answer's auto-retry rollback can still
 * observe the resumed stream; those retained cards belong to one workspace visit.
 */
export function AskUserQuestionDock(props: { workspaceId: string }) {
  const workspaceStore = useWorkspaceStoreRaw();
  const messages = useSyncExternalStore(
    (listener) => workspaceStore.subscribeKey(props.workspaceId, listener),
    () => workspaceStore.getWorkspaceState(props.workspaceId).messages
  );

  // An accepted non-blocking answer closes its question without any transcript change.
  useAcceptedAnswersVersion();
  const [dockState, setDockState] = useState<DockedQuestionIds>(NO_DOCKED_QUESTIONS);
  const nextDockState = reconcileDockedQuestionIds(
    dockState,
    findOpenAskUserQuestions(props.workspaceId, messages).map((question) => question.id)
  );
  if (nextDockState !== dockState) {
    // Adjust state during render (no effect): dock every question that opened in this visit.
    setDockState(nextDockState);
  }
  const placement: AskUserQuestionPlacement = {
    kind: "dock",
    release: (rowId) => setDockState((state) => releaseDockedQuestionId(state, rowId)),
  };

  const dockedQuestions = messages.filter(
    (message): message is AskUserQuestionToolMessage =>
      message.type === "tool" && nextDockState.includes(message.id)
  );

  if (dockedQuestions.length === 0) {
    return null;
  }

  return (
    <AskUserQuestionPlacementProvider value={placement}>
      <ChatDockSurface>
        {/* Bounded so a long question set never pushes the composer off a short (mobile) screen;
            the card's header still collapses it. */}
        <div data-component="AskUserQuestionDock" className="max-h-[50vh] overflow-y-auto">
          {dockedQuestions.map((message) => (
            <ToolMessage
              key={message.id}
              message={message}
              workspaceId={props.workspaceId}
              // The transcript row keeps the call's hook output; a retained (closed) card here
              // must render nothing at all.
              showHookOutput={false}
            />
          ))}
        </div>
      </ChatDockSurface>
    </AskUserQuestionPlacementProvider>
  );
}
