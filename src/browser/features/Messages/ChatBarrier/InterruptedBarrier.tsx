import React from "react";
import { cn } from "@/common/lib/utils";
import { FOLDED_ROW_TEXT_CLASS } from "@/browser/features/Tools/Shared/ToolPrimitives";

interface InterruptedBarrierProps {
  /** True on the writable resume target (history tail); nothing renders otherwise. */
  resumable?: boolean;
  /** Resume handler (owned by ChatPane); used only when `resumable`. */
  onResume?: () => void;
  /** Last resume failure, surfaced inline so a click/keybind isn't a silent no-op. */
  error?: string | null;
  className?: string;
}

/**
 * What is left of the "interrupted" divider: one quiet line under the turn the user stopped,
 * where "Continue" resumes it (the only continue control for an Esc interrupt, where
 * RetryBarrier is suppressed).
 *
 * It used to be a full-width divider under every interrupted response. Further up the
 * transcript that marked nothing the user could act on, since the conversation had gone on, and
 * a transcript with a few stopped turns was striped with them. So it renders only where it does
 * something: on the turn that can be continued.
 */
export const InterruptedBarrier: React.FC<InterruptedBarrierProps> = (props) => {
  if (!props.resumable) {
    return null;
  }
  return (
    <div
      className={cn("text-muted my-1 px-1", FOLDED_ROW_TEXT_CLASS, props.className)}
      data-testid="interrupted-barrier"
    >
      <span>Interrupted</span>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        onClick={props.onResume}
        aria-label="Continue interrupted response"
        className="hover:text-foreground focus-visible:outline-primary m-0 cursor-pointer rounded-sm border-none bg-transparent p-0 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Continue
      </button>
      {props.error && (
        // Surface failures: this is the only continue affordance for an Esc interrupt.
        <div className="text-foreground/80 mt-1">
          <span className="text-warning font-semibold">Couldn&apos;t continue:</span> {props.error}
        </div>
      )}
    </div>
  );
};
