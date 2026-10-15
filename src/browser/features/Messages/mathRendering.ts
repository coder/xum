import { useSyncExternalStore } from "react";
import type { Pluggable } from "unified";

/** Classes rehype-katex renders as math: sanitizeSchema allows them, MarkdownCore looks for them. */
export const MATH_CLASS_NAMES = ["language-math", "math-inline", "math-display"] as const;

type ShikiThemes = ["github-light", "github-dark"];
export const SHIKI_THEME: ShikiThemes = ["github-light", "github-dark"];

// KaTeX loads once, for the first message with math (T3, #5971). The lazy chunk publishes its
// plugins here, and each math row re-renders its own Streamdown instance: a Suspense swap would
// replace the row's DOM nodes. Streamdown's memo ignores plugin changes, so each published list
// brings a new shikiTheme array (default themes; Xum's code renderer ignores them).
interface KatexPlugins {
  plugins: Pluggable[];
  shikiTheme: ShikiThemes;
}
let katex: KatexPlugins | null = null;
// Streamdown re-parses when it gets a new plugin array, so each list gets one KaTeX variant.
let listsWithKatex = new WeakMap<Pluggable[], Pluggable[]>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
// Rows without math never re-render for the KaTeX load.
const subscribeNever = () => () => undefined;

export function publishKatexPlugins(plugins: Pluggable[]): void {
  katex = { plugins, shikiTheme: ["github-light", "github-dark"] };
  listsWithKatex = new WeakMap();
  for (const listener of listeners) listener();
}

/** The published KaTeX plugins, or null until the lazy chunk loads (always null for `false`). */
export function useKatexPlugins(enabled: boolean): KatexPlugins | null {
  const published = useSyncExternalStore(enabled ? subscribe : subscribeNever, () => katex);
  return enabled ? published : null;
}

export function withKatex(base: Pluggable[], plugins: Pluggable[]): Pluggable[] {
  const result = listsWithKatex.get(base) ?? [...base, ...plugins];
  listsWithKatex.set(base, result);
  return result;
}
