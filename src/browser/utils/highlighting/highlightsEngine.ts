/**
 * Syntax highlighting with @pierre/highlights, for the languages it has a lexer for.
 *
 * Highlights tokenizes 50 to 200 times faster than Shiki (one-pass Wasm lexers, no
 * TextMate grammars), so the worker and the main-thread fallback use it first and keep
 * Shiki only for the languages Highlights does not know (ini, nginx, prisma, ...).
 *
 * Output contract: the same HTML shape Shiki's `codeToHtml` produces, so every caller
 * (`extractShikiLines`, `highlightDiffChunk`, the contrast stories) works unchanged:
 *   <pre class="shiki"><code><span class="line">TOKENS</span>\n<span class="line">…</span></code></pre>
 * Each token is `<span style="color:#rrggbb[;font-style:italic][;font-weight:bold]">TEXT</span>`.
 * We do not use Highlights' own `codeToHtml()`: it has no per-line spans, and one span can
 * cross a line break.
 */

import {
  codeToTokens,
  isSupportedLanguage,
  type Lang,
  type Theme,
  type TokensResult,
} from "@pierre/highlights";
import minDark from "@pierre/highlights/themes/min-dark";
import minLight from "@pierre/highlights/themes/min-light";
import {
  escapeHtml,
  SHIKI_COLOR_REPLACEMENTS,
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
} from "./shiki-shared";

// Shiki's FontStyle flags, which Highlights reuses: italic 1, bold 2, underline 4.
const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;

/**
 * Apply a color-replacement map (lowercase keys, as in SHIKI_COLOR_REPLACEMENTS) to every
 * color string in a theme, once at load. Keyed by Xum's theme constants, not `theme.name`
 * ("Min Light"), which differs from Shiki's theme IDs.
 */
function withReplacements(theme: Theme, replacements: Record<string, string> | undefined): Theme {
  if (replacements == null) return theme;
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return replacements[value.toLowerCase()] ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value != null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, replace(v)]));
    }
    return value;
  };
  return replace(theme) as Theme;
}

const THEMES: Record<"dark" | "light", Theme> = {
  dark: withReplacements(minDark, SHIKI_COLOR_REPLACEMENTS[SHIKI_DARK_THEME]),
  light: withReplacements(minLight, SHIKI_COLOR_REPLACEMENTS[SHIKI_LIGHT_THEME]),
};

/** True when Highlights has a lexer for this Shiki language ID (or alias). */
export function canHighlight(shikiLang: string): shikiLang is Lang {
  return isSupportedLanguage(shikiLang);
}

function fontStyleCss(fontStyle: number | undefined): string {
  if (fontStyle == null || fontStyle === 0) return "";
  let css = "";
  if (fontStyle & FONT_ITALIC) css += ";font-style:italic";
  if (fontStyle & FONT_BOLD) css += ";font-weight:bold";
  if (fontStyle & FONT_UNDERLINE) css += ";text-decoration:underline";
  return css;
}

/** Build Shiki-shaped HTML from Highlights tokens (see the module comment). */
export function tokensToShikiHtml(result: TokensResult): string {
  const lines = result.tokens.map((line) => {
    const spans = line.map((token) => {
      // The contrast stories find syntax tokens by a style that starts with `color:#rrggbb`.
      const color = token.color ?? result.fg;
      const style = (color != null ? `color:${color}` : "") + fontStyleCss(token.fontStyle);
      // SECURITY AUDIT: token text is repo/model-controlled and ends up in
      // dangerouslySetInnerHTML, so every token is escaped here.
      return `<span style="${style}">${escapeHtml(token.content)}</span>`;
    });
    return `<span class="line">${spans.join("")}</span>`;
  });
  return `<pre class="shiki"><code>${lines.join("\n")}</code></pre>`;
}

/** Highlight `code` with Highlights. The caller must check `canHighlight(shikiLang)` first. */
export function highlightToShikiHtml(
  code: string,
  shikiLang: string,
  theme: "dark" | "light"
): string {
  if (!canHighlight(shikiLang)) {
    throw new Error(`highlightToShikiHtml: Highlights has no lexer for "${shikiLang}"`);
  }
  return tokensToShikiHtml(codeToTokens(code, { lang: shikiLang, theme: THEMES[theme] }));
}
