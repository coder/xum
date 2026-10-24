/**
 * Save and restore the DOM globals that `installDom()` (tests/ui/dom) replaces.
 *
 * `tests/ui/dom` installs a baseline DOM only once per bun process, when it is first
 * evaluated. A test file that clears `window`, `document` or `HTMLElement` in teardown
 * therefore leaves them `undefined` for every later file in the same shard, and a later
 * `import "tests/ui/dom"` does not reinstall them. That broke HeldInput.test.tsx for one
 * CI shard order (#5084). Tests that swap in their own DOM should call `saveDomGlobals()`
 * in `beforeEach` (before replacing anything) and `restoreDomGlobals()` in `afterEach`.
 *
 * This module has no side effects, so importing it does not install a DOM.
 */

// Every global installDom() replaces and puts back. `local/no-clear-dom-global` in
// eslint.config.mjs reports clearing any of these in test files.
const DOM_GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "CustomEvent",
  "DocumentFragment",
  "Element",
  "HTMLInputElement",
  "HTMLElement",
  "NodeFilter",
  "Node",
  "Image",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "ResizeObserver",
  "IntersectionObserver",
  "MutationObserver",
] as const;

export const DOM_GLOBAL_NAMES: readonly string[] = DOM_GLOBAL_KEYS;

/** Snapshot the DOM globals now; the returned function puts those exact values back. */
export function captureDomGlobals(): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const previous = DOM_GLOBAL_KEYS.map((key) => [key, target[key]] as const);
  return () => {
    for (const [key, value] of previous) {
      target[key] = value;
    }
  };
}

// A stack, so nested describe blocks can each save in their own beforeEach.
const savedDomGlobals: (() => void)[] = [];

export function saveDomGlobals(): void {
  savedDomGlobals.push(captureDomGlobals());
}

export function restoreDomGlobals(): void {
  const restore = savedDomGlobals.pop();
  if (restore == null) {
    throw new Error("restoreDomGlobals() called without a matching saveDomGlobals()");
  }
  restore();
}
