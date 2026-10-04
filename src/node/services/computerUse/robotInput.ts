import { createRequire } from "node:module";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

import type { Point } from "./geometry";
import type { RobotModifier } from "./keys";

export type MouseButton = "left" | "right" | "middle";

/** The input operations ComputerUseService needs; coordinates are in OS input space. */
export interface ComputerUseInputDriver {
  moveMouse(x: number, y: number): void;
  /** Moves while a button is held; macOS needs drag events rather than plain moves. */
  dragMouse(x: number, y: number): void;
  click(button: MouseButton, double: boolean): void;
  mouseToggle(state: "down" | "up", button: MouseButton): void;
  scroll(dx: number, dy: number): void;
  keyTap(key: string, modifiers: RobotModifier[]): void;
  typeString(text: string): void;
  getMousePos(): Point;
}

/** The subset of @jitsi/robotjs this module calls (typed locally: the package is optional). */
interface RobotModule {
  moveMouse(x: number, y: number): void;
  dragMouse(x: number, y: number): void;
  mouseClick(button?: string, double?: boolean): void;
  mouseToggle(down?: string, button?: string): void;
  scrollMouse(x: number, y: number): void;
  keyTap(key: string, modifier?: string | string[]): void;
  typeString(text: string): void;
  getMousePos(): Point;
}

export type InputDriverLoadResult =
  | { ok: true; driver: ComputerUseInputDriver }
  | { ok: false; error: string };

const requireOptional = createRequire(__filename);
let cachedLoad: InputDriverLoadResult | undefined;

/**
 * Lazily loads the native input module once. It is an optional dependency and can also fail to
 * load at runtime (for example a missing libXtst.so.6 on Linux), which makes computer use
 * unsupported instead of crashing.
 */
export function loadRobotInputDriver(): InputDriverLoadResult {
  if (cachedLoad != null) {
    return cachedLoad;
  }
  try {
    const robot = requireOptional("@jitsi/robotjs") as RobotModule;
    cachedLoad = {
      ok: true,
      driver: {
        moveMouse: (x, y) => robot.moveMouse(x, y),
        dragMouse: (x, y) => robot.dragMouse(x, y),
        click: (button, double) => robot.mouseClick(button, double),
        mouseToggle: (state, button) => robot.mouseToggle(state, button),
        scroll: (dx, dy) => robot.scrollMouse(dx, dy),
        keyTap: (key, modifiers) =>
          modifiers.length > 0 ? robot.keyTap(key, modifiers) : robot.keyTap(key),
        typeString: (text) => robot.typeString(text),
        getMousePos: () => robot.getMousePos(),
      },
    };
  } catch (error) {
    const message = getErrorMessage(error);
    log.warn("[computerUse] input driver unavailable", { error: message });
    cachedLoad = { ok: false, error: message };
  }
  return cachedLoad;
}

const TYPE_CHUNK_CHARS = 16;
const DRAG_STEPS = 8;

/**
 * Types in small chunks, yielding between them so the stop shortcut and the Stop button can run;
 * `checkpoint` throws once the action was cancelled or computer use was revoked.
 */
export async function typeText(
  driver: ComputerUseInputDriver,
  text: string,
  checkpoint: () => void
): Promise<void> {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      checkpoint();
      driver.keyTap("enter", []);
      await yieldToEventLoop();
    }
    const chars = Array.from(line);
    for (let start = 0; start < chars.length; start += TYPE_CHUNK_CHARS) {
      checkpoint();
      driver.typeString(chars.slice(start, start + TYPE_CHUNK_CHARS).join(""));
      await yieldToEventLoop();
    }
  }
}

export async function dragMouse(
  driver: ComputerUseInputDriver,
  from: Point,
  to: Point,
  checkpoint: () => void
): Promise<void> {
  checkpoint();
  driver.moveMouse(from.x, from.y);
  driver.mouseToggle("down", "left");
  try {
    for (let step = 1; step <= DRAG_STEPS; step++) {
      await yieldToEventLoop();
      checkpoint();
      driver.dragMouse(
        Math.round(from.x + ((to.x - from.x) * step) / DRAG_STEPS),
        Math.round(from.y + ((to.y - from.y) * step) / DRAG_STEPS)
      );
    }
  } finally {
    // A held button would keep dragging whatever the user touches next.
    driver.mouseToggle("up", "left");
  }
}
