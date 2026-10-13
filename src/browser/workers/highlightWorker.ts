/**
 * Web Worker for syntax highlighting (Shiki)
 * Moves expensive highlighting work off the main thread
 */

import * as Comlink from "comlink";
import { createHighlighter, type Highlighter } from "shiki";
import {
  mapToShikiLang,
  SHIKI_COLOR_REPLACEMENTS,
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
} from "../utils/highlighting/shiki-shared";

// Singleton highlighter instance within worker
let highlighter: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  // Must use if-check instead of ??= to prevent race condition
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
      langs: [],
    });
  }
  highlighter = await highlighterPromise;
  return highlighter;
}

/** Shiki with the language's grammar loaded (each loads on first use). */
async function getHighlighterFor(shikiLang: string): Promise<Highlighter> {
  const hl = await getHighlighter();
  if (!hl.getLoadedLanguages().includes(shikiLang)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    await hl.loadLanguage(shikiLang as any);
  }
  return hl;
}

const api = {
  /**
   * Start-up handshake: resolves once Shiki and the language's grammar are loaded. The client
   * awaits it before a language's first highlight on this worker, so that start-up time does not
   * count toward the per-input time budget (#6292).
   */
  async prepare(language: string): Promise<void> {
    await getHighlighterFor(mapToShikiLang(language));
  },

  async highlight(code: string, language: string, theme: "dark" | "light"): Promise<string> {
    const shikiLang = mapToShikiLang(language);
    const hl = await getHighlighterFor(shikiLang);

    const shikiTheme = theme === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
    return hl.codeToHtml(code, {
      lang: shikiLang,
      theme: shikiTheme,
      colorReplacements: SHIKI_COLOR_REPLACEMENTS,
    });
  },
};

export type HighlightWorkerAPI = typeof api;

Comlink.expose(api);
