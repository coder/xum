import { createRequire } from "node:module";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

import type { ComputerUsePlatform, Point } from "./geometry";
import type { ParsedKeyCombo, RobotModifier } from "./keys";

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
 * robotjs on X11 types a character with the keycode that carries its keysym but never adds the
 * Shift level, so shifted symbols come out unshifted (and `"` not at all). Type them as Shift plus
 * their US-layout base key; other X11 layouts can still differ for these symbols.
 */
const X11_SHIFTED_SYMBOL_BASE_KEYS = new Map(
  Object.entries({
    "~": "`",
    "!": "1",
    "@": "2",
    "#": "3",
    $: "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
    ")": "0",
    _: "-",
    "+": "=",
    "{": "[",
    "}": "]",
    "|": "\\",
    ":": ";",
    '"': "'",
    "<": ",",
    ">": ".",
    "?": "/",
  })
);

/** A `key` combo can name a shifted symbol directly (":" or "ctrl+@"); X11 needs its base key. */
export function toX11KeyCombo(combo: ParsedKeyCombo): ParsedKeyCombo {
  const baseKey = X11_SHIFTED_SYMBOL_BASE_KEYS.get(combo.key);
  if (baseKey == null) {
    return combo;
  }
  const modifiers: RobotModifier[] = combo.modifiers.includes("shift")
    ? combo.modifiers
    : [...combo.modifiers, "shift"];
  return { key: baseKey, modifiers };
}

type TypeStep = { text: string } | { key: string; modifiers: RobotModifier[] };

/**
 * robotjs truncates characters it cannot type (non-ASCII on X11, beyond U+FFFF on macOS) instead
 * of failing, so check the whole text before the first keystroke rather than typing part of it.
 */
function assertTypable(char: string, platform: ComputerUsePlatform): void {
  const code = char.codePointAt(0) ?? 0;
  if (platform === "linux" ? char !== "\t" && (code < 0x20 || code > 0x7e) : code > 0xffff) {
    throw new Error(
      `Cannot type ${JSON.stringify(char)}: ` +
        (platform === "linux"
          ? "on Linux, type supports printable ASCII only."
          : "characters beyond U+FFFF, such as emoji, are not supported.") +
        " Nothing was typed."
    );
  }
}

function planTyping(text: string, platform: ComputerUsePlatform): TypeStep[] {
  const steps: TypeStep[] = [];
  let chunk: string[] = [];
  const flushChunk = () => {
    if (chunk.length > 0) {
      steps.push({ text: chunk.join("") });
      chunk = [];
    }
  };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (index > 0) {
      flushChunk();
      steps.push({ key: "enter", modifiers: [] });
    }
    for (const char of line) {
      assertTypable(char, platform);
      const shiftedBaseKey =
        platform === "linux" ? X11_SHIFTED_SYMBOL_BASE_KEYS.get(char) : undefined;
      if (shiftedBaseKey != null) {
        flushChunk();
        steps.push({ key: shiftedBaseKey, modifiers: ["shift"] });
        continue;
      }
      chunk.push(char);
      if (chunk.length === TYPE_CHUNK_CHARS) {
        flushChunk();
      }
    }
  }
  flushChunk();
  return steps;
}

/**
 * Types in small steps, yielding between them so the stop shortcut and the Stop button can run;
 * `checkpoint` throws once the action was cancelled or computer use was revoked.
 */
export async function typeText(
  driver: ComputerUseInputDriver,
  platform: ComputerUsePlatform,
  text: string,
  checkpoint: () => void
): Promise<void> {
  for (const step of planTyping(text, platform)) {
    checkpoint();
    if ("text" in step) {
      driver.typeString(step.text);
    } else {
      driver.keyTap(step.key, step.modifiers);
    }
    await yieldToEventLoop();
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
