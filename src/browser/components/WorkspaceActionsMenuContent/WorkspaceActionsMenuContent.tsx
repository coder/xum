import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { ArchiveIcon } from "../icons/ArchiveIcon/ArchiveIcon";
import { WorkspaceTerminalIcon } from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import {
  GitBranch,
  HeartPulse,
  Maximize2,
  MessagesSquare,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Server,
  Square,
} from "lucide-react";
import React from "react";

interface WorkspaceActionButtonProps {
  label: string;
  shortcut?: string;
  shortcutClassName?: string;
  icon: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}

function WorkspaceActionButton(props: WorkspaceActionButtonProps) {
  return (
    <button
      type="button"
      data-workspace-action-row
      // focus:bg-hover marks the row the arrow keys reached, like the hover state (#6103).
      className="text-content-secondary bg-surface-primary hover:bg-hover focus:bg-hover block w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap outline-none"
      onClick={props.onClick}
      data-testid={props.testId}
    >
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 [&_svg]:h-3 [&_svg]:w-3">{props.icon}</span>
        {/* Label truncates and the shortcut never shrinks, so a narrow menu cannot
            push the shortcut outside the row. */}
        <span className="min-w-0 truncate">{props.label}</span>
        {props.shortcut && (
          <span
            className={`text-muted ml-auto shrink-0 pl-2 text-[10px] ${props.shortcutClassName ?? ""}`}
          >
            ({props.shortcut})
          </span>
        )}
      </span>
    </button>
  );
}

interface WorkspaceActionsMenuContentProps {
  /** Workspace title actions only make sense in the left sidebar where title text is visible. */
  onEditTitle?: (() => void) | null;
  /** Workspace-level settings action currently surfaced from the workspace menu bar. */
  onConfigureMcp?: (() => void) | null;
  /** Experiment-gated workspace heartbeat settings action. */
  onConfigureHeartbeat?: (() => void) | null;
  /** Recipient consent for discovery/messages from unrelated workspaces (menu bar only). */
  onConfigureUnrelatedMessaging?: (() => void) | null;
  /** Mobile workspace-header action: open immersive review in full-screen touch mode. */
  onOpenTouchFullscreenReview?: (() => void) | null;
  onEnterImmersiveReview?: (() => void) | null;
  /**
   * Small viewports only: show the hidden right sidebar full-screen. One row for the whole
   * sidebar, not one per tool, so the menu does not grow with every sidebar tab: the sidebar's
   * own New tab launcher lists the tools.
   */
  onOpenSidebar?: (() => void) | null;
  /** Touch phones only: the header row carries Stats and Artifacts there, so New terminal moves here. */
  onOpenTerminal?: (() => void) | null;
  onStopRuntime?: (() => void) | null;
  onForkChat?: ((anchorEl: HTMLElement) => void) | null;
  /** Pin/unpin toggle; pass null on sub-agent rows (only root chats are pinnable). */
  onTogglePinned?: (() => void) | null;
  isPinned?: boolean;
  onArchiveChat?: ((anchorEl: HTMLElement) => void) | null;
  onCloseMenu: () => void;
  shortcutClassName?: string;
  configureMcpTestId?: string;
}

/**
 * Shared menu content for workspace actions, used by both sidebar rows and the workspace menu bar.
 * Keeping these actions centralized prevents menu drift between entry points.
 */
export const WorkspaceActionsMenuContent: React.FC<WorkspaceActionsMenuContentProps> = (props) => {
  return (
    // No menu role on purpose: the menu/menuitem pattern also requires roving Tab focus and
    // changes how the sidebar row's long-press handling sees this portal. The Radix Popover
    // stays a dialog of buttons, and the arrow keys are an extra on top of Tab (#6103).
    <div onKeyDown={handleRowArrowKeys}>
      {props.onEditTitle && (
        <WorkspaceActionButton
          label="Edit chat title"
          shortcut={formatKeybind(KEYBINDS.EDIT_WORKSPACE_TITLE)}
          shortcutClassName={props.shortcutClassName}
          icon={<Pencil className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onEditTitle?.();
          }}
        />
      )}
      {props.onConfigureMcp && (
        <WorkspaceActionButton
          label="Configure MCP servers"
          shortcut={formatKeybind(KEYBINDS.CONFIGURE_MCP)}
          shortcutClassName={props.shortcutClassName}
          icon={<Server className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onConfigureMcp?.();
          }}
          testId={props.configureMcpTestId}
        />
      )}
      {props.onConfigureHeartbeat && (
        <WorkspaceActionButton
          label="Configure heartbeat"
          shortcut={formatKeybind(KEYBINDS.CONFIGURE_HEARTBEAT)}
          shortcutClassName={props.shortcutClassName}
          icon={<HeartPulse className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onConfigureHeartbeat?.();
          }}
        />
      )}
      {props.onConfigureUnrelatedMessaging && (
        <WorkspaceActionButton
          label="Messages from other workspaces"
          shortcut={formatKeybind(KEYBINDS.CONFIGURE_UNRELATED_MESSAGING)}
          shortcutClassName={props.shortcutClassName}
          icon={<MessagesSquare className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onConfigureUnrelatedMessaging?.();
          }}
          testId="workspace-unrelated-messaging-button"
        />
      )}
      {props.onOpenTouchFullscreenReview && (
        <WorkspaceActionButton
          label="Mobile full-screen review"
          icon={<Maximize2 className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onOpenTouchFullscreenReview?.();
          }}
        />
      )}
      {props.onEnterImmersiveReview && (
        <WorkspaceActionButton
          label="Immersive review"
          shortcut={formatKeybind(KEYBINDS.TOGGLE_REVIEW_IMMERSIVE)}
          shortcutClassName={props.shortcutClassName}
          icon={<Maximize2 className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onEnterImmersiveReview?.();
          }}
        />
      )}
      {props.onOpenSidebar && (
        <WorkspaceActionButton
          label="Sidebar"
          icon={<PanelRight className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onOpenSidebar?.();
          }}
          testId="workspace-open-sidebar"
        />
      )}
      {props.onOpenTerminal && (
        <WorkspaceActionButton
          label="New terminal"
          shortcut={formatKeybind(KEYBINDS.OPEN_TERMINAL)}
          shortcutClassName={props.shortcutClassName}
          icon={<WorkspaceTerminalIcon className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onOpenTerminal?.();
          }}
          testId="workspace-terminal-button"
        />
      )}
      {props.onStopRuntime && (
        <WorkspaceActionButton
          label="Stop container"
          icon={<Square className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onStopRuntime?.();
          }}
        />
      )}
      {props.onForkChat && (
        <WorkspaceActionButton
          label="Fork chat"
          icon={<GitBranch className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onForkChat?.(e.currentTarget);
          }}
        />
      )}
      {props.onTogglePinned && (
        <WorkspaceActionButton
          label={props.isPinned ? "Unpin chat" : "Pin chat"}
          shortcut={formatKeybind(KEYBINDS.PIN_WORKSPACE)}
          shortcutClassName={props.shortcutClassName}
          icon={
            props.isPinned ? (
              <PinOff className="h-3 w-3 shrink-0" />
            ) : (
              <Pin className="h-3 w-3 shrink-0" />
            )
          }
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onTogglePinned?.();
          }}
        />
      )}
      {props.onArchiveChat && (
        <WorkspaceActionButton
          label="Archive chat"
          shortcut={formatKeybind(KEYBINDS.ARCHIVE_WORKSPACE)}
          shortcutClassName={props.shortcutClassName}
          icon={<ArchiveIcon className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onArchiveChat?.(e.currentTarget);
          }}
        />
      )}
    </div>
  );
};

// ArrowDown/ArrowUp move focus between the rows and stop at the ends, as in ArtifactVersionMenu.
// Tab still works. The popover focuses the first row when it opens (#6103).
function handleRowArrowKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-workspace-action-row]")
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = event.key === "ArrowDown" ? index + 1 : index - 1;
  rows[Math.min(Math.max(next, 0), rows.length - 1)]?.focus();
}
