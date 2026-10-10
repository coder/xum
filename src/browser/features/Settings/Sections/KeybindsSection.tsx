import { KEYBINDS, formatKeybind, isKeybindDeprecated } from "@/browser/utils/ui/keybinds";

/**
 * Human-readable labels for keybind IDs.
 * Derived from the comments in keybinds.ts.
 */
const KEYBIND_LABELS: Record<keyof typeof KEYBINDS, string> = {
  TOGGLE_AGENT: "Open agent picker",
  CYCLE_AGENT: "Cycle agent",
  SEND_MESSAGE: "Send message",
  SEND_QUEUED_MESSAGE_NOW: "Send queued message now",
  SEND_HELD_INPUT: "Send oldest unsent message",
  DISCARD_HELD_INPUT: "Discard oldest unsent message",
  FOCUS_BACKGROUND_PROCESSES: "Focus background processes",
  BACKGROUND_PROCESS_NEXT: "Next background process",
  BACKGROUND_PROCESS_PREV: "Previous background process",
  BACKGROUND_PROCESS_VIEW_OUTPUT: "View background process output",
  BACKGROUND_PROCESS_TERMINATE: "Terminate background process",
  SEND_MESSAGE_AFTER_TURN: "Send after turn",
  NEW_LINE: "Insert newline",
  CANCEL: "Cancel / Close modal",
  CANCEL_EDIT: "Cancel editing message",
  SAVE_EDIT: "Save edit",
  INTERRUPT_STREAM_VIM: "Interrupt stream (Vim mode)",
  INTERRUPT_STREAM_NORMAL: "Interrupt stream",
  RESUME_STREAM: "Retry or continue interrupted stream",
  FOCUS_INPUT_I: "Focus input (i)",
  FOCUS_INPUT_A: "Focus input (a)",
  NEW_WORKSPACE: "New workspace",
  NEW_SCRATCH_CHAT: "New scratch chat",
  EDIT_WORKSPACE_TITLE: "Edit workspace title",
  GENERATE_WORKSPACE_TITLE: "Generate new title",
  ARCHIVE_WORKSPACE: "Archive workspace",
  PIN_WORKSPACE: "Pin/unpin chat",
  MOVE_PINNED_UP: "Move pinned chat up",
  MOVE_PINNED_DOWN: "Move pinned chat down",
  JUMP_TO_BOTTOM: "Jump to bottom",
  LOAD_OLDER_MESSAGES: "Load older messages",
  NEXT_WORKSPACE: "Next workspace",
  PREV_WORKSPACE: "Previous workspace",
  TOGGLE_SIDEBAR: "Toggle sidebar",
  CYCLE_MODEL: "Cycle model",
  OPEN_TERMINAL: "New terminal",
  OPEN_IN_EDITOR: "Open in editor",
  CONFIGURE_MCP: "Configure MCP servers",
  CONFIGURE_HEARTBEAT: "Configure heartbeat",
  CONFIGURE_UNRELATED_MESSAGING: "Configure messages from other workspaces",
  OPEN_COMMAND_PALETTE: "Command palette",
  OPEN_COMMAND_PALETTE_ACTIONS: "Command palette (alternate)",
  TOGGLE_THINKING: "Toggle thinking",
  INCREASE_THINKING: "Increase thinking level",
  DECREASE_THINKING: "Decrease thinking level",
  TOGGLE_FAST_MODE: "Toggle fast mode",
  TOGGLE_ULTRAFAST_MODE: "Toggle ultrafast mode",
  TOGGLE_COMPUTER_USE: "Toggle computer use",
  STOP_COMPUTER_USE: "Stop computer use (works in any app)",
  FOCUS_CHAT: "Focus chat input",
  NEW_SIDEBAR_TAB: "New sidebar tab",
  CLOSE_TAB: "Close tab",
  REVEAL_TIMELINE_EVENT: "Reveal selected timeline event in transcript",
  OPEN_TIMELINE_DIALOG: "Open timeline dialog (small viewports)",
  OPEN_STATS_DIALOG: "Open Stats dialog (small viewports)",
  OPEN_ARTIFACTS_TAB: "Open Artifacts tab",
  TOGGLE_ARTIFACT_FULLSCREEN: "Toggle artifact fullscreen (Artifacts tab)",
  NEXT_ARTIFACT: "Next artifact (Artifacts tab)",
  PREV_ARTIFACT: "Previous artifact (Artifacts tab)",
  RELOAD_ARTIFACT: "Reload artifact (Artifacts tab)",
  UNPIN_ARTIFACT_FILE: "Unpin the selected pinned file (Artifacts tab)",
  ZOOM_IN_ARTIFACT_IMAGE: "Zoom in on image artifact",
  ZOOM_OUT_ARTIFACT_IMAGE: "Zoom out of image artifact",
  FIT_ARTIFACT_IMAGE: "Fit image artifact to panel",
  ACTUAL_SIZE_ARTIFACT_IMAGE: "Image artifact at actual size",
  PIN_ARTIFACT_TO_PROJECT_SHELF: "Pin artifact to project shelf (Artifacts tab)",
  PIN_ARTIFACT_TO_GLOBAL_SHELF: "Pin artifact to global shelf (Artifacts tab)",
  UNPIN_SHELF_ENTRY: "Unpin shelf entry (Artifacts tab)",
  TOGGLE_ARTIFACT_ANNOTATE: "Toggle artifact annotate mode (Artifacts tab)",
  SEND_ARTIFACT_MESSAGE: "Send the message an artifact asks to send (Artifacts tab)",
  DISMISS_ARTIFACT_MESSAGE: "Dismiss the message an artifact asks to send (Artifacts tab)",
  REVEAL_LAST_PROMPT: "Reveal last prompt in transcript",
  SIDEBAR_TAB_1: "Tab 1",
  SIDEBAR_TAB_2: "Tab 2",
  SIDEBAR_TAB_3: "Tab 3",
  SIDEBAR_TAB_4: "Tab 4",
  SIDEBAR_TAB_5: "Tab 5",
  SIDEBAR_TAB_6: "Tab 6",
  SIDEBAR_TAB_7: "Tab 7",
  SIDEBAR_TAB_8: "Tab 8",
  SIDEBAR_TAB_9: "Tab 9",
  REFRESH_REVIEW: "Refresh diff",
  FOCUS_REVIEW_SEARCH: "Search in review",
  FOCUS_REVIEW_SEARCH_QUICK: "Search in review (quick)",
  TOGGLE_HUNK_READ: "Toggle hunk read",
  MARK_HUNK_READ: "Mark hunk read",
  MARK_HUNK_UNREAD: "Mark hunk unread",
  MARK_FILE_READ: "Mark file read",
  TOGGLE_HUNK_COLLAPSE: "Toggle hunk collapse",
  TOGGLE_ASSISTED_REVIEW: "Toggle Assisted filter",
  OPEN_SETTINGS: "Open settings",
  OPEN_ANALYTICS: "Open analytics",
  SAVE_SESSION_TAPES: "Save open session tapes (experimental)",
  REVEAL_SESSION_TAPES: "Reveal session tapes folder (experimental)",
  OPEN_SERVER_WINDOW: "Open server window (desktop)",
  REPORT_SLOWNESS: "Report slowness (flight recorder experiment)",
  TOGGLE_VOICE_INPUT: "Toggle voice input",
  NAVIGATE_BACK: "Navigate back",
  NAVIGATE_FORWARD: "Navigate forward",
  TOGGLE_NOTIFICATIONS: "Toggle notifications",
  TOGGLE_DRIFT_MODE: "Toggle git drift lines/commits",
  SHOW_WORKSPACE_DETAILS: "Show workspace details",
  SHOW_LAST_PROMPT: "Show last prompt",
  SETTINGS_BACKUP_SAVE: "Save backup settings",
  SETTINGS_BACKUP_VALIDATE: "Validate backup repository",
  SETTINGS_BACKUP_PREVIEW: "Preview settings backup",
  SETTINGS_BACKUP_PUSH: "Back up settings",
  SETTINGS_BACKUP_RESTORE: "Restore settings backup",
  SETTINGS_BACKUP_OVERRIDE_SECRET_SCAN: "Toggle secret scan override",
  SETTINGS_BACKUP_APPROVE_COMMANDS: "Toggle MCP command approval",
  SETTINGS_BACKUP_TOGGLE_INSTRUCTIONS: "Toggle global instructions backup",
  SETTINGS_BACKUP_TOGGLE_AGENTS: "Toggle agent definitions backup",
  SETTINGS_BACKUP_TOGGLE_SKILLS: "Toggle agent skills backup",
  SETTINGS_BACKUP_TOGGLE_GLOBAL_MEMORY: "Toggle global memory backup",
  SETTINGS_BACKUP_TOGGLE_PREFERENCES: "Toggle preferences backup",
  SETTINGS_BACKUP_TOGGLE_MCP: "Toggle MCP configuration backup",
  SETTINGS_BACKUP_TOGGLE_MCP_HEADERS: "Toggle MCP header values in backup",
  SETTINGS_BACKUP_TOGGLE_MCP_COMMANDS: "Toggle MCP stdio commands in backup",
  SETTINGS_BACKUP_TOGGLE_PROJECTS: "Toggle project backup",
  SETTINGS_BACKUP_TOGGLE_GLOBAL_ARTIFACTS: "Toggle global artifact backup",
  // Modal-only keybinds; intentionally omitted from KEYBIND_GROUPS.
  CONFIRM_DIALOG_YES: "Confirm dialog action",
  CONFIRM_DIALOG_NO: "Cancel dialog action",
  TOGGLE_REVIEW_IMMERSIVE: "Toggle immersive review",
  REVIEW_NEXT_FILE: "Next file (immersive)",
  REVIEW_PREV_FILE: "Previous file (immersive)",
  REVIEW_NEXT_HUNK: "Next hunk (immersive)",
  REVIEW_PREV_HUNK: "Previous hunk (immersive)",
  REVIEW_CURSOR_DOWN: "Line cursor down (immersive)",
  REVIEW_CURSOR_UP: "Line cursor up (immersive)",
  REVIEW_CURSOR_JUMP_DOWN: "Jump 10 lines down (immersive)",
  REVIEW_CURSOR_JUMP_UP: "Jump 10 lines up (immersive)",
  REVIEW_QUICK_LIKE: "Quick like (immersive)",
  REVIEW_QUICK_DISLIKE: "Quick dislike (immersive)",
  REVIEW_COMMENT: "Add comment (immersive)",
  REVIEW_FOCUS_NOTES: "Focus notes sidebar (immersive)",
  REVIEW_COPY_FILE: "Copy file contents (immersive)",
  TOGGLE_PLAN_ANNOTATE: "Toggle plan annotate mode",
  RUN_LATEST_PLAN_ACTION: "Implement latest plan",
  // Transcript-menu-only actions show their shortcuts in that menu.
  COPY_MARKDOWN: "Copy Markdown (transcript context menu)",
  // Image-viewer-scoped keybinds (lightbox / image context menu); intentionally
  // omitted from KEYBIND_GROUPS because they only apply while an image surface
  // is focused.
  IMAGE_COPY: "Copy image (image viewer)",
  IMAGE_DOWNLOAD: "Download image (image viewer)",
  // Easter egg keybind; intentionally omitted from KEYBIND_GROUPS.
  TOGGLE_POWER_MODE: "",
};

/** Groups for organizing keybinds in the UI */
const KEYBIND_GROUPS: Array<{
  label: string;
  keys: Array<keyof typeof KEYBINDS>;
}> = [
  {
    label: "General",
    keys: [
      "TOGGLE_AGENT",
      "CYCLE_AGENT",
      "OPEN_COMMAND_PALETTE",
      "OPEN_SETTINGS",
      "OPEN_ANALYTICS",
      "OPEN_SERVER_WINDOW",
      "REPORT_SLOWNESS",
      "SAVE_SESSION_TAPES",
      "REVEAL_SESSION_TAPES",
      "TOGGLE_SIDEBAR",
      "CYCLE_MODEL",
      "DECREASE_THINKING",
      "INCREASE_THINKING",
      "TOGGLE_FAST_MODE",
      "TOGGLE_ULTRAFAST_MODE",
      "TOGGLE_COMPUTER_USE",
      "STOP_COMPUTER_USE",
      "TOGGLE_NOTIFICATIONS",
      "TOGGLE_DRIFT_MODE",
      "SHOW_WORKSPACE_DETAILS",
      "CONFIGURE_MCP",
      "CONFIGURE_HEARTBEAT",
      "CONFIGURE_UNRELATED_MESSAGING",
    ],
  },
  {
    label: "Chat",
    keys: [
      "SEND_MESSAGE",
      "SEND_MESSAGE_AFTER_TURN",
      "NEW_LINE",
      "FOCUS_CHAT",
      "FOCUS_INPUT_I",
      "FOCUS_INPUT_A",
      "TOGGLE_PLAN_ANNOTATE",
      "RUN_LATEST_PLAN_ACTION",
      "CANCEL",
      "INTERRUPT_STREAM_NORMAL",
      "INTERRUPT_STREAM_VIM",
      "RESUME_STREAM",
      "TOGGLE_VOICE_INPUT",
      "SHOW_LAST_PROMPT",
      "REVEAL_LAST_PROMPT",
      "FOCUS_BACKGROUND_PROCESSES",
    ],
  },
  {
    label: "Editing",
    keys: ["SAVE_EDIT", "CANCEL_EDIT"],
  },
  {
    label: "Navigation",
    keys: [
      "NEW_WORKSPACE",
      "NEW_SCRATCH_CHAT",
      "EDIT_WORKSPACE_TITLE",
      "GENERATE_WORKSPACE_TITLE",
      "ARCHIVE_WORKSPACE",
      "NEXT_WORKSPACE",
      "PREV_WORKSPACE",
      "NAVIGATE_BACK",
      "NAVIGATE_FORWARD",
      "JUMP_TO_BOTTOM",
      "LOAD_OLDER_MESSAGES",
    ],
  },
  {
    label: "Sidebar Tabs",
    keys: [
      "SIDEBAR_TAB_1",
      "SIDEBAR_TAB_2",
      "SIDEBAR_TAB_3",
      "SIDEBAR_TAB_4",
      "SIDEBAR_TAB_5",
      "SIDEBAR_TAB_6",
      "SIDEBAR_TAB_7",
      "SIDEBAR_TAB_8",
      "SIDEBAR_TAB_9",
      "NEW_SIDEBAR_TAB",
      "CLOSE_TAB",
      "REVEAL_TIMELINE_EVENT",
      "OPEN_TIMELINE_DIALOG",
      "OPEN_STATS_DIALOG",
    ],
  },
  {
    label: "Artifacts",
    keys: [
      "OPEN_ARTIFACTS_TAB",
      "TOGGLE_ARTIFACT_FULLSCREEN",
      "NEXT_ARTIFACT",
      "PREV_ARTIFACT",
      "RELOAD_ARTIFACT",
      "UNPIN_ARTIFACT_FILE",
      "ZOOM_IN_ARTIFACT_IMAGE",
      "ZOOM_OUT_ARTIFACT_IMAGE",
      "FIT_ARTIFACT_IMAGE",
      "ACTUAL_SIZE_ARTIFACT_IMAGE",
      "PIN_ARTIFACT_TO_PROJECT_SHELF",
      "PIN_ARTIFACT_TO_GLOBAL_SHELF",
      "UNPIN_SHELF_ENTRY",
      "TOGGLE_ARTIFACT_ANNOTATE",
      "SEND_ARTIFACT_MESSAGE",
      "DISMISS_ARTIFACT_MESSAGE",
    ],
  },
  {
    label: "Code Review",
    keys: [
      "REFRESH_REVIEW",
      "FOCUS_REVIEW_SEARCH",
      "FOCUS_REVIEW_SEARCH_QUICK",
      "TOGGLE_HUNK_READ",
      "MARK_HUNK_READ",
      "MARK_HUNK_UNREAD",
      "MARK_FILE_READ",
      "TOGGLE_HUNK_COLLAPSE",
      "TOGGLE_ASSISTED_REVIEW",
    ],
  },
  {
    label: "Immersive Review",
    keys: [
      "TOGGLE_REVIEW_IMMERSIVE",
      "REVIEW_NEXT_FILE",
      "REVIEW_PREV_FILE",
      "REVIEW_NEXT_HUNK",
      "REVIEW_PREV_HUNK",
      "REVIEW_QUICK_LIKE",
      "REVIEW_QUICK_DISLIKE",
      "REVIEW_COMMENT",
      "REVIEW_FOCUS_NOTES",
      "REVIEW_COPY_FILE",
    ],
  },
  {
    label: "Settings backup",
    keys: [
      "SETTINGS_BACKUP_SAVE",
      "SETTINGS_BACKUP_VALIDATE",
      "SETTINGS_BACKUP_PREVIEW",
      "SETTINGS_BACKUP_PUSH",
      "SETTINGS_BACKUP_RESTORE",
      "SETTINGS_BACKUP_OVERRIDE_SECRET_SCAN",
      "SETTINGS_BACKUP_APPROVE_COMMANDS",
      "SETTINGS_BACKUP_TOGGLE_INSTRUCTIONS",
      "SETTINGS_BACKUP_TOGGLE_AGENTS",
      "SETTINGS_BACKUP_TOGGLE_SKILLS",
      "SETTINGS_BACKUP_TOGGLE_GLOBAL_MEMORY",
      "SETTINGS_BACKUP_TOGGLE_PREFERENCES",
      "SETTINGS_BACKUP_TOGGLE_MCP",
      "SETTINGS_BACKUP_TOGGLE_MCP_HEADERS",
      "SETTINGS_BACKUP_TOGGLE_MCP_COMMANDS",
      "SETTINGS_BACKUP_TOGGLE_PROJECTS",
      "SETTINGS_BACKUP_TOGGLE_GLOBAL_ARTIFACTS",
    ],
  },
  {
    label: "External",
    keys: ["OPEN_TERMINAL", "OPEN_IN_EDITOR"],
  },
];

// Some actions have multiple equivalent shortcuts; render alternates on the same row.
const KEYBIND_DISPLAY_ALTERNATES: Partial<
  Record<keyof typeof KEYBINDS, Array<keyof typeof KEYBINDS>>
> = {
  OPEN_COMMAND_PALETTE: ["OPEN_COMMAND_PALETTE_ACTIONS"],
};

export function KeybindsSection() {
  const visibleKeybindGroups = KEYBIND_GROUPS.map((group) => ({
    ...group,
    keys: group.keys.filter((key) => !isKeybindDeprecated(KEYBINDS[key])),
  })).filter((group) => group.keys.length > 0);

  return (
    <div className="space-y-6">
      {visibleKeybindGroups.map((group) => (
        <div key={group.label}>
          <h3 className="text-foreground mb-3 text-sm font-medium">{group.label}</h3>
          <div className="space-y-1">
            {group.keys.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between rounded px-2 py-1.5 text-sm"
              >
                <span className="text-muted">{KEYBIND_LABELS[key]}</span>
                <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-xs">
                  {[key, ...(KEYBIND_DISPLAY_ALTERNATES[key] ?? [])]
                    .map((keybindId) => formatKeybind(KEYBINDS[keybindId]))
                    .join(" / ")}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
