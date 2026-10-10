/**
 * Shared constants and utilities for Shiki syntax highlighting
 * Used by both the main app and documentation theme
 */

// Shiki themes used throughout the application
export const SHIKI_DARK_THEME = "min-dark";
export const SHIKI_LIGHT_THEME = "min-light";

/**
 * Darker replacements for min-light colors that miss WCAG AA (4.5:1) on the light code
 * backgrounds the app renders: `--color-code-bg` in light and flexoki-light, and the review
 * diff's green and red line tints over it (#5980). Same hue, lower lightness, chosen for at
 * least 4.6:1 on the darkest of those (the flexoki-light removed-line tint).
 * Keyed by theme name, so Shiki applies each map only to its theme.
 * Keys must be lowercase: Shiki lowercases a color before the lookup.
 */
export const SHIKI_COLOR_REPLACEMENTS: Record<string, Record<string, string>> = {
  [SHIKI_LIGHT_THEME]: {
    "#c2c3c5": "#64666a", // comment
    "#1976d2": "#1667b7", // constant, number, link
    "#ff9800": "#945800", // function parameter
    "#22863a": "#1e7533", // tag, quoted string
    "#d32f2f": "#c22929", // keyword, storage
    "#cd3131": "#c02e2e", // error token
    "#316bcd": "#2d63be", // info token
    "#cd9731": "#82601f", // warning token
  },
  /**
   * Lighter replacements for min-dark colors that miss WCAG AA on the dark code backgrounds:
   * `--color-code-bg` in dark and flexoki-dark, the review diff's line tints and the review-range
   * highlight over them (#5983). Same hue, higher lightness, chosen for at least 4.6:1 on the
   * lightest of those (the flexoki-dark added line under the review highlight). The debug token
   * also drops saturation, so it stays a muted purple instead of a bright magenta.
   */
  [SHIKI_DARK_THEME]: {
    "#6b737c": "#90979f", // comment
    "#1976d2": "#4b9bea", // markdown inline link
    "#316bcd": "#6e97dc", // info token
    "#cd3131": "#df7a7a", // error token
    "#800080": "#c77dc7", // debug token
  },
};

/**
 * Whether a theme-mode string maps to the light Shiki theme.
 *
 * Accepts both base modes (`"light"`/`"dark"`) and namespaced variants
 * (e.g. `"flexoki-light"`), keeping the variant suffix convention as the
 * single source of truth for the light/dark mapping.
 */
export function isLightThemeMode(themeMode: string): boolean {
  return themeMode === "light" || themeMode.endsWith("-light");
}

/**
 * Map language names to Shiki-compatible language IDs
 * Handles special cases where detected language differs from Shiki's name
 */
export function mapToShikiLang(detectedLang: string): string {
  const mapping: Record<string, string> = {
    text: "plaintext",
    sh: "bash",
    // Shiki does not bundle a Starlark/Bazel grammar, so use Python's close-enough
    // grammar to keep fenced code blocks highlighted instead of warning and falling back.
    starlark: "python",
    bazel: "python",
    bzl: "python",
  };
  return mapping[detectedLang] || detectedLang;
}

/**
 * Extract line contents from Shiki HTML output
 * Shiki wraps code in <pre><code>...</code></pre> with <span class="line">...</span> per line
 */
function isVisuallyEmptyShikiLine(lineHtml: string): boolean {
  // Shiki represents an empty line as something like:
  //   <span class="line"><span style="..."></span></span>
  // which is visually empty but non-empty as a string.
  //
  // We treat these as empty so callers don't render a phantom blank line.
  const textOnly = lineHtml
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, "")
    .trim();
  return textOnly === "";
}

export function extractShikiLines(html: string): string[] {
  const codeMatch = /<code[^>]*>(.*?)<\/code>/s.exec(html);
  if (!codeMatch) return [];

  const lines = codeMatch[1].split("\n").map((chunk) => {
    const start = chunk.indexOf('<span class="line">');
    if (start === -1) return "";

    const contentStart = start + '<span class="line">'.length;
    const end = chunk.lastIndexOf("</span>");

    const lineHtml = end > contentStart ? chunk.substring(contentStart, end) : "";
    return isVisuallyEmptyShikiLine(lineHtml) ? "" : lineHtml;
  });

  // Remove trailing empty lines (Shiki often adds one).
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}
