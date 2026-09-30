/**
 * Shared palette for native and static surfaces that cannot read renderer CSS variables.
 * Values mirror each theme's `--color-sidebar`.
 */
export const CHROME_COLORS = {
  dark: "#09090b",
  light: "#f5f5f5",
  "flexoki-light": "#f2f0e5",
  "flexoki-dark": "#1c1b1a",
} as const;

/** The window is created before the renderer resolves a theme, so native chrome starts dark. */
export const DEFAULT_CHROME_COLOR = CHROME_COLORS.dark;

export const TITLEBAR_SYMBOL_COLOR = "#a3a3a3";
