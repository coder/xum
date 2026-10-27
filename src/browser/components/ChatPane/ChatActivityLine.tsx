import { ChatInstructionsChatDecoration } from "@/browser/components/InstructionsTab/AdditionalSystemContextScratchpad";
import { StreamingBarrier } from "@/browser/features/Messages/ChatBarrier/StreamingBarrier";
import { BackgroundProcessesBanner } from "../BackgroundProcessesBanner/BackgroundProcessesBanner";
import { PinnedTodoList } from "../PinnedTodoList/PinnedTodoList";
import { ReviewsBanner } from "../ReviewsBanner/ReviewsBanner";
import { SubAgentTasksDecoration } from "../SubAgentTasksDecoration/SubAgentTasksDecoration";
import { ChatDockSurface } from "./chatDockColumn";
import { ChatActivityPanelsProvider } from "./chatActivityPanels";

interface ChatActivityLineProps {
  workspaceId: string;
  vimEnabled: boolean;
  onCancelCompaction: () => void;
  /**
   * False until the chat view's one-commit reveal: the chips are async decorations, and mounting
   * them after paint would shift the transcript.
   */
  revealChips: boolean;
  showTodo: boolean;
  showReviews: boolean;
}

/**
 * The composer's live line: turn status and Stop, plus one chip per kind of activity (TODO,
 * sub-agents, background bashes, reviews, Chat Instructions). It replaces one full-width row per
 * kind above the composer, which took a large share of the screen on phones; each chip opens its
 * list in a panel above the line instead. Without a live turn and without chips it renders nothing.
 */
export function ChatActivityLine(props: ChatActivityLineProps) {
  // No keys on the chips: the provider's key below remounts them per workspace, and siblings that
  // shared a key once left a cleared TODO list's chip behind next to the next list's.
  const chips = props.revealChips ? (
    <>
      {props.showTodo && <PinnedTodoList workspaceId={props.workspaceId} />}
      {/* Durable sub-agents live with their parent chat instead of relying only on nested
          sidebar rows. */}
      <SubAgentTasksDecoration workspaceId={props.workspaceId} />
      <BackgroundProcessesBanner workspaceId={props.workspaceId} />
      {props.showReviews && <ReviewsBanner workspaceId={props.workspaceId} />}
      {/* Self-gating: renders nothing when the scratchpad is empty or disabled. */}
      <ChatInstructionsChatDecoration workspaceId={props.workspaceId} />
    </>
  ) : null;

  return (
    <ChatDockSurface>
      {/* Positioned so every chip's panel opens against the line, right above it. Keyed by
          workspace: ChatPane stays mounted across switches, and nothing in the line may carry
          over to the next chat: an open panel, the TODO panel's scroll position (set to the
          current item on open), or the workflow-run refs the sub-agents chip retains. */}
      <ChatActivityPanelsProvider
        key={props.workspaceId}
        className="relative"
        dataComponent="ChatActivityLine"
      >
        {/* Always mounted, even between turns (it then shows only the chips): swapping it for
            another component when a turn starts or ends would remount the chips, closing an open
            panel and the bash output dialog and dropping their state. */}
        <StreamingBarrier
          workspaceId={props.workspaceId}
          vimEnabled={props.vimEnabled}
          onCancelCompaction={props.onCancelCompaction}
          showModelName={false}
          activity={chips}
        />
      </ChatActivityPanelsProvider>
    </ChatDockSurface>
  );
}
