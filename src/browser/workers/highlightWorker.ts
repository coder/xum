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

const api = {
  async highlight(code: string, language: string, theme: "dark" | "light"): Promise<string> {
    const hl = await getHighlighter();
    const shikiLang = mapToShikiLang(language);

    // Load language on-demand
    const loadedLangs = hl.getLoadedLanguages();
    if (!loadedLangs.includes(shikiLang)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      await hl.loadLanguage(shikiLang as any);
    }

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
