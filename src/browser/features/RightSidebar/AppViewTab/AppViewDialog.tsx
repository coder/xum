import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { AppViewTabLabel, AppViewTabPanel } from "./AppViewTab";

/**
 * An app tab in a sheet for small viewports, where the right sidebar is CSS-hidden. Mirrors
 * ArtifactsDialog; the sidebar selects the tab when it shows again (useSidebarTabDialog).
 */
export function AppViewDialog(props: {
  workspaceId: string;
  toolCallId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="flex h-[85dvh] w-[95%] flex-col gap-0 overflow-hidden p-0"
        data-testid="app-view-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="border-border shrink-0 flex-row items-center justify-between space-y-0 border-b px-4 py-3">
          <DialogTitle className="min-w-0 text-base">
            <AppViewTabLabel workspaceId={props.workspaceId} toolCallId={props.toolCallId} />
          </DialogTitle>
          <DialogClose className="text-muted hover:text-foreground flex shrink-0 items-center rounded-sm transition-colors focus:outline-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {props.open && (
            <AppViewTabPanel
              workspaceId={props.workspaceId}
              toolCallId={props.toolCallId}
              host="sheet"
              onClose={() => props.onOpenChange(false)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
