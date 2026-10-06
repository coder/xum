import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { StatsContainer } from "./StatsContainer";

/**
 * Stats in a dialog for small viewports, where the right sidebar (the Stats tab's usual home) is
 * CSS-hidden (#5767). Mirrors TimelineDialog and renders the same StatsContainer as the tab.
 */
export function StatsDialog(props: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="flex h-[85dvh] w-[95%] flex-col gap-0 overflow-hidden p-0"
        data-testid="stats-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="border-border shrink-0 flex-row items-center justify-between space-y-0 border-b px-4 py-3">
          <DialogTitle className="text-base">Stats</DialogTitle>
          <DialogClose className="text-muted hover:text-foreground flex shrink-0 items-center rounded-sm transition-colors focus:outline-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <StatsContainer workspaceId={props.workspaceId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
