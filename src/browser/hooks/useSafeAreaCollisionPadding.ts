import { useSyncExternalStore } from "react";

type Side = "top" | "right" | "bottom" | "left";
export type CollisionPadding = number | Partial<Record<Side, number>>;
type Insets = Record<"top" | "right" | "left", number>;

const NO_INSETS: Insets = { top: 0, right: 0, left: 0 };

interface Probes {
  topLeft: HTMLElement;
  right: HTMLElement;
}

let probes: Probes | null = null;
let lastInsets = NO_INSETS;
// Every Popover and Select content renders this hook, open or not, and reading the probes'
// padding forces layout, so measure only on first use and after the probes change size.
let insetsStale = true;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

// The probes' ResizeObserver callback. Mounted menus hear of the change in the next frame: a menu
// that re-renders inside this callback resizes during the browser's observer loop, which reports
// an error. Until then, and while no menu is mounted, the next read measures again.
function markInsetsChanged() {
  insetsStale = true;
  window.requestAnimationFrame(notifyListeners);
}

// env() only resolves inside CSS, so hidden elements with an empty content box, padded by the
// insets, expose them, and their border boxes resize exactly when an inset changes. A ResizeObserver on them, not the
// window's resize event, reports the changes: when a folding phone switches displays the window
// can resize before the insets change, and a half turn of a landscape phone swaps the side insets
// with no resize at all. That swap keeps the sum of the side insets, so the right one has its own
// element.
function createProbes(): Probes {
  const topLeft = document.createElement("div");
  topLeft.setAttribute("aria-hidden", "true");
  topLeft.style.cssText =
    // mutation-equivalent: unit tests cannot see env(); Chromium's assertMenuClearsSafeArea can.
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top,0px) 0 0 env(safe-area-inset-left,0px)";
  const right = document.createElement("div");
  right.style.cssText = "width:0;height:0;padding-right:env(safe-area-inset-right,0px)";
  topLeft.appendChild(right);
  document.body.appendChild(topLeft);
  if (typeof window.ResizeObserver === "function") {
    const observer = new window.ResizeObserver(markInsetsChanged);
    observer.observe(topLeft, { box: "border-box" });
    observer.observe(right, { box: "border-box" });
  }
  return { topLeft, right };
}

function measureInsets(current: Probes): Insets {
  const topLeft = window.getComputedStyle(current.topLeft);
  const top = parseFloat(topLeft.paddingTop) || 0;
  const left = parseFloat(topLeft.paddingLeft) || 0;
  const right = parseFloat(window.getComputedStyle(current.right).paddingRight) || 0;
  // useSyncExternalStore needs the same snapshot object while the insets are unchanged.
  return top === lastInsets.top && right === lastInsets.right && left === lastInsets.left
    ? lastInsets
    : { top, right, left };
}

function readInsets(): Insets {
  if (probes == null || !document.body.contains(probes.topLeft)) {
    probes = createProbes();
    insetsStale = true;
  }
  if (insetsStale) {
    insetsStale = false;
    lastInsets = measureInsets(probes);
  }
  return lastInsets;
}

// dry-duplicate-ok: the usual useSyncExternalStore subscribe over this module's own listeners; the
// other stores with this shape own other listener sets and change apart.
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getServerSnapshot(): Insets {
  return NO_INSETS;
}

function sidePadding(padding: CollisionPadding, side: Side): number {
  // mutation-equivalent: a side is a number, so ?? and || differ only for NaN, which no caller passes.
  return typeof padding === "number" ? padding : (padding[side] ?? 0);
}

/**
 * Collision padding for portaled Radix menus (Popover, Select) that also clears the top and side
 * safe areas. The app shell pads them (App.tsx), but menus portal to <body>; on an iPhone Duo cover
 * display the top inset sits under an opaque status area, which hid the first rows of a menu Radix
 * fitted to the viewport edge. The bottom inset stays out, as in the app shell (globals.css).
 */
export function useSafeAreaCollisionPadding(padding: CollisionPadding = 0): Record<Side, number> {
  const insets = useSyncExternalStore(subscribe, readInsets, getServerSnapshot);
  return {
    top: sidePadding(padding, "top") + insets.top,
    right: sidePadding(padding, "right") + insets.right,
    bottom: sidePadding(padding, "bottom"),
    left: sidePadding(padding, "left") + insets.left,
  };
}
