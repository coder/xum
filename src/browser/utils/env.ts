/**
 * Environment helpers for the browser/renderer runtime.
 */

export function isVscodeWebview(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === "function";
}

/**
 * `navigator.standalone` exists only on iOS WebKit and is true only when
 * launched from a Home Screen icon, so this never matches desktop PWAs or Android.
 */
export function isIosStandaloneWebApp(): boolean {
  return (navigator as Navigator & { standalone?: unknown }).standalone === true;
}

/** The phone layout's touch screen query (globals.css gates its touch rules on it too). */
export const PHONE_TOUCH_QUERY = "(max-width: 768px) and (pointer: coarse)";

export function isPhoneTouchScreen(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(PHONE_TOUCH_QUERY).matches;
}

/**
 * Focus a field the user did not ask to focus, except on phones: focus there opens the software
 * keyboard, which covers half the screen.
 */
export function autoFocusUnlessPhone(focus: () => void): void {
  if (!isPhoneTouchScreen()) focus();
}
