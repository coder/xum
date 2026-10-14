import type { ComputerUseScrollDirection } from "@/common/constants/computerUse";

import type { ComputerUsePlatform } from "./geometry";

/**
 * macOS scroll events are posted in pixels, so one wheel click is approximated with a fixed
 * pixel distance (the same convention coder/coder chatd uses).
 */
const DARWIN_PIXELS_PER_CLICK = 100;

/**
 * Arguments for robotjs `scrollMouse(x, y)`. On both platforms positive y scrolls up and
 * negative x scrolls right; Linux posts one wheel-button click per unit.
 */
export function scrollDeltaFor(
  direction: ComputerUseScrollDirection,
  amount: number,
  platform: ComputerUsePlatform
): { x: number; y: number } {
  const units = platform === "darwin" ? amount * DARWIN_PIXELS_PER_CLICK : amount;
  switch (direction) {
    case "up":
      return { x: 0, y: units };
    case "down":
      return { x: 0, y: -units };
    case "left":
      return { x: units, y: 0 };
    case "right":
      return { x: -units, y: 0 };
  }
}
