import { useEffect } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { CUSTOM_EVENTS } from "@/common/constants/events";

import { TimelinePanel } from "./TimelinePanel";

interface TimelineDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Timeline in a dialog for small viewports, where the right sidebar (the
 * timeline's usual home) is CSS-hidden and its tabs are unreachable.
 */
export function TimelineDialog(props: TimelineDialogProps) {
  const { open, onOpenChange, workspaceId } = props;

  // "Reveal in transcript" scrolls/highlights the chat pane underneath this modal,
  // so close it once a reveal for this workspace dispatches to make the result visible.
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleReveal = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
      if (detail?.workspaceId !== workspaceId) {
        return;
      }
      onOpenChange(false);
    };
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, handleReveal);
    return () => window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, handleReveal);
  }, [open, onOpenChange, workspaceId]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="flex h-[85dvh] w-[95%] flex-col gap-0 overflow-hidden p-0"
        data-testid="timeline-dialog"
      >
        <DialogHeader className="border-border shrink-0 border-b px-4 py-3">
          <DialogTitle className="text-base">Timeline</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <TimelinePanel workspaceId={props.workspaceId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
