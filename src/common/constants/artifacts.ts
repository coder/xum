/**
 * The page the Agent interface view (artifacts-agent-interface experiment) shows in the main
 * pane, relative to $XUM_SCRATCH_DIR/artifacts. The host seeds it and the agent keeps it current.
 */
export const AGENT_INTERFACE_STATUS_ARTIFACT = "status.html";

/**
 * Theme variables HTML artifacts receive as `--xum-<name>` custom properties on their root
 * element, each mirroring one app CSS variable (globals.css), so agent pages match the theme.
 */
export const ARTIFACT_THEME_VARIABLES = {
  bg: "--color-background",
  // The main pane's and the sidebars' own surface, which differs from --color-background in
  // Light and Dark: a page painted with it sits seamlessly in the pane.
  surface: "--color-surface-primary",
  "bg-secondary": "--color-background-secondary",
  fg: "--color-foreground",
  muted: "--color-muted",
  border: "--color-border",
  "border-light": "--color-border-light",
  accent: "--color-accent",
  danger: "--color-danger",
  success: "--color-success-text",
  warning: "--color-warning",
  "font-sans": "--font-primary",
  "font-mono": "--font-monospace",
  radius: "--radius",
} as const;

export type ArtifactThemeVariableKey = keyof typeof ARTIFACT_THEME_VARIABLES;

/** Status page agent (artifacts-status-page-agent): bounds of one headless run and its queue. */
/** Model steps per run: a few edits plus the closing line. */
export const STATUS_PAGE_AGENT_MAX_STEPS = 8;
/** Largest page the agent reads or writes; status pages are small, so larger ones are refused. */
export const STATUS_PAGE_AGENT_MAX_PAGE_BYTES = 256 * 1024;
/** A wedged provider stream must not hold the workspace's drain forever. */
export const STATUS_PAGE_AGENT_RUN_TIMEOUT_MS = 2 * 60 * 1000;
/** Longest single status_update text. */
export const STATUS_PAGE_AGENT_MAX_UPDATE_CHARS = 4000;
/** Pending updates kept per workspace; the oldest are dropped first. */
export const STATUS_PAGE_AGENT_MAX_PENDING_UPDATES = 20;
/** Total characters of pending updates kept per workspace; the oldest are dropped first. */
export const STATUS_PAGE_AGENT_MAX_PENDING_CHARS = 20_000;
