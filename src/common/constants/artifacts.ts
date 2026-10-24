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
