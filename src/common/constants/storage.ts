/**
 * LocalStorage Key Constants and Helpers
 * These keys are used for persisting state in localStorage
 */

import { DEFAULT_CREATION_DRAFT_ID, DRAFT_ID_PATTERN } from "@/constants/drafts";

/**
 * Scope ID Helpers
 * These create consistent scope identifiers for storage keys
 */

/**
 * Get project-scoped ID for storage keys (e.g., model preference before workspace creation)
 * Format: "__project__/{projectPath}"
 * Uses "/" delimiter to safely handle projectPath values containing special characters
 */
export function getProjectScopeId(projectPath: string): string {
  return `__project__/${projectPath}`;
}

/**
 * Get pending workspace scope ID for storage keys (e.g., input text during workspace creation)
 * Format: "__pending__{projectPath}"
 */
export function getPendingScopeId(projectPath: string): string {
  return `__pending__${projectPath}`;
}

/**
 * Get draft workspace scope ID for storage keys.
 *
 * This is used for UI-only workspace creation drafts so multiple pending drafts can
 * exist per project without colliding.
 *
 * Format: "__draft__/{projectPath}/{draftId}"
 */
export function getDraftScopeId(projectPath: string, draftId: string): string {
  return `${DRAFT_SCOPE_ID_PREFIX}${projectPath}/${draftId}`;
}

const DRAFT_SCOPE_ID_PREFIX = "__draft__/";

/**
 * Global scope ID for workspace-independent preferences
 */
export const GLOBAL_SCOPE_ID = "__global__";

/**
 * Get the localStorage key for the UI theme preference (global)
 * Format: "uiTheme"
 */
export const UI_THEME_KEY = "uiTheme";

/**
 * LocalStorage key for the hidden Power Mode UI easter egg (global).
 */
export const POWER_MODE_ENABLED_KEY = "powerModeEnabled";

/**
 * Get the localStorage key for the last selected provider when adding custom models (global)
 * Format: "lastCustomModelProvider"
 */
export const LAST_CUSTOM_MODEL_PROVIDER_KEY = "lastCustomModelProvider";

/**
 * Get the localStorage key for the currently selected workspace (global)
 * Format: "selectedWorkspace"
 */
export const SELECTED_WORKSPACE_KEY = "selectedWorkspace";

/**
 * Get the localStorage key for the last visited app route (global).
 *
 * Desktop reloads and restarts boot from file:///index.html, so we persist the
 * in-app route separately to restore the page the user was already on.
 */
export const LAST_VISITED_ROUTE_KEY = "lastVisitedRoute";

/**
 * User preference for what to show on app launch (global).
 * Values: "dashboard" (legacy storage value that now opens the recent project page)
 * | "new-chat" | "last-workspace"
 */
export const LAUNCH_BEHAVIOR_KEY = "launchBehavior";

export type LaunchBehavior = "dashboard" | "new-chat" | "last-workspace";

/**
 * Synchronous mirror for the backend full-width transcript preference.
 */
export const CHAT_TRANSCRIPT_FULL_WIDTH_KEY = "chatTranscriptFullWidth";

/**
 * Ordered project paths in the left sidebar.
 * Format: "mux:projectOrder"
 */
export const PROJECT_ORDER_KEY = "mux:projectOrder";

/**
 * Get the localStorage key for expanded projects in sidebar (global)
 * Format: "expandedProjects"
 */
export const EXPANDED_PROJECTS_KEY = "expandedProjects";

/**
 * Legacy localStorage key of the creation draft list (now the backend drafts/list.json, #5225);
 * only read by DraftStore's one-way import and then removed.
 *
 * Value: Record<string, Array<{ draftId: string; subProjectPath: string | null; createdAt: number }>>
 * Keyed by projectPath.
 */
export const WORKSPACE_DRAFTS_BY_PROJECT_KEY = "workspaceDraftsByProject";

/**
 * LocalStorage keys for Xum Gateway routing preferences (global).
 *
 * Note: localStorage is origin-scoped (includes port), so these values are also
 * mirrored into ~/.xum/config.json for portability across server ports.
 */
export const GATEWAY_MODELS_KEY = "gateway-models"; // enabled model IDs (canonical)
export const GATEWAY_ENABLED_KEY = "gateway-enabled"; // global on/off toggle

/**
 * Storage key for runtime enablement settings (shared via ~/.xum/config.json).
 */
export const RUNTIME_ENABLEMENT_KEY = "runtimeEnablement";

/**
 * Storage key for global default runtime selection (shared via ~/.xum/config.json).
 */
export const DEFAULT_RUNTIME_KEY = "defaultRuntime";

/**
 * Browser-mode server auth token. Stored as a raw string (not JSON): older builds read it with a
 * raw getItem, so the format must stay raw for downgrades.
 */
export const AUTH_TOKEN_KEY = "mux:auth-token";

/** Recently used command palette action ids (string[], most recent first). */
export const COMMAND_PALETTE_RECENT_KEY = "commandPalette:recent";

/** Most recent command palette actions kept in COMMAND_PALETTE_RECENT_KEY. */
export const COMMAND_PALETTE_RECENT_MAX_ENTRIES = 20;

/** Telemetry first-launch flag (true once the app has started before). */
export const FIRST_LAUNCH_KEY = "mux_first_launch_complete";

/**
 * Get the localStorage key for cached MCP server test results (per project)
 * Format: "mcpTestResults:{projectPath}"
 * Stores: Record<serverName, CachedMCPTestResult>
 */
export function getMCPTestResultsKey(projectPath: string, workspaceId?: string): string {
  // Workspace-scoped results (agent-plugins experiment): plugin tool lists
  // follow each workspace's checkout, so they must not be shared per-project.
  return workspaceId
    ? `mcpTestResults:${projectPath}:${workspaceId}`
    : `mcpTestResults:${projectPath}`;
}

/**
 * Get the localStorage key for cached archived workspaces per project
 * Format: "archivedWorkspaces:{projectPath}"
 * Stores: Array of workspace metadata objects (optimistic cache)
 */
export function getArchivedWorkspacesKey(projectPath: string): string {
  return `archivedWorkspaces:${projectPath}`;
}

/**
 * Get the localStorage key for archived workspaces expand/collapse state.
 * Format: "archivedWorkspacesExpanded:{projectPath}"
 * Stores: boolean (true = expanded)
 */
export function getArchivedWorkspacesExpandedKey(projectPath: string): string {
  return `archivedWorkspacesExpanded:${projectPath}`;
}

/**
 * Get the localStorage key for cached MCP servers per project
 * Format: "mcpServers:{projectPath}"
 * Stores: Record<serverName, MCPServerInfo> (optimistic cache)
 */
export function getMCPServersKey(projectPath: string): string {
  return `mcpServers:${projectPath}`;
}

/**
 * Get the localStorage key for the last selected Browser-tab session for a project.
 * Format: "browserSelectedSession:{projectPath}"
 */
export function getBrowserSelectedSessionKey(projectPath: string): string {
  return `browserSelectedSession:${projectPath}`;
}

/**
 * Get the localStorage key for thinking level preference per scope (workspace/project).
 * Format: "thinkingLevel:{scopeId}"
 */
export function getThinkingLevelKey(scopeId: string): string {
  return `thinkingLevel:${scopeId}`;
}

/**
 * Get the localStorage key for the OpenAI pro reasoning-mode toggle per scope
 * (workspace/project). Format: "reasoningMode:{scopeId}"
 */
export function getReasoningModeKey(scopeId: string): string {
  return `reasoningMode:${scopeId}`;
}

/**
 * Get the localStorage key for per-agent workspace AI overrides cache.
 * Format: "workspaceAiSettingsByAgent:{workspaceId}"
 */
export function getWorkspaceAISettingsByAgentKey(workspaceId: string): string {
  return `workspaceAiSettingsByAgent:${workspaceId}`;
}

/**
 * LEGACY: Get the localStorage key for thinking level preference per model (global).
 * Format: "thinkingLevel:model:{modelName}"
 *
 * Kept for one-time migration to per-workspace thinking.
 */
export function getThinkingLevelByModelKey(modelName: string): string {
  return `thinkingLevel:model:${modelName}`;
}

/**
 * Get the localStorage key for the user's preferred model for a workspace
 */
export function getModelKey(workspaceId: string): string {
  return `model:${workspaceId}`;
}

/**
 * Get the localStorage key for the composer's Auto selection (auto-model-routing
 * experiment). Kept separate from the model key so the concrete model survives
 * as the routing fallback.
 */
export function getAutoModelRoutingKey(workspaceId: string): string {
  return `autoModelRouting:${workspaceId}`;
}

/**
 * Get the localStorage key for the composer's Auto thinking-level selection
 * (auto-model-routing experiment). Independent of the model Auto key: either
 * dimension can be routed while the other stays concrete.
 */
export function getAutoThinkingLevelKey(workspaceId: string): string {
  return `autoThinkingLevel:${workspaceId}`;
}

/**
 * Explicit routing picks stay separate from the metadata-hydrated per-agent AI settings
 * cache, which carries no routing state.
 */
export function getAutoRoutingChoiceByAgentKey(workspaceId: string): string {
  return `autoRoutingChoiceByAgent:${workspaceId}`;
}

/**
 * Get the localStorage key for the input text for a workspace.
 * Only the VS Code webview composer still writes it; the desktop/web composer keeps drafts on the
 * backend and reads this key once for the legacy draft import.
 */
export function getInputKey(workspaceId: string): string {
  return `input:${workspaceId}`;
}

/**
 * Get the localStorage key for the pinned TODO panel expansion state.
 * Format: "pinnedTodoExpanded:{workspaceId}"
 */
export function getPinnedTodoExpandedKey(workspaceId: string): string {
  return `pinnedTodoExpanded:${workspaceId}`;
}

/**
 * Get the localStorage key for the sub-agent chat decoration expansion state.
 * Format: "subAgentTasksExpanded:{workspaceId}"
 */
export function getSubAgentTasksExpandedKey(workspaceId: string): string {
  return `subAgentTasksExpanded:${workspaceId}`;
}

/**
 * Get the localStorage key for per-workspace transcript auto-expand preferences.
 *
 * Stores the user's last expand/collapse intent, shaped like
 * { thinking?: boolean; tools?: Record<toolName, boolean> } (see AutoExpandPrefs in
 * useStickyExpand.ts). Thinking blocks share one preference; tool blocks are keyed
 * by tool name so each tool remembers its own intent. New thinking/tool blocks
 * inherit this as their initial expand state; already-mounted blocks are never
 * retroactively changed.
 *
 * Format: "auto-expand:{workspaceId}"
 */
export function getAutoExpandPrefsKey(workspaceId: string): string {
  return `auto-expand:${workspaceId}`;
}

/**
 * Get the localStorage key for persisted workspace name-generation state.
 *
 * This is used by the workspace creation flow so drafts can preserve their
 * auto-generated (or manually edited) workspace name independently.
 *
 * Format: "workspaceNameState:{scopeId}"
 */
export function getWorkspaceNameStateKey(scopeId: string): string {
  return `workspaceNameState:${scopeId}`;
}

/**
 * Get the localStorage key for the input attachments for a scope.
 * Format: "inputAttachments:{scopeId}"
 *
 * Note: The input key functions accept any string scope ID. For normal workspaces
 * this is the workspaceId; for creation mode it's a pending scope ID.
 */
export function getInputAttachmentsKey(scopeId: string): string {
  return `inputAttachments:${scopeId}`;
}

/**
 * Get the localStorage key for pending initial send errors after workspace creation.
 * Stored so the workspace view can surface a toast after navigation.
 * Format: "pendingSendError:{workspaceId}"
 */
export function getPendingWorkspaceSendErrorKey(workspaceId: string): string {
  return `pendingSendError:${workspaceId}`;
}

/**
 * Get the localStorage key marking that a creation draft transferred into this
 * workspace was sent with forced project-path skill discovery. The retry from
 * the workspace composer reads it so the slash skill resolves against the same
 * source as the original send. Cleared after the next successful send.
 * Format: "pendingDraftProjectSkillDiscovery:{workspaceId}"
 */
export function getPendingDraftSkillDiscoveryKey(workspaceId: string): string {
  return `pendingDraftProjectSkillDiscovery:${workspaceId}`;
}

/**
 * LEGACY: Get the localStorage key for pre-backend auto-retry preference.
 *
 * Kept only for one-way migration during onChat subscription.
 */
export function getAutoRetryKey(workspaceId: string): string {
  return `${workspaceId}-autoRetry`;
}

/**
 * Get the localStorage key for the selected agent definition id for a scope.
 * Format: "agentId:{scopeId}"
 */
export function getAgentIdKey(scopeId: string): string {
  return `agentId:${scopeId}`;
}

/**
 * Get the localStorage key for the pinned third agent id for a scope.
 * Format: "pinnedAgentId:{scopeId}"
 */
export function getPinnedAgentIdKey(scopeId: string): string {
  return `pinnedAgentId:${scopeId}`;
}
/**
 * Get the localStorage key for "disable workspace agents" toggle per scope.
 * When true, workspace-specific agents are disabled - only built-in and global agents are loaded.
 * Useful for "unbricking" when iterating on agent files in a workspace worktree.
 * Format: "disableWorkspaceAgents:{scopeId}"
 */
export function getDisableWorkspaceAgentsKey(scopeId: string): string {
  return `disableWorkspaceAgents:${scopeId}`;
}
/**
 * Get the localStorage key for the default runtime for a project
 * Defaults to worktree if not set; can only be changed via the "Default for project" checkbox.
 * Format: "runtime:{projectPath}"
 */
export function getRuntimeKey(projectPath: string): string {
  return `runtime:${projectPath}`;
}

/**
 * Get the localStorage key for trunk branch preference for a project
 * Stores the last used trunk branch when creating a workspace
 * Format: "trunkBranch:{projectPath}"
 */
export function getTrunkBranchKey(projectPath: string): string {
  return `trunkBranch:${projectPath}`;
}

/**
 * Get the localStorage key for whether to show the "Initialize with AGENTS.md" nudge for a project.
 * Set to true when a project is first added; cleared when user dismisses or runs /init.
 * Format: "agentsInitNudge:{projectPath}"
 */
export function getAgentsInitNudgeKey(projectPath: string): string {
  return `agentsInitNudge:${projectPath}`;
}

/**
 * Get the localStorage key for the last runtime config used per provider for a project.
 *
 * Value shape is a provider-keyed object (e.g. { ssh: { host }, docker: { image } }) so we can
 * add new options without adding more storage keys.
 *
 * Format: "lastRuntimeConfig:{projectPath}"
 */
export function getLastRuntimeConfigKey(projectPath: string): string {
  return `lastRuntimeConfig:${projectPath}`;
}

/**
 * Get the localStorage key for the default model (global).
 *
 * Note: This is used as a fallback when creating new workspaces.
 * Format: "model-default"
 */
export const DEFAULT_MODEL_KEY = "model-default";

/**
 * Get the localStorage key for the hidden models list (global).
 * Format: "hidden-models"
 */
export const HIDDEN_MODELS_KEY = "hidden-models";

/**
 * Get the localStorage key for cached per-agent AI defaults (global).
 * Format: "agentAiDefaults"
 */
export const AGENT_AI_DEFAULTS_KEY = "agentAiDefaults";

/**
 * Provider-specific AI options, synced through userPreferences.
 */
export const PROVIDER_OPTIONS_ANTHROPIC_KEY = "provider_options_anthropic";
export const PROVIDER_OPTIONS_GOOGLE_KEY = "provider_options_google";

/**
 * Get the localStorage key for vim mode preference (global)
 * Format: "vimEnabled"
 */
export const VIM_ENABLED_KEY = "vimEnabled";

/**
 * Git status indicator display mode (global)
 * Stores: "line-delta" | "divergence"
 */

export const GIT_STATUS_INDICATOR_MODE_KEY = "gitStatusIndicatorMode";

/**
 * Editor configuration for "Open in Editor" feature (global)
 * Format: "editorConfig"
 */
export const EDITOR_CONFIG_KEY = "editorConfig";

export type EditorType = "vscode" | "cursor" | "zed" | "custom";

export interface EditorConfig {
  editor: EditorType;
  customCommand?: string; // Only when editor='custom'
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  editor: "vscode",
};

export const EDITOR_TYPES = ["vscode", "cursor", "zed", "custom"] as const;

export function isEditorType(value: unknown): value is EditorType {
  return typeof value === "string" && EDITOR_TYPES.includes(value as EditorType);
}

export function normalizeEditorConfig(value: unknown): EditorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_EDITOR_CONFIG;
  }

  const record = value as { editor?: unknown; customCommand?: unknown };
  const editor = isEditorType(record.editor) ? record.editor : DEFAULT_EDITOR_CONFIG.editor;
  const customCommand =
    typeof record.customCommand === "string" && record.customCommand.trim()
      ? record.customCommand
      : undefined;

  return { editor, customCommand };
}

/**
 * Transcript density display preference (global)
 * Stores: "normal" | "hyper"
 */
export const TRANSCRIPT_DENSITY_KEY = "transcriptDensity";

export const TRANSCRIPT_DENSITIES = ["normal", "hyper"] as const;

export type TranscriptDensity = (typeof TRANSCRIPT_DENSITIES)[number];

export const DEFAULT_TRANSCRIPT_DENSITY: TranscriptDensity = "normal";

export function isTranscriptDensity(value: unknown): value is TranscriptDensity {
  return typeof value === "string" && TRANSCRIPT_DENSITIES.includes(value as TranscriptDensity);
}

export function normalizeTranscriptDensity(value: unknown): TranscriptDensity {
  return isTranscriptDensity(value) ? value : DEFAULT_TRANSCRIPT_DENSITY;
}

/**
 * Collapsed bash tool summary display mode (global)
 * Stores: "command" | "intent-command" | "intent"
 */
export const BASH_COLLAPSED_SUMMARY_MODE_KEY = "bashCollapsedSummaryMode";

export const BASH_COLLAPSED_SUMMARY_MODES = ["command", "intent-command", "intent"] as const;

export type BashCollapsedSummaryMode = (typeof BASH_COLLAPSED_SUMMARY_MODES)[number];

export const DEFAULT_BASH_COLLAPSED_SUMMARY_MODE: BashCollapsedSummaryMode = "intent-command";

export function isBashCollapsedSummaryMode(value: unknown): value is BashCollapsedSummaryMode {
  return (
    typeof value === "string" &&
    BASH_COLLAPSED_SUMMARY_MODES.includes(value as BashCollapsedSummaryMode)
  );
}

export function normalizeBashCollapsedSummaryMode(value: unknown): BashCollapsedSummaryMode {
  return isBashCollapsedSummaryMode(value) ? value : DEFAULT_BASH_COLLAPSED_SUMMARY_MODE;
}

/**
 * Integrated terminal font configuration (global)
 * Stores: { fontFamily: string; fontSize: number }
 */
export const TERMINAL_FONT_CONFIG_KEY = "terminalFontConfig";

export interface TerminalFontConfig {
  fontFamily: string;
  fontSize: number;
}

export const DEFAULT_TERMINAL_FONT_CONFIG: TerminalFontConfig = {
  fontFamily: "Geist Mono, ui-monospace, monospace",
  fontSize: 13,
};

export function normalizeTerminalFontConfig(value: unknown): TerminalFontConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TERMINAL_FONT_CONFIG;
  }

  const record = value as { fontFamily?: unknown; fontSize?: unknown };
  const fontFamily =
    typeof record.fontFamily === "string" && record.fontFamily.trim()
      ? record.fontFamily
      : DEFAULT_TERMINAL_FONT_CONFIG.fontFamily;
  const fontSizeNumber = Number(record.fontSize);
  const fontSize =
    Number.isFinite(fontSizeNumber) && fontSizeNumber > 0
      ? fontSizeNumber
      : DEFAULT_TERMINAL_FONT_CONFIG.fontSize;

  return { fontFamily, fontSize };
}

/**
 * Terminal badge overlay configuration (global)
 * Scroll-fixed workspace/tab watermark rendered above the terminal canvas,
 * similar to iTerm2 badges. Stores: { enabled, template, position, opacity, fontSize }
 */
export const TERMINAL_BADGE_CONFIG_KEY = "terminalBadgeConfig";

export const TERMINAL_BADGE_POSITIONS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type TerminalBadgePosition = (typeof TERMINAL_BADGE_POSITIONS)[number];

export interface TerminalBadgeConfig {
  enabled: boolean;
  /** Supports {workspace}, {tab}, and {project} tokens. */
  template: string;
  position: TerminalBadgePosition;
  /** 0-1 */
  opacity: number;
  fontSize: number;
}

export const DEFAULT_TERMINAL_BADGE_CONFIG: TerminalBadgeConfig = {
  enabled: false,
  template: "{workspace} · {tab}",
  position: "top-right",
  opacity: 0.4,
  fontSize: 16,
};

function isTerminalBadgePosition(value: unknown): value is TerminalBadgePosition {
  return (
    typeof value === "string" && TERMINAL_BADGE_POSITIONS.includes(value as TerminalBadgePosition)
  );
}

export function normalizeTerminalBadgeConfig(value: unknown): TerminalBadgeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TERMINAL_BADGE_CONFIG;
  }

  const record = value as {
    enabled?: unknown;
    template?: unknown;
    position?: unknown;
    opacity?: unknown;
    fontSize?: unknown;
  };
  const enabled = record.enabled === true;
  const template =
    typeof record.template === "string" ? record.template : DEFAULT_TERMINAL_BADGE_CONFIG.template;
  const position = isTerminalBadgePosition(record.position)
    ? record.position
    : DEFAULT_TERMINAL_BADGE_CONFIG.position;
  const opacityNumber = Number(record.opacity);
  const opacity =
    Number.isFinite(opacityNumber) && opacityNumber > 0 && opacityNumber <= 1
      ? opacityNumber
      : DEFAULT_TERMINAL_BADGE_CONFIG.opacity;
  const fontSizeNumber = Number(record.fontSize);
  const fontSize =
    Number.isFinite(fontSizeNumber) && fontSizeNumber > 0
      ? fontSizeNumber
      : DEFAULT_TERMINAL_BADGE_CONFIG.fontSize;

  return { enabled, template, position, opacity, fontSize };
}

/**
 * Tutorial state storage key (global)
 * Stores: { disabled: boolean, completed: { creation?: true, workspace?: true, review?: true } }
 */
export const TUTORIAL_STATE_KEY = "tutorialState";

export type TutorialSequence = "creation" | "workspace" | "review";

export interface TutorialState {
  disabled: boolean;
  completed: Partial<Record<TutorialSequence, true>>;
}

export const DEFAULT_TUTORIAL_STATE: TutorialState = {
  disabled: false,
  completed: {},
};

/**
 * Get the localStorage key for review (hunk read) state per workspace
 * Stores which hunks have been marked as read during code review
 * Legacy: migrated to the backend review-state.json; read once for import, then removed.
 * Format: "review-state:{workspaceId}"
 */
export function getReviewStateKey(workspaceId: string): string {
  return `review-state:${workspaceId}`;
}

/**
 * Get the localStorage key for selected review hunk per workspace.
 * Format: "review-selected-hunk:{workspaceId}"
 */
export function getReviewSelectedHunkKey(workspaceId: string): string {
  return `review-selected-hunk:${workspaceId}`;
}

/**
 * Get the localStorage key for hunk first-seen timestamps per workspace
 * Tracks when each hunk content address was first observed (for LIFO sorting)
 * Legacy: migrated to the backend review-state.json; read once for import, then removed.
 * Format: "hunkFirstSeen:{workspaceId}"
 */
export function getHunkFirstSeenKey(workspaceId: string): string {
  return `hunkFirstSeen:${workspaceId}`;
}

/**
 * Project-scoped default diff base for code review.
 * Format: "review-default-base:{projectPath}"
 */
export function getReviewDefaultBaseKey(projectPath: string): string {
  return `review-default-base:${projectPath}`;
}

/**
 * Global code review behavior for including uncommitted changes.
 * Format: "review-include-uncommitted"
 */
export const REVIEW_INCLUDE_UNCOMMITTED_KEY = "review-include-uncommitted";

/**
 * Get the localStorage key for review sort order preference (global)
 * Format: "review-sort-order"
 */
export const REVIEW_SORT_ORDER_KEY = "review-sort-order";

/**
 * Get the localStorage key for hunk expand/collapse state in Review tab
 * Stores user's manual expand/collapse preferences per hunk
 * Legacy: migrated to the backend review-state.json; read once for import, then removed.
 * Format: "reviewExpandState:{workspaceId}"
 */
export function getReviewExpandStateKey(workspaceId: string): string {
  return `reviewExpandState:${workspaceId}`;
}

/**
 * Get the localStorage key for read-more expansion state per hunk.
 * Tracks how many lines are expanded up/down for each hunk.
 * Legacy: migrated to the backend review-state.json; read once for import, then removed.
 * Format: "reviewReadMore:{workspaceId}"
 */
export function getReviewReadMoreKey(workspaceId: string): string {
  return `reviewReadMore:${workspaceId}`;
}

/**
 * Get the localStorage key for FileTree expand/collapse state in Review tab
 * Stores directory expand/collapse preferences per workspace
 * Format: "fileTreeExpandState:{workspaceId}"
 */
export function getFileTreeExpandStateKey(workspaceId: string): string {
  return `fileTreeExpandState:${workspaceId}`;
}

/**
 * LocalStorage key for file tree view mode in the Review tab (global).
 * Format: "reviewFileTreeViewMode"
 */
export const REVIEW_FILE_TREE_VIEW_MODE_KEY = "reviewFileTreeViewMode";

/**
 * Get the localStorage key for persisted legacy agent status for a workspace.
 * Stores the most recent successful status_set payload (emoji, message, url)
 * so historical status rows and older sessions can still be reconstructed.
 * Format: "statusState:{workspaceId}"
 */

/**
 * Get the localStorage key for "notify on response" toggle per workspace.
 * When true, a browser notification is shown when assistant responses complete.
 * Format: "notifyOnResponse:{workspaceId}"
 */
export function getNotifyOnResponseKey(workspaceId: string): string {
  return `notifyOnResponse:${workspaceId}`;
}

/**
 * Get the localStorage key for "auto-enable notifications" toggle per project.
 * When true, new workspaces in this project automatically have notifications enabled.
 * Format: "notifyOnResponseAutoEnable:{projectPath}"
 */
export function getNotifyOnResponseAutoEnableKey(projectPath: string): string {
  return `notifyOnResponseAutoEnable:${projectPath}`;
}

export function getStatusStateKey(workspaceId: string): string {
  return `statusState:${workspaceId}`;
}

/**
 * Get the localStorage key for last-read timestamps per workspace.
 * Format: "workspaceLastRead:{workspaceId}"
 */
export function getWorkspaceLastReadKey(workspaceId: string): string {
  return `workspaceLastRead:${workspaceId}`;
}

/**
 * Left sidebar collapsed state (global, manual toggle)
 * Format: "sidebarCollapsed"
 */
export const LEFT_SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";

/**
 * Whether the sidebar groups older workspaces under collapsible
 * "Older than X days" age tiers (boolean, default true).
 * When false, all workspaces render as one flat recency-sorted list.
 * Format: "sidebarAgeGrouping"
 */
export const SIDEBAR_AGE_GROUPING_KEY = "sidebarAgeGrouping";

/**
 * When true, show all sidebar chats in one list instead of project folders.
 * Format: "sidebarFlatMode" (boolean, default false)
 */
export const SIDEBAR_FLAT_MODE_KEY = "sidebarFlatMode";

/**
 * Hide sub-agent rows in the left sidebar and summarize their activity on
 * parent rows instead.
 * Format: "sidebarHideSubAgents" (boolean, default false)
 */
export const SIDEBAR_HIDE_SUBAGENTS_KEY = "sidebarHideSubAgents";

/**
 * Left sidebar width
 * Format: "left-sidebar:width"
 */
export const LEFT_SIDEBAR_WIDTH_KEY = "left-sidebar:width";

/**
 * Mobile left sidebar scroll position.
 *
 * The mobile sidebar content unmounts when collapsed, so we persist scrollTop
 * to restore the previous browse position when the menu is reopened.
 * Format: "mobile-left-sidebar:scroll-top"
 */
export const MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY = "mobile-left-sidebar:scroll-top";

/**
 * Right sidebar tab selection (global)
 * Format: "right-sidebar-tab"
 */
export const RIGHT_SIDEBAR_TAB_KEY = "right-sidebar-tab";

/**
 * Right sidebar collapsed state (global, manual toggle)
 * Format: "right-sidebar:collapsed"
 */
export const RIGHT_SIDEBAR_COLLAPSED_KEY = "right-sidebar:collapsed";

/**
 * Right sidebar width (unified across all tabs)
 * Format: "right-sidebar:width"
 */
export const RIGHT_SIDEBAR_WIDTH_KEY = "right-sidebar:width";

/**
 * Get the localStorage key for right sidebar dock-lite layout per workspace.
 * Each workspace can have its own split/tab configuration (e.g., different
 * numbers of terminals). Width and collapsed state remain global.
 * Format: "right-sidebar:layout:{workspaceId}"
 */
export function getRightSidebarLayoutKey(workspaceId: string): string {
  return `right-sidebar:layout:${workspaceId}`;
}

/**
 * Get the localStorage key for terminal titles per workspace.
 * Maps sessionId -> title for persisting OSC-set terminal titles.
 * Format: "right-sidebar:terminal-titles:{workspaceId}"
 */
export function getTerminalTitlesKey(workspaceId: string): string {
  return `right-sidebar:terminal-titles:${workspaceId}`;
}

/**
 * Get the localStorage key for unified Review search state per workspace
 * Stores: { input: string, useRegex: boolean, matchCase: boolean }
 * Format: "reviewSearchState:{workspaceId}"
 */
export function getReviewSearchStateKey(workspaceId: string): string {
  return `reviewSearchState:${workspaceId}`;
}

/**
 * Get the localStorage key for reviews per workspace
 * Stores: ReviewsState (reviews created from diff viewer - pending, attached, or checked)
 * Legacy: migrated to the backend review-state.json; read once for import, then removed.
 * Format: "reviews:{workspaceId}"
 */
export function getReviewsKey(workspaceId: string): string {
  return `reviews:${workspaceId}`;
}

/**
 * Get the localStorage key for immersive review mode state per workspace
 * Tracks whether immersive mode is active
 * Format: "review-immersive:{workspaceId}"
 */
export function getReviewImmersiveKey(workspaceId: string): string {
  return `review-immersive:${workspaceId}`;
}

/**
 * Get the localStorage key for the Review panel's selected file filter per workspace
 * Format: "review-file-filter:{workspaceId}"
 */
export function getReviewFileFilterKey(workspaceId: string): string {
  return `review-file-filter:${workspaceId}`;
}

/**
 * Get the localStorage key for the Timeline panel's event filter per workspace
 * Format: "timeline-filter:{workspaceId}"
 */
export function getTimelineFilterKey(workspaceId: string): string {
  return `timeline-filter:${workspaceId}`;
}

/**
 * Get the localStorage key for the detached desktop popout instance hint per workspace
 * Format: "desktop-popout:{workspaceId}"
 */
export function getDesktopPopoutKey(workspaceId: string): string {
  return `desktop-popout:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction enabled preference per workspace
 * Format: "autoCompaction:enabled:{workspaceId}"
 */
export function getAutoCompactionEnabledKey(workspaceId: string): string {
  return `autoCompaction:enabled:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction threshold percentage per model
 * Format: "autoCompaction:threshold:{model}"
 * Stored per-model because different models have different context windows
 */
export function getAutoCompactionThresholdKey(model: string): string {
  return `autoCompaction:threshold:${model}`;
}

/** localStorage-backed LRU caches (see src/browser/utils/lruCache.ts). */
export const SESSION_COST_CACHE_ENTRY_PREFIX = "session-cost:";
export const SESSION_COST_CACHE_INDEX_KEY = "session-cost-index";
export const SESSION_COST_CACHE_MAX_ENTRIES = 500;
export const PR_STATUS_CACHE_ENTRY_PREFIX = "prStatus:";
export const PR_STATUS_CACHE_INDEX_KEY = "prStatusIndex";
export const PR_STATUS_CACHE_MAX_ENTRIES = 50;
export const BRANCH_CACHE_ENTRY_PREFIX = "branch:";
export const BRANCH_CACHE_INDEX_KEY = "branchIndex";
export const BRANCH_CACHE_MAX_ENTRIES = 100;

/**
 * Per-workspace diff base override for code review (see STORAGE_KEYS.reviewDiffBase).
 * Format: "review-diff-base:{workspaceId}"
 */
export function getReviewDiffBaseKey(workspaceId: string): string {
  return `review-diff-base:${workspaceId}`;
}

// Component-local keys. Declared here so the key string and its registration (budget) live in
// one place.
export const POST_COMPACTION_COLLAPSED_KEY = "postCompaction:collapsed";
export const POST_COMPACTION_FILES_EXPANDED_KEY = "postCompaction:filesExpanded";
export const STATS_CONTAINER_SUB_TAB_KEY = "statsContainer:subTab";
export const STATS_TAB_VIEW_MODE_KEY = "statsTab:viewMode";
export const STATS_TAB_SHOW_MODE_BREAKDOWN_KEY = "statsTab:showModeBreakdown";
export const COSTS_TAB_VIEW_MODE_KEY = "costsTab:viewMode";
export const OUTPUT_TAB_LEVEL_KEY = "output-tab-level";
export const REVIEW_SHOW_READ_KEY = "review-show-read";
export const MERMAID_DIAGRAM_ZOOM_KEY = "mermaid-diagram-zoom";
export const ANALYTICS_TIME_RANGE_KEY = "analytics:timeRange";
export const ANALYTICS_TIMING_METRIC_KEY = "analytics:timingMetric";
export const ANALYTICS_TIME_ZONE_MODE_KEY = "analytics:timeZoneMode";
export const ROSETTA_BANNER_DISMISSED_KEY = "rosettaBannerDismissedAt";
export const WINDOWS_TOOLCHAIN_BANNER_DISMISSED_KEY = "windowsToolchainBannerDismissedAt";
export const REMOTE_CONNECTION_URL_KEY = "remoteConnectionUrl";

/** Left sidebar expansion maps (Record<string, boolean>, global). */
export const EXPANDED_OLD_WORKSPACES_KEY = "expandedOldWorkspaces";
export const EXPANDED_SECTIONS_KEY = "expandedSections";
export const EXPANDED_COMPLETED_SUB_AGENTS_KEY = "expandedCompletedSubAgents";
export const EXPANDED_TASK_GROUPS_KEY = "expandedTaskGroups";

// Budgets that owners also use to keep growing values inside them (see trimRecordToChars).
// Per-workspace values that owners trim degrade gracefully (older entries are forgotten), so
// they get tighter budgets than values that cannot be trimmed, like the right sidebar layout.
/** fileTreeExpandState:{workspaceId}: only directory overrides of the default expansion. */
export const FILE_TREE_EXPAND_STATE_MAX_CHARS = 512;
/** auto-expand:{workspaceId}: the per-tool map keeps the most recently toggled tools that fit. */
export const AUTO_EXPAND_PREFS_MAX_CHARS = 512;
/** autoRoutingChoiceByAgent:{workspaceId}: one entry per agent ever chosen; the owner keeps the newest. */
export const AUTO_ROUTING_CHOICE_BY_AGENT_MAX_CHARS = 384;
/** reviewSearchState:{workspaceId}: longer searches still work but are not restored on reload. */
export const REVIEW_SEARCH_STATE_MAX_CHARS = 256;
/**
 * right-sidebar:layout:{workspaceId}: dock layout tree, ~200 chars plus ~45 per terminal tab, so
 * about 35 terminals. The layout cannot be trimmed; a larger layout lives in memory for the
 * session (see usePersistedState), and on reload terminal tabs are restored from the backend.
 */
const RIGHT_SIDEBAR_LAYOUT_MAX_CHARS = 1792;
/** right-sidebar:terminal-titles:{workspaceId}: RightSidebar keeps the newest titles that fit. */
export const TERMINAL_TITLES_MAX_CHARS = 768;
/** Each left sidebar expansion map; entries accumulate per project/workspace/group forever. */
export const SIDEBAR_EXPANSION_MAP_MAX_CHARS = 16 * 1024;
/** archivedWorkspaces:{projectPath}: the cache keeps the first archived entries that fit. */
export const ARCHIVED_WORKSPACES_CACHE_MAX_CHARS = 6 * 1024;
/** workspaceNameState stores at most this much (serialized) of the message it was generated for. */
export const WORKSPACE_NAME_STATE_MESSAGE_MAX_CHARS = 2000;
/**
 * workspaceNameState stores at most this much (serialized) of a typed manual name. Valid names are
 * at most 64 chars (validateWorkspaceBranchName), so only invalid names are cut.
 */
export const WORKSPACE_NAME_STATE_MANUAL_NAME_MAX_CHARS = 1024;
/**
 * model:{workspaceId} holds a "provider:modelId" string. Custom model ids are checked against it
 * where they are entered (getModelIdLengthError); built-in ids are far shorter.
 */
export const MODEL_KEY_MAX_CHARS = 128;
/** statusState:{workspaceId} field caps (serialized chars); a longer URL is dropped, not cut. */
export const STATUS_STATE_EMOJI_MAX_CHARS = 32;
export const STATUS_STATE_MESSAGE_MAX_CHARS = 192;
export const STATUS_STATE_URL_MAX_CHARS = 256;

/**
 * Every key's length is capped too. Budgets bound values only: scope ids embed project paths
 * (drafts, pending scopes, project-scoped keys), so a key+value budget would either refuse a
 * boolean under a long project path or need path headroom in every budget.
 */
// Large enough for any valid absolute path (Linux PATH_MAX is 4096) plus a prefix and draft id:
// a key over the cap is refused outright, which would freeze controls under that project.
export const MAX_PERSISTED_KEY_CHARS = 8192;

/**
 * Persisted key registry: classification and size budget of every key the app writes.
 *
 * localStorage is one ~5 MB origin quota shared by every feature; a single growing value or an
 * unbounded key family once filled it and stopped drafts from persisting. The shared write
 * (writePersistedValue in usePersistedState.ts) therefore refuses writes to unregistered keys and
 * keeps values longer than `maxValueChars` (UTF-16 length of the serialized value) in memory only,
 * and persistedStateBudget.test.ts bounds the worst-case total derived from this registry.
 *
 * - `cache`: derived data the app can refetch; the only kind the quota handler may evict.
 * - `draft`: unsent composer/creation input; never evicted.
 * - `workspace-scoped`: per-workspace review data and UI state; never evicted.
 * - `synced`: frontend copy of backend-owned preferences; never evicted.
 * - `ui`: small UI preferences; never evicted.
 *
 * Removal is always allowed, registered or not, so legacy cleanups keep working. A legacy key that
 * is only read and removed needs no registration; registered legacy keys use `maxValueChars: 0`.
 */
export type PersistedKeyKind = "ui" | "cache" | "workspace-scoped" | "draft" | "synced";

/**
 * `workspaceId` keys append a scope id to a fixed prefix. The scope id is usually a workspace id,
 * but creation drafts reuse the same keys with getDraftScopeId()/getPendingScopeId() scope ids and
 * some keys also accept project/global scope ids.
 */
export type PersistedKeyScope = "global" | "workspaceId";

/**
 * Which scope ids a workspace key is written under, for the budget model: "workspace" keys are
 * counted for every workspace and creation draft, "draft" keys only for creation drafts.
 * "webview" keys are written only by the VS Code webview, whose origin has its own quota, so they
 * are modelled separately from the app's origin.
 */
export type WorkspaceKeyScopes = "workspace" | "draft" | "webview";

/**
 * How many keys a global prefix registration expands to in the budget model: one per project,
 * per project and per workspace, per model, per defined experiment, or a fixed count (LRU caches).
 */
export type PersistedKeyInstances =
  | "project"
  | "project+workspace"
  | "model"
  | "experiment"
  | number;

export interface WorkspaceKeyRegistration {
  scope: "workspaceId";
  getKey: (scopeId: string) => string;
  kind: PersistedKeyKind;
  /** Copied to the new workspace on fork (and to the new scope on migrateWorkspaceStorage). */
  copyOnFork: boolean;
  /** Longest accepted serialized value (UTF-16 code units); 0 refuses every write. */
  maxValueChars: number;
  scopes: WorkspaceKeyScopes;
}

export interface GlobalKeyRegistration {
  scope: "global";
  key: string;
  match: "exact" | "prefix";
  kind: PersistedKeyKind;
  /** Longest accepted serialized value (UTF-16 code units); 0 refuses every write. */
  maxValueChars: number;
  /** Budget-model instance count; exact keys are always one instance. */
  instances: PersistedKeyInstances;
}

export type PersistedKeyRegistration = WorkspaceKeyRegistration | GlobalKeyRegistration;

function workspaceKey(
  getKey: (scopeId: string) => string,
  kind: PersistedKeyKind,
  copyOnFork: boolean,
  maxValueChars: number,
  scopes: WorkspaceKeyScopes = "workspace"
): WorkspaceKeyRegistration {
  return { scope: "workspaceId", getKey, kind, copyOnFork, maxValueChars, scopes };
}

function globalKey(
  key: string,
  kind: PersistedKeyKind,
  maxValueChars: number
): GlobalKeyRegistration {
  return { scope: "global", key, match: "exact", kind, maxValueChars, instances: 1 };
}

function globalPrefix(
  key: string,
  kind: PersistedKeyKind,
  maxValueChars: number,
  instances: PersistedKeyInstances
): GlobalKeyRegistration {
  return { scope: "global", key, match: "prefix", kind, maxValueChars, instances };
}

/** Prefix of a project-scoped key family (the key with an empty project path). */
function projectPrefix(getKey: (projectPath: string) => string): string {
  return getKey("");
}

// Budget sizing: booleans/numbers 16-32, enums and ids 32-128, paths/refs/URLs 256-2048, structured
// values from their shapes with headroom. Per-workspace keys count once per workspace in the
// budget model, so they are sized tightly; global and backend-synced keys generously (a refused
// sync would leave a stale frontend copy).
//
// Budget policy (#5225): a key's budget must cover the largest value its owner writes. An owner
// whose value grows with user input (paths, ids, URLs, free text, per-item maps) bounds it where
// it is produced (trim, cap the entry count, or persist a reference such as an id instead of an
// embedded copy), and the budget derives from that bound. Data that has no natural bound belongs on
// the backend, as composer drafts do (DraftService). The session-only fallback for an
// over-budget value is a safety net for bugs, not a supported path: a value that can legitimately
// exceed its budget is a bug in its owner.
export const PERSISTED_KEY_REGISTRY: readonly PersistedKeyRegistration[] = [
  // Copied on fork.
  // Record<agentId, { model, thinkingLevel, reasoningMode? }>, hydrated from workspace metadata.
  workspaceKey(getWorkspaceAISettingsByAgentKey, "synced", true, 1024),
  workspaceKey(getModelKey, "ui", true, MODEL_KEY_MAX_CHARS),
  workspaceKey(getAutoModelRoutingKey, "ui", true, 16),
  workspaceKey(getAutoThinkingLevelKey, "ui", true, 16),
  workspaceKey(getAutoRoutingChoiceByAgentKey, "ui", true, AUTO_ROUTING_CHOICE_BY_AGENT_MAX_CHARS),
  // { thinking?, tools?: Record<toolName, boolean> }: one entry per tool the user toggled.
  workspaceKey(getAutoExpandPrefsKey, "ui", true, AUTO_EXPAND_PREFS_MAX_CHARS),
  // Creation-draft scopes only. ~80 skeleton + generatedIdentity <= ~410 (propose_name: name <= 20
  // plus suffix, title <= 60) + lastGeneratedFor 2000 + manualName 1024 (the caps above).
  workspaceKey(getWorkspaceNameStateKey, "draft", true, 4096, "draft"),
  // The VS Code webview composer's unsent text. Longer drafts still work for the session (kept in
  // memory); the webview then persists only the last text that fit.
  workspaceKey(getInputKey, "draft", false, 8192, "webview"),
  workspaceKey(getAgentIdKey, "synced", true, 128),
  workspaceKey(getPinnedAgentIdKey, "ui", true, 128),
  workspaceKey(getThinkingLevelKey, "ui", true, 32),
  workspaceKey(getReviewSelectedHunkKey, "workspace-scoped", true, 256),
  workspaceKey(
    getFileTreeExpandStateKey,
    "workspace-scoped",
    true,
    FILE_TREE_EXPAND_STATE_MAX_CHARS
  ),
  workspaceKey(getReviewSearchStateKey, "workspace-scoped", true, REVIEW_SEARCH_STATE_MAX_CHARS),
  workspaceKey(getReviewImmersiveKey, "workspace-scoped", true, 16),
  workspaceKey(getAutoCompactionEnabledKey, "ui", true, 16),
  workspaceKey(getWorkspaceLastReadKey, "workspace-scoped", true, 32),
  // Not a cache: a status_set result compacted out of history cannot be re-derived after reload
  // (see StreamingMessageAggregator.loadPersistedAgentStatus), so it must never be evicted.
  // ~28 skeleton + the STATUS_STATE_*_MAX_CHARS field caps.
  workspaceKey(getStatusStateKey, "workspace-scoped", true, 512),
  // Note: auto-compaction threshold is per-model, not per-workspace.

  // Legacy review data, now in the backend review-state.json (imported once when the review
  // panel opens, then removed). Never written again, so no budget (0). Still copied on fork: a
  // source that has not been imported yet has no review-state.json for the backend fork to copy,
  // so the fork's own import needs these (copyLegacyPersistedRawString).
  workspaceKey(getReviewStateKey, "workspace-scoped", true, 0),
  workspaceKey(getHunkFirstSeenKey, "workspace-scoped", true, 0),
  workspaceKey(getReviewExpandStateKey, "workspace-scoped", true, 0),
  workspaceKey(getReviewReadMoreKey, "workspace-scoped", true, 0),
  workspaceKey(getReviewsKey, "workspace-scoped", true, 0),

  // Deleted with the workspace but not copied on fork.
  // SendMessageError; transient (shown as a toast after navigation, then removed).
  workspaceKey(getPendingWorkspaceSendErrorKey, "workspace-scoped", false, 768),
  workspaceKey(getPendingDraftSkillDiscoveryKey, "workspace-scoped", false, 16),
  // Synced: UserPreferencesContext mirrors notifyOnResponseByWorkspace from the backend.
  workspaceKey(getNotifyOnResponseKey, "synced", false, 16),

  // Per-workspace keys that deleteWorkspaceStorage used to miss, leaving orphans behind.
  workspaceKey(getReasoningModeKey, "ui", false, 32),
  workspaceKey(getDisableWorkspaceAgentsKey, "ui", false, 16),
  workspaceKey(getPinnedTodoExpandedKey, "ui", false, 16),
  workspaceKey(getSubAgentTasksExpandedKey, "ui", false, 16),
  workspaceKey(getRightSidebarLayoutKey, "ui", false, RIGHT_SIDEBAR_LAYOUT_MAX_CHARS),
  // Record<terminalSessionId, title>, pruned when sessions close.
  workspaceKey(getTerminalTitlesKey, "ui", false, TERMINAL_TITLES_MAX_CHARS),
  workspaceKey(getReviewFileFilterKey, "ui", false, 512),
  workspaceKey(getTimelineFilterKey, "ui", false, 64),
  workspaceKey(getDesktopPopoutKey, "ui", false, 128),
  workspaceKey(getReviewDiffBaseKey, "ui", false, 256),

  // Global UI state.
  globalKey(UI_THEME_KEY, "synced", 64),
  globalKey(POWER_MODE_ENABLED_KEY, "ui", 16),
  globalKey(LAST_CUSTOM_MODEL_PROVIDER_KEY, "ui", 128),
  // { workspaceId } (older builds also stored paths; readers use only the id).
  globalKey(SELECTED_WORKSPACE_KEY, "ui", 256),
  globalKey(LAST_VISITED_ROUTE_KEY, "ui", 4096),
  globalKey(LAUNCH_BEHAVIOR_KEY, "synced", 32),
  globalKey(CHAT_TRANSCRIPT_FULL_WIDTH_KEY, "synced", 16),
  // string[] of project paths.
  globalKey(PROJECT_ORDER_KEY, "synced", 32 * 1024),
  globalKey(EXPANDED_PROJECTS_KEY, "ui", 32 * 1024),
  // Legacy creation draft list, now in the backend drafts/list.json (imported once by DraftStore,
  // then removed, #5225). Never written again, so no budget (0).
  globalKey(WORKSPACE_DRAFTS_BY_PROJECT_KEY, "draft", 0),
  globalKey(RUNTIME_ENABLEMENT_KEY, "synced", 1024),
  globalKey(DEFAULT_RUNTIME_KEY, "synced", 256),
  globalKey(DEFAULT_MODEL_KEY, "synced", 256),
  // string[] of model ids; Record<agentId, defaults>.
  globalKey(HIDDEN_MODELS_KEY, "synced", 32 * 1024),
  globalKey(AGENT_AI_DEFAULTS_KEY, "synced", 32 * 1024),
  globalKey(PROVIDER_OPTIONS_ANTHROPIC_KEY, "synced", 4096),
  globalKey(PROVIDER_OPTIONS_GOOGLE_KEY, "synced", 4096),
  globalKey(VIM_ENABLED_KEY, "synced", 16),
  globalKey(GIT_STATUS_INDICATOR_MODE_KEY, "ui", 32),
  globalKey(EDITOR_CONFIG_KEY, "synced", 2048),
  globalKey(TRANSCRIPT_DENSITY_KEY, "synced", 32),
  globalKey(BASH_COLLAPSED_SUMMARY_MODE_KEY, "synced", 32),
  globalKey(TERMINAL_FONT_CONFIG_KEY, "synced", 1024),
  globalKey(TERMINAL_BADGE_CONFIG_KEY, "synced", 2048),
  globalKey(TUTORIAL_STATE_KEY, "ui", 256),
  globalKey(REVIEW_INCLUDE_UNCOMMITTED_KEY, "synced", 16),
  globalKey(REVIEW_SORT_ORDER_KEY, "ui", 32),
  globalKey(REVIEW_FILE_TREE_VIEW_MODE_KEY, "ui", 32),
  globalKey(LEFT_SIDEBAR_COLLAPSED_KEY, "ui", 16),
  globalKey(SIDEBAR_AGE_GROUPING_KEY, "ui", 16),
  globalKey(SIDEBAR_FLAT_MODE_KEY, "ui", 16),
  globalKey(SIDEBAR_HIDE_SUBAGENTS_KEY, "ui", 16),
  globalKey(LEFT_SIDEBAR_WIDTH_KEY, "ui", 16),
  globalKey(MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY, "ui", 32),
  // Legacy global tab; still read as a fallback for the per-workspace layout.
  globalKey(RIGHT_SIDEBAR_TAB_KEY, "ui", 64),
  globalKey(RIGHT_SIDEBAR_COLLAPSED_KEY, "ui", 16),
  globalKey(RIGHT_SIDEBAR_WIDTH_KEY, "ui", 16),
  globalKey(REMOTE_CONNECTION_URL_KEY, "ui", 2048),
  // Server tokens have no length limit elsewhere; a token kept only in memory would log the user
  // out on reload.
  globalKey(AUTH_TOKEN_KEY, "ui", 8192),
  // Action ids of the COMMAND_PALETTE_RECENT_MAX_ENTRIES most recent commands.
  globalKey(COMMAND_PALETTE_RECENT_KEY, "ui", 8192),
  globalKey(FIRST_LAUNCH_KEY, "ui", 16),
  globalKey(ROSETTA_BANNER_DISMISSED_KEY, "ui", 32),
  globalKey(WINDOWS_TOOLCHAIN_BANNER_DISMISSED_KEY, "ui", 32),
  globalKey(POST_COMPACTION_COLLAPSED_KEY, "ui", 16),
  globalKey(POST_COMPACTION_FILES_EXPANDED_KEY, "ui", 16),
  globalKey(STATS_CONTAINER_SUB_TAB_KEY, "ui", 32),
  globalKey(STATS_TAB_VIEW_MODE_KEY, "ui", 32),
  globalKey(STATS_TAB_SHOW_MODE_BREAKDOWN_KEY, "ui", 16),
  globalKey(COSTS_TAB_VIEW_MODE_KEY, "ui", 32),
  globalKey(OUTPUT_TAB_LEVEL_KEY, "ui", 32),
  globalKey(REVIEW_SHOW_READ_KEY, "ui", 16),
  globalKey(MERMAID_DIAGRAM_ZOOM_KEY, "ui", 32),
  globalKey(ANALYTICS_TIME_RANGE_KEY, "ui", 32),
  globalKey(ANALYTICS_TIMING_METRIC_KEY, "ui", 32),
  globalKey(ANALYTICS_TIME_ZONE_MODE_KEY, "ui", 32),
  globalKey(EXPANDED_OLD_WORKSPACES_KEY, "ui", SIDEBAR_EXPANSION_MAP_MAX_CHARS),
  globalKey(EXPANDED_SECTIONS_KEY, "ui", SIDEBAR_EXPANSION_MAP_MAX_CHARS),
  globalKey(EXPANDED_COMPLETED_SUB_AGENTS_KEY, "ui", SIDEBAR_EXPANSION_MAP_MAX_CHARS),
  globalKey(EXPANDED_TASK_GROUPS_KEY, "ui", SIDEBAR_EXPANSION_MAP_MAX_CHARS),

  // One boolean per experiment (getExperimentKey in experiments.ts), including the legacy PTC
  // exclusive mirror that is kept equal to PTC for downgrades.
  globalPrefix("experiment:", "ui", 16, "experiment"),
  // Per-model auto-compaction threshold percentage (synced).
  globalPrefix(getAutoCompactionThresholdKey(""), "synced", 16, "model"),

  // Project-scoped families ("{prefix}{projectPath}").
  globalPrefix(projectPrefix(getTrunkBranchKey), "synced", 256, "project"),
  // Provider-keyed last runtime options (e.g. { ssh: { host }, docker: { image } }).
  globalPrefix(projectPrefix(getLastRuntimeConfigKey), "synced", 1024, "project"),
  globalPrefix(projectPrefix(getRuntimeKey), "ui", 256, "project"),
  globalPrefix(projectPrefix(getAgentsInitNudgeKey), "ui", 16, "project"),
  globalPrefix(projectPrefix(getReviewDefaultBaseKey), "synced", 256, "project"),
  globalPrefix(projectPrefix(getNotifyOnResponseAutoEnableKey), "synced", 16, "project"),
  globalPrefix(projectPrefix(getArchivedWorkspacesExpandedKey), "ui", 16, "project"),
  globalPrefix(projectPrefix(getBrowserSelectedSessionKey), "ui", 256, "project"),

  // LRU caches bound themselves by entry count; their entries and index keys are only evicted
  // under quota pressure.
  // { data: number, cachedAt } per workspace; the index lists the entry keys.
  globalPrefix(SESSION_COST_CACHE_ENTRY_PREFIX, "cache", 96, SESSION_COST_CACHE_MAX_ENTRIES),
  globalKey(SESSION_COST_CACHE_INDEX_KEY, "cache", 16 * 1024),
  // { data: { prLink, status, stack? }, cachedAt } per workspace.
  globalPrefix(PR_STATUS_CACHE_ENTRY_PREFIX, "cache", 3072, PR_STATUS_CACHE_MAX_ENTRIES),
  globalKey(PR_STATUS_CACHE_INDEX_KEY, "cache", 2048),
  // { data: branchName, cachedAt } per workspace.
  globalPrefix(BRANCH_CACHE_ENTRY_PREFIX, "cache", 512, BRANCH_CACHE_MAX_ENTRIES),
  globalKey(BRANCH_CACHE_INDEX_KEY, "cache", 4096),

  // Backend data cached only to avoid a flash on mount; the owners refetch or re-test it. A value
  // over budget is simply not cached.
  // mcpTestResults keys are project-scoped (optionally ":{workspaceId}" after the project path), so
  // they are registered as one global prefix rather than as a workspace key.
  globalPrefix(
    projectPrefix(getArchivedWorkspacesKey),
    "cache",
    ARCHIVED_WORKSPACES_CACHE_MAX_CHARS,
    "project"
  ),
  globalPrefix(projectPrefix(getMCPServersKey), "cache", 2048, "project"),
  globalPrefix(projectPrefix(getMCPTestResultsKey), "cache", 1536, "project+workspace"),
];

export const WORKSPACE_KEY_REGISTRATIONS = PERSISTED_KEY_REGISTRY.filter(
  (entry): entry is WorkspaceKeyRegistration => entry.scope === "workspaceId"
);

/** Registered key prefix for a workspace-scoped key function (the key with an empty scope id). */
export function getWorkspaceKeyPrefix(getKey: (scopeId: string) => string): string {
  return getKey("");
}

function registrationMatches(entry: PersistedKeyRegistration, key: string): boolean {
  if (entry.scope === "workspaceId") return key.startsWith(getWorkspaceKeyPrefix(entry.getKey));
  return entry.match === "exact" ? key === entry.key : key.startsWith(entry.key);
}

// Every persisted write resolves its key's registration, often per keystroke; memoize the scan.
// Registered prefixes never shadow each other (storage.test.ts), so the first match is the only one.
const registrationByKey = new Map<string, PersistedKeyRegistration | null>();

/** The registration a concrete key belongs to, or undefined when it is unregistered. */
export function getPersistedKeyRegistration(key: string): PersistedKeyRegistration | undefined {
  let registration = registrationByKey.get(key);
  if (registration === undefined) {
    registration = PERSISTED_KEY_REGISTRY.find((entry) => registrationMatches(entry, key)) ?? null;
    registrationByKey.set(key, registration);
  }
  return registration ?? undefined;
}

/** Scope id embedded in a registered workspace-scoped key, or null for any other key. */
function getWorkspaceScopeIdFromKey(key: string): string | null {
  for (const entry of WORKSPACE_KEY_REGISTRATIONS) {
    const prefix = getWorkspaceKeyPrefix(entry.getKey);
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

export const MCP_TEST_RESULTS_KEY_PREFIX = getWorkspaceKeyPrefix(getMCPTestResultsKey);

/**
 * Trailing segment of an "mcpTestResults:{projectPath}[:{workspaceId}]" key (text after the last
 * ":"), or null for other keys. For project-level keys this is a piece of the project path; callers
 * only treat it as a workspace id when it has the stable id shape.
 */
function getMcpTestResultsTrailingSegment(key: string): string | null {
  if (!key.startsWith(MCP_TEST_RESULTS_KEY_PREFIX)) return null;
  const rest = key.slice(MCP_TEST_RESULTS_KEY_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  return separator === -1 ? null : rest.slice(separator + 1);
}

/** Classify a concrete localStorage key; undefined means unregistered (treated as non-evictable). */
export function getPersistedKeyKind(key: string): PersistedKeyKind | undefined {
  return getPersistedKeyRegistration(key)?.kind;
}

/**
 * New workspaces get crypto.randomBytes(5) hex ids (Config.generateStableId). Orphan GC only
 * collects keys whose scope id has this shape, so legacy-format ids, creation-draft, pending,
 * project and global scopes and legacy keys that share a prefix (e.g. "thinkingLevel:model:{model}") are never collected.
 * Failing closed here leaks a little space at worst; guessing wrong would delete user data.
 */
const STABLE_WORKSPACE_ID_PATTERN = /^[0-9a-f]{10}$/;

/**
 * Stable workspace id owning a key the orphan GC may collect, or null for every other key
 * (legacy-format ids, creation-draft/pending/project/global scopes, unregistered keys).
 */
function getWorkspaceStorageGcOwnerId(key: string): string | null {
  const scopeId = getWorkspaceScopeIdFromKey(key) ?? getMcpTestResultsTrailingSegment(key);
  // mcpTestResults is registered as an evictable cache, so misreading a project-level key whose
  // path happens to end in ":{10 hex}" only drops re-testable results, never user data.
  return scopeId !== null && STABLE_WORKSPACE_ID_PATTERN.test(scopeId) ? scopeId : null;
}

/**
 * Whether the orphan GC could ever collect `key`: registered workspace-scoped keys and
 * workspace-scoped mcpTestResults keys of stable workspace ids.
 */
export function isWorkspaceStorageGcCandidateKey(key: string): boolean {
  return getWorkspaceStorageGcOwnerId(key) !== null;
}

/** Pick the candidate keys whose stable workspace id is not in `knownWorkspaceIds`. */
export function findOrphanedWorkspaceStorageKeys(
  candidateKeys: readonly string[],
  knownWorkspaceIds: ReadonlySet<string>
): string[] {
  return candidateKeys.filter((key) => {
    const ownerId = getWorkspaceStorageGcOwnerId(key);
    return ownerId !== null && !knownWorkspaceIds.has(ownerId);
  });
}

/**
 * The listed creation draft that owns a registered draft-scope settings key
 * (`<key>:__draft__/<project>/<id>`), or null for every other key: the default composer's fixed
 * draft id, ids the backend would never list, and "draft"-kind keys, which hold typed input (the
 * legacy draft text its migration still owns, a typed workspace name) and are never collected.
 */
function getCreationDraftStorageOwner(
  key: string
): { projectPath: string; draftId: string } | null {
  if (getPersistedKeyKind(key) === "draft") return null;
  const scopeId = getWorkspaceScopeIdFromKey(key);
  if (scopeId?.startsWith(DRAFT_SCOPE_ID_PREFIX) !== true) return null;
  const rest = scopeId.slice(DRAFT_SCOPE_ID_PREFIX.length);
  const separator = rest.lastIndexOf("/");
  const projectPath = rest.slice(0, separator);
  const draftId = rest.slice(separator + 1);
  if (separator <= 0 || !DRAFT_ID_PATTERN.test(draftId) || draftId === DEFAULT_CREATION_DRAFT_ID) {
    return null;
  }
  return { projectPath, draftId };
}

/** Whether the creation-draft storage GC could ever collect `key` (see creationDraftStorageGc.ts). */
export function isCreationDraftStorageGcCandidateKey(key: string): boolean {
  return getCreationDraftStorageOwner(key) !== null;
}

/** Pick the candidate keys whose creation draft `isKept` rejects. */
export function findOrphanedCreationDraftStorageKeys(
  candidateKeys: readonly string[],
  isKept: (projectPath: string, draftId: string) => boolean
): string[] {
  return candidateKeys.filter((key) => {
    const owner = getCreationDraftStorageOwner(key);
    return owner !== null && !isKept(owner.projectPath, owner.draftId);
  });
}
