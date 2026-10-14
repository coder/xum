import { X } from "lucide-react";
import React from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { TerminalRouterProvider } from "@/browser/terminal/TerminalRouterContext";
import { hideTerminalDialog, useTerminalDialogSession } from "@/browser/utils/terminalDialogStore";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

// Code-split (T3, #5971): ghostty-web inlines its WASM, so keep it off the first load.
const TerminalView = React.lazy(() =>
  import("@/browser/components/TerminalView/TerminalView").then((m) => ({
    default: m.TerminalView,
  }))
);

/**
 * The pop-out terminal of iOS Home Screen web apps, which have no second window to open
 * (see openTerminalPopout).
 */
export function TerminalDialog() {
  const session = useTerminalDialogSession();
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceMetadata();
  if (!session) {
    return null;
  }
  const metadata = workspaceMetadata.get(session.workspaceId);

  const closeTerminal = () => {
    // Hide first, so leaving never depends on the backend answering.
    hideTerminalDialog(session.sessionId);
    // Like closing a sidebar tab or a desktop pop-out window, this ends the session.
    api?.terminal.close({ sessionId: session.sessionId }).catch((err: unknown) => {
      console.warn("[TerminalDialog] Failed to close terminal session:", err);
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeTerminal();
      }}
    >
      <DialogContent
        className="flex h-[85dvh] w-[95%] flex-col gap-0 overflow-hidden p-0"
        maxWidth="1000px"
        data-testid="terminal-dialog"
        aria-describedby={undefined}
        showCloseButton={false}
        // Escape belongs to the shell (vim, less), and a stray tap outside must not end the
        // session, so only the close button, the close-tab shortcut and the shell exiting leave.
        allowEditableEscape
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        // Capture phase: ghostty-web stops the propagation of every key it sends to the shell.
        onKeyDownCapture={(event) => {
          if (!matchesKeybind(event, KEYBINDS.CLOSE_TAB)) return;
          event.preventDefault();
          event.stopPropagation();
          closeTerminal();
        }}
      >
        <DialogHeader className="border-border shrink-0 flex-row items-center justify-between space-y-0 border-b px-4 py-3">
          <DialogTitle className="text-base">Terminal</DialogTitle>
          <DialogClose className="text-muted hover:text-foreground flex shrink-0 items-center rounded-sm transition-colors focus:outline-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close terminal</span>
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {/* A pop-out router keeps the session out of the sidebar's restored tabs. */}
          <TerminalRouterProvider popout>
            <LazyFeature name="Terminal" fallback={<div className="h-full w-full" />}>
              <TerminalView
                key={session.sessionId}
                workspaceId={session.workspaceId}
                sessionId={session.sessionId}
                initialTitle={session.initialTitle}
                visible={true}
                setDocumentTitle={false}
                workspaceName={metadata?.name ?? ""}
                projectName={metadata?.projectName ?? ""}
                onExit={() => hideTerminalDialog(session.sessionId)}
              />
            </LazyFeature>
          </TerminalRouterProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
