import { useEffect, useLayoutEffect, useRef } from "react";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useRouter } from "@/browser/contexts/RouterContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useUserPreferences } from "@/browser/stores/AppConfigStore";
import { isEscapeDismissOverlayOpen } from "@/browser/hooks/useEscapeToDismiss";
import {
  useOptionalWorkspaceSidebarState,
  useWorkspaceSidebarState,
} from "@/browser/stores/WorkspaceStore";
import {
  allowsEscapeToInterruptStream,
  formatKeybind,
  isDesktopViewportFocused,
  isDialogOpen,
  isEditableElement,
  isTerminalFocused,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";

interface SideChatBannerProps {
  workspaceId: string;
  parentWorkspaceId: string;
}

/**
 * Header for a /side chat (Codex form factor): the side chat takes over the chat view while the
 * main chat keeps running in the background. Shows the main chat's status and returns to it;
 * returning discards the side chat (useDiscardSideChatOnLeave).
 */
export function SideChatBanner(props: SideChatBannerProps) {
  const { navigateToWorkspace } = useRouter();
  const { workspaceMetadata } = useWorkspaceContext();
  const vimEnabled = useUserPreferences(
    (preferences) => preferences.appearance?.vimEnabled === true
  );
  const sideChatState = useWorkspaceSidebarState(props.workspaceId);
  const parentState = useOptionalWorkspaceSidebarState(props.parentWorkspaceId);

  const parentMetadata = workspaceMetadata.get(props.parentWorkspaceId);
  const parentTitle = parentMetadata?.title ?? parentMetadata?.name ?? "main chat";
  const parentWorking = parentState != null && (parentState.canInterrupt || parentState.isStarting);
  const sideChatBusy = sideChatState.canInterrupt || sideChatState.isStarting;
  // The key that interrupts a stream also returns once the side chat is idle, like Codex: the
  // first press stops a running answer (useAIViewKeybinds), the next one returns.
  const returnKeybind = vimEnabled
    ? KEYBINDS.INTERRUPT_STREAM_VIM
    : KEYBINDS.INTERRUPT_STREAM_NORMAL;

  const returnToMainChat = () => navigateToWorkspace(props.parentWorkspaceId);

  // Refs keep one window listener for the banner's lifetime, so its position among other
  // bubble-phase listeners stays fixed (see useEscapeToDismiss).
  const stateRef = useRef({ sideChatBusy, returnKeybind, returnToMainChat });
  useLayoutEffect(() => {
    stateRef.current = { sideChatBusy, returnKeybind, returnToMainChat };
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const state = stateRef.current;
      if (!matchesKeybind(e, state.returnKeybind)) return;
      // Something closer to the focus (a menu, an edit, a dialog) already claimed the key.
      if (e.defaultPrevented || e.isComposing) return;
      if (isTerminalFocused(e.target) || isDesktopViewportFocused(e.target)) return;
      if (isDialogOpen() || isEscapeDismissOverlayOpen()) return;
      // Same opt-in as the stream interrupt: other inputs (search, rename) keep their Escape.
      if (isEditableElement(e.target) && !allowsEscapeToInterruptStream(e.target)) return;
      // A running answer is interrupted first; the next press returns.
      if (state.sideChatBusy) return;
      e.preventDefault();
      state.returnToMainChat();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      className="border-border bg-surface-secondary flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs"
      data-testid="side-chat-banner"
    >
      <MessagesSquare className="text-muted size-3.5 shrink-0" />
      <span className="text-foreground shrink-0 font-medium">Side chat</span>
      <span className="text-muted min-w-0 truncate">
        {parentWorking ? "Main chat is working" : "Main chat is idle"} · {parentTitle}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6 shrink-0 px-2 text-xs"
        onClick={returnToMainChat}
      >
        <ArrowLeft className="size-3" />
        Return to main chat
        <kbd className="text-muted [@media(max-width:768px)]:hidden">
          {formatKeybind(returnKeybind)}
        </kbd>
      </Button>
    </div>
  );
}
