import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  WarningBox,
  WarningText,
  WarningTitle,
} from "@/browser/components/Dialog/Dialog";

// Modal dialog primitive — mirrors the Dialog stories. Rendered with defaultOpen
// so the surface shows. Overlay/portal component → cardMode "single" in config.
export const Default = () => (
  <MuxPreviewShell>
    <div className="bg-background min-h-screen">
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              Give this workspace a name that describes the work happening in it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost">Cancel</Button>
            <Button>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  </MuxPreviewShell>
);

export const Destructive = () => (
  <MuxPreviewShell>
    <div className="bg-background min-h-screen">
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>This action cannot be undone.</DialogDescription>
          </DialogHeader>
          <WarningBox>
            <WarningTitle>This permanently deletes the project</WarningTitle>
            <WarningText>
              All workspaces, worktrees, and chat history for this project will be removed from
              disk.
            </WarningText>
          </WarningBox>
          <DialogFooter>
            <Button variant="ghost">Cancel</Button>
            <Button variant="destructive">Delete project</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  </MuxPreviewShell>
);
