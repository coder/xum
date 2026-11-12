import React from "react";
import { cn } from "@/common/lib/utils";
import {
  ExpandIcon,
  FOLDED_ROW_TEXT_CLASS,
  LoadingDots,
} from "@/browser/features/Tools/Shared/ToolPrimitives";
import type { WorkBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";

/**
 * An opened line stays at the top of the transcript while its steps are on screen, so it can be
 * closed from anywhere in them. Without that, closing a long stretch meant scrolling back up to
 * its line. The line's block bounds how far it sticks (see TranscriptBundleRows), and it has the
 * transcript's surface so the steps do not show through it.
 */
const OPEN_LINE_CLASS = cn(
  "bg-surface-primary sticky top-0 z-20 -my-1 py-1",
  // The transcript has padding above its first row, and steps scroll through it. The line's
  // surface reaches up over that strip, so no step shows above the pinned line.
  "before:bg-surface-primary before:absolute before:inset-x-0 before:bottom-full before:h-4"
);

interface WorkBundleMessageProps {
  item: WorkBundleInfo;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The one line a stretch of steps folds into at compact density: "Read 3 files, ran 2 commands",
 * or "Running the unit tests" while the stretch is live. The label starts where the agent's text
 * starts and the chevron follows it, the way Codex and Claude Code write a folded group. A
 * leading chevron indented every label past the text and put a column of chevrons down the page.
 */
export function WorkBundleMessage(props: WorkBundleMessageProps): React.ReactElement {
  return (
    <div className={cn("px-1", props.expanded && OPEN_LINE_CLASS)}>
      <button
        type="button"
        data-testid="work-bundle"
        className={cn(
          "text-muted hover:text-foreground inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-left transition-colors select-none",
          FOLDED_ROW_TEXT_CLASS,
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        )}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span className="min-w-0 truncate">{props.item.summary}</span>
        <ExpandIcon expanded={props.expanded} />
        {props.item.state === "live" && <LoadingDots aria-hidden="true" />}
      </button>
    </div>
  );
}
