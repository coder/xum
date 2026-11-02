import {
  ARTIFACT_THEME_VARIABLES,
  type ArtifactThemeVariableKey,
} from "@/common/constants/artifacts";

/**
 * The app CSS variables that sandboxed frames receive as data, so agent-written pages can match
 * the current theme. HTML artifacts get them as `--xum-*` custom properties on their root
 * element (artifactBridge.ts); MCP Apps get the same palette under the spec's names.
 */
const MCP_STYLE_VARIABLE_NAMES: Partial<Record<ArtifactThemeVariableKey, string>> = {
  bg: "--color-background-primary",
  "bg-secondary": "--color-background-secondary",
  fg: "--color-text-primary",
  muted: "--color-text-secondary",
  border: "--color-border-primary",
  "border-light": "--color-border-secondary",
  accent: "--color-text-info",
  danger: "--color-text-danger",
  success: "--color-text-success",
  "font-sans": "--font-sans",
  "font-mono": "--font-mono",
  radius: "--border-radius-md",
};

/** Names an artifact frame accepts from a theme message (the bridge checks them again). */
export const ARTIFACT_THEME_VARIABLE_NAME_PATTERN = /^--xum-[a-z0-9-]+$/;
export const ARTIFACT_THEME_VARIABLES_MAX_COUNT = 32;
export const ARTIFACT_THEME_VARIABLE_VALUE_MAX_CHARS = 512;

/**
 * The current values, read from the root element's computed style. ThemeProvider sets the root
 * `data-theme` in a layout effect, and layout effects of a commit run before its passive
 * effects, so a `useEffect` reacting to a theme change already reads the new theme's values.
 */
export function readAppStyleVariables(naming: "mcp" | "xum"): Record<string, string> {
  const computed = window.getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const [key, appName] of Object.entries(ARTIFACT_THEME_VARIABLES)) {
    const name =
      naming === "mcp" ? MCP_STYLE_VARIABLE_NAMES[key as ArtifactThemeVariableKey] : `--xum-${key}`;
    if (name == null) continue;
    const value = computed.getPropertyValue(appName).trim();
    if (value) variables[name] = value;
  }
  return variables;
}
