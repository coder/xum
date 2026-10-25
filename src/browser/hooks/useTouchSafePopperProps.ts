import { useSyncExternalStore } from "react";

type Side = "top" | "right" | "bottom" | "left";
export type CollisionPadding = number | Partial<Record<Side, number>>;
type Insets = Record<"top" | "right" | "left", number>;

const NO_INSETS: Insets = { top: 0, right: 0, left: 0 };

let probe: HTMLElement | null = null;
let lastInsets = NO_INSETS;
// Every Popover and Select content renders this hook, open or not, and reading the probe's
// padding forces layout, so measure only on first use and after the window resizes.
let insetsStale = true;

function markInsetsStale() {
  insetsStale = true;
}

// env() only resolves inside CSS, so a hidden fixed element padded by the insets exposes them.
function createProbe(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("aria-hidden", "true");
  element.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) 0 env(safe-area-inset-left,0px)";
  document.body.appendChild(element);
  // Mounted menus hear resizes through subscribe; this also covers a resize (a fold) while no
  // menu is mounted. addEventListener ignores a second registration of the same listener.
  window.addEventListener("resize", markInsetsStale);
  return element;
}

function readInsets(): Insets {
  if (typeof document === "undefined" || document.body == null) return NO_INSETS;
  if (probe == null || !document.body.contains(probe)) {
    probe = createProbe();
    insetsStale = true;
  }
  if (!insetsStale) return lastInsets;
  insetsStale = false;
  const style = window.getComputedStyle(probe);
  const top = parseFloat(style.paddingTop) || 0;
  const right = parseFloat(style.paddingRight) || 0;
  const left = parseFloat(style.paddingLeft) || 0;
  // useSyncExternalStore needs the same snapshot object while the insets are unchanged.
  if (top !== lastInsets.top || right !== lastInsets.right || left !== lastInsets.left) {
    lastInsets = { top, right, left };
  }
  return lastInsets;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  // Insets change with rotation and when a folding phone switches displays; both resize the
  // window. React reads the snapshot inside onChange; the probe's resize listener runs first
  // because the first snapshot read, before any subscribe, registered it.
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function getServerSnapshot(): Insets {
  return NO_INSETS;
}

function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * Positioning props for portaled Radix menus (Popover, Select) on phones and tablets.
 *
 * - Collision padding includes the top and side safe areas. The app shell pads them (App.tsx),
 *   but menus portal to <body>; on an iPhone Duo cover display the top inset sits under an opaque
 *   status area, which hid the first rows of a menu Radix fitted to the viewport edge. The bottom
 *   inset stays out, as in the app shell (globals.css).
 * - Touch devices re-measure every frame. Tapping a menu trigger while the composer has focus
 *   starts the software keyboard closing, so Radix measures against the keyboard-shrunk visual
 *   viewport. iOS can report the keyboard's exit only through visualViewport events, which Radix's
 *   default update strategy ignores, so such a menu could keep a flipped side or a tiny height
 *   until a scroll re-measured it (iPhone Duo home-screen app).
 */
export function useTouchSafePopperProps(padding: CollisionPadding = 0): {
  collisionPadding: Partial<Record<Side, number>>;
  updatePositionStrategy: "optimized" | "always";
} {
  const insets = useSyncExternalStore(subscribe, readInsets, getServerSnapshot);
  const base: Partial<Record<Side, number>> =
    typeof padding === "number"
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : padding;
  return {
    collisionPadding: {
      top: (base.top ?? 0) + insets.top,
      right: (base.right ?? 0) + insets.right,
      bottom: base.bottom ?? 0,
      left: (base.left ?? 0) + insets.left,
    },
    updatePositionStrategy: isCoarsePointer() ? "always" : "optimized",
  };
}
