import React, { useState } from "react";
import { MODAL_DIALOG_OVERLAY_ATTRIBUTE } from "@/browser/utils/ui/keybinds";
import { LazyFeature } from "../LazyFeature/LazyFeature";
import { Dialog, DialogContent, DialogTitle } from "../Dialog/Dialog";

/**
 * Renders a lazy settings modal (#5971) from its first open on, and keeps it mounted after that,
 * so its close still animates. A failed load shows LazyFeature's Reload message.
 */
export function LazySettingsModal(props: {
  name: string;
  open: boolean;
  /** Escape or a click outside the loading dialog cancels the open. */
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  if (props.open && !mounted) setMounted(true);
  // While the chunk loads, nothing may open a second modal over this one. The loading dialog is a
  // real modal: its backdrop takes the pointer, and its focus trap keeps keyboard focus off the
  // Workspace actions trigger. The hidden open-overlay marker makes isDialogOpen() true for the
  // global shortcuts from the first render, before the dialog's portal mounts.
  const pending = props.open ? (
    <>
      <div {...{ [MODAL_DIALOG_OVERLAY_ATTRIBUTE]: "" }} data-state="open" hidden />
      <Dialog open onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent aria-describedby={undefined} aria-busy showCloseButton={false}>
          <DialogTitle>{props.name}</DialogTitle>
          <p className="text-muted text-sm">Loading…</p>
        </DialogContent>
      </Dialog>
    </>
  ) : null;
  return mounted ? (
    <LazyFeature name={props.name} fallback={pending}>
      {props.children}
    </LazyFeature>
  ) : null;
}
