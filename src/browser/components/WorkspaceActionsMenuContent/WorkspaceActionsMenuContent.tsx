import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  formatKeybind,
  isAltGraphPressed,
  KEYBINDS,
  matchesKeybind,
  type Keybind,
} from "@/browser/utils/ui/keybinds";
import { ArchiveIcon } from "../icons/ArchiveIcon/ArchiveIcon";
import { WorkspaceTerminalIcon } from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import {
  Eye,
  EyeOff,
  GitBranch,
  HeartPulse,
  Maximize2,
  MessagesSquare,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Server,
  Sparkles,
  Square,
} from "lucide-react";
import React from "react";
import {
  getWorkspaceActionGroups,
  type WorkspaceActionId,
  type WorkspaceActionsState,
} from "./workspaceActionItems";

/** The menu passes the clicked row, so an error popover can anchor next to it. */
export type WorkspaceActionHandlers = Partial<
  Record<WorkspaceActionId, (anchorEl: HTMLElement) => void>
>;

interface ActionRow {
  label: string;
  icon: React.ReactNode;
  keybind?: Keybind;
  testId?: string;
}

// One noun for every workspace kind, scratch chats included (#6202).
const ACTION_ROWS: Record<WorkspaceActionId, ActionRow> = {
  editTitle: {
    label: "Edit workspace title",
    icon: <Pencil />,
    keybind: KEYBINDS.EDIT_WORKSPACE_TITLE,
  },
  generateTitle: {
    label: "Generate new title",
    icon: <Sparkles />,
    keybind: KEYBINDS.GENERATE_WORKSPACE_TITLE,
  },
  configureMcp: {
    label: "Configure MCP servers",
    icon: <Server />,
    keybind: KEYBINDS.CONFIGURE_MCP,
    testId: "workspace-mcp-button",
  },
  configureHeartbeat: {
    label: "Configure heartbeat",
    icon: <HeartPulse />,
    keybind: KEYBINDS.CONFIGURE_HEARTBEAT,
  },
  configureMessaging: {
    label: "Messages from other workspaces",
    icon: <MessagesSquare />,
    keybind: KEYBINDS.CONFIGURE_UNRELATED_MESSAGING,
    testId: "workspace-unrelated-messaging-button",
  },
  immersiveReview: {
    label: "Immersive review",
    icon: <Maximize2 />,
    keybind: KEYBINDS.TOGGLE_REVIEW_IMMERSIVE,
  },
  touchFullscreenReview: { label: "Mobile full-screen review", icon: <Maximize2 /> },
  // One row for the whole sidebar, not one per tool, so the menu does not grow with every
  // sidebar tab: the sidebar's own New tab launcher lists the tools.
  openSidebar: { label: "Sidebar", icon: <PanelRight />, testId: "workspace-open-sidebar" },
  openTerminal: {
    label: "New terminal",
    icon: <WorkspaceTerminalIcon />,
    keybind: KEYBINDS.OPEN_TERMINAL,
    testId: "workspace-terminal-button",
  },
  togglePinned: { label: "Pin workspace", icon: <Pin />, keybind: KEYBINDS.PIN_WORKSPACE },
  markUnread: { label: "Mark unread", icon: <EyeOff />, keybind: KEYBINDS.MARK_WORKSPACE_UNREAD },
  toggleSubAgents: {
    label: "Show sub-agents",
    icon: <Eye />,
    keybind: KEYBINDS.TOGGLE_COMPLETED_SUB_AGENTS,
  },
  fork: { label: "Fork workspace", icon: <GitBranch />, keybind: KEYBINDS.FORK_WORKSPACE },
  stopRuntime: {
    label: "Stop container",
    icon: <Square />,
    keybind: KEYBINDS.STOP_WORKSPACE_RUNTIME,
  },
  archive: {
    label: "Archive workspace",
    icon: <ArchiveIcon />,
    keybind: KEYBINDS.ARCHIVE_WORKSPACE,
  },
};

// The toggle rows while they are on.
const UNPIN_ROW: ActionRow = {
  ...ACTION_ROWS.togglePinned,
  label: "Unpin workspace",
  icon: <PinOff />,
};
const HIDE_SUB_AGENTS_ROW: ActionRow = {
  ...ACTION_ROWS.toggleSubAgents,
  label: "Hide sub-agents",
  icon: <EyeOff />,
};

interface WorkspaceActionButtonProps {
  id: WorkspaceActionId;
  row: ActionRow;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function WorkspaceActionButton(props: WorkspaceActionButtonProps) {
  return (
    <button
      type="button"
      data-workspace-action-row={props.id}
      // focus:bg-hover marks the row the arrow keys reached, like the hover state (#6103).
      className="text-content-secondary bg-surface-primary hover:bg-hover focus:bg-hover block w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap outline-none"
      onClick={props.onClick}
      data-testid={props.row.testId}
    >
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0">
          {props.row.icon}
        </span>
        {/* Label truncates and the shortcut never shrinks, so a narrow menu cannot
            push the shortcut outside the row. */}
        <span className="min-w-0 truncate">{props.row.label}</span>
        {props.row.keybind && (
          // Phones have no keyboard: both menus hide the hints there.
          <span className="text-muted mobile-hide-shortcut-hints ml-auto shrink-0 pl-2 text-[10px]">
            ({formatKeybind(props.row.keybind)})
          </span>
        )}
      </span>
    </button>
  );
}

interface WorkspaceActionsMenuContentProps {
  /** Decides which rows show; see getWorkspaceActionGroups. */
  state: WorkspaceActionsState;
  /** A row shows only when its caller wires a handler (stories may leave some out). */
  actions: WorkspaceActionHandlers;
  isPinned: boolean;
  /** Sidebar rows: completed sub-agents are shown now. */
  subAgentsExpanded?: boolean;
  onCloseMenu: () => void;
}

/** The rows the menu renders: the shared gating, minus rows the caller did not wire. */
export function getShownWorkspaceActionGroups(
  state: WorkspaceActionsState,
  actions: WorkspaceActionHandlers
): WorkspaceActionId[][] {
  return getWorkspaceActionGroups(state)
    .map((group) => group.filter((id) => actions[id] != null))
    .filter((group) => group.length > 0);
}

function getActionRow(id: WorkspaceActionId, props: WorkspaceActionsMenuContentProps): ActionRow {
  if (id === "togglePinned" && props.isPinned) return UNPIN_ROW;
  if (id === "toggleSubAgents" && props.subAgentsExpanded === true) return HIDE_SUB_AGENTS_ROW;
  return ACTION_ROWS[id];
}

/**
 * Shared menu content for workspace actions, used by both sidebar rows and the workspace menu bar.
 * Both menus take their rows from getWorkspaceActionGroups, so the two entry points cannot drift.
 * It renders only while its popover is open, so the gating runs only then.
 */
export const WorkspaceActionsMenuContent: React.FC<WorkspaceActionsMenuContentProps> = (props) => {
  const groups = getShownWorkspaceActionGroups(props.state, props.actions);
  return (
    // No menu role on purpose: the menu/menuitem pattern also requires roving Tab focus and
    // changes how the sidebar row's long-press handling sees this portal. The Radix Popover
    // stays a dialog of buttons, and the arrow keys are an extra on top of Tab (#6103).
    <div onKeyDown={(event) => handleMenuKeyDown(event, groups.flat(), props)}>
      {groups.map((group, groupIndex) => (
        <React.Fragment key={group[0]}>
          {groupIndex > 0 && (
            <div role="separator" className="border-separator-light my-1 border-t" />
          )}
          {group.map((id) => (
            <WorkspaceActionButton
              key={id}
              id={id}
              row={getActionRow(id, props)}
              onClick={(e) => {
                e.stopPropagation();
                props.onCloseMenu();
                props.actions[id]?.(e.currentTarget);
              }}
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  );
};

const ROW_KEYBINDS = (Object.keys(ACTION_ROWS) as WorkspaceActionId[]).flatMap((id) => {
  const keybind = ACTION_ROWS[id].keybind;
  return keybind ? [{ id, keybind }] : [];
});

/**
 * While a menu is open, the keys its rows hint act on the menu's own workspace (#6328). A sidebar
 * row's menu is often not the selected workspace's, and the global handlers act on the selected
 * one, so the menu takes the key before they see it. A row key whose row this menu hides does
 * nothing here (fail closed) instead of reaching the selected workspace.
 */
function handleRowShortcut(
  event: React.KeyboardEvent<HTMLElement>,
  shown: WorkspaceActionId[],
  props: WorkspaceActionsMenuContentProps
): boolean {
  // Ctrl+Alt chords: AltGr types characters with the same modifiers.
  if (isAltGraphPressed(event)) return false;
  const match = ROW_KEYBINDS.find((row) => matchesKeybind(event, row.keybind));
  if (!match) return false;
  event.preventDefault();
  stopKeyboardPropagation(event);
  // A held key auto-repeats: run the row once (Codex on #6398).
  if (event.repeat || !shown.includes(match.id)) return true;
  const rowButton = event.currentTarget.querySelector<HTMLElement>(
    `[data-workspace-action-row="${match.id}"]`
  );
  props.onCloseMenu();
  props.actions[match.id]?.(rowButton ?? event.currentTarget);
  return true;
}

function handleMenuKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  shown: WorkspaceActionId[],
  props: WorkspaceActionsMenuContentProps
) {
  if (!handleRowShortcut(event, shown, props)) handleRowArrowKeys(event);
}

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
