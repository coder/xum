import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { ArtifactsPanel } from "./ArtifactsPanel";

/**
 * Artifacts in a dialog for small viewports, where the right sidebar (the tab's usual home)
 * is CSS-hidden. Mirrors TimelineDialog.
 */
export function ArtifactsDialog(props: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="flex h-[85dvh] w-[95%] flex-col gap-0 overflow-hidden p-0"
        data-testid="artifacts-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="border-border shrink-0 flex-row items-center justify-between space-y-0 border-b px-4 py-3">
          <DialogTitle className="text-base">Artifacts</DialogTitle>
          <DialogClose className="text-muted hover:text-foreground flex shrink-0 items-center rounded-sm transition-colors focus:outline-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <ArtifactsPanel workspaceId={props.workspaceId} inDialog />
        </div>
      </DialogContent>
    </Dialog>
  );
}
