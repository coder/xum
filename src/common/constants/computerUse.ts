/** Native host computer use (the `computer` tool driving the real display of the Xum desktop app). */

/** Screenshots are downscaled so their long edge stays within what vision models read well. */
export const COMPUTER_USE_MAX_LONG_EDGE = 1568;
/** Pixel budget per screenshot; bounds image tokens on very wide displays. */
export const COMPUTER_USE_MAX_PIXELS = 1_150_000;
export const COMPUTER_USE_JPEG_QUALITY = 80;
/**
 * No OS signal reports "the UI finished reacting to this input", so input actions
 * wait this long before the follow-up screenshot.
 */
export const COMPUTER_USE_SETTLE_MS = 500;
export const COMPUTER_USE_MAX_TYPE_CHARS = 2000;
export const COMPUTER_USE_MAX_SCROLL_AMOUNT = 20;
export const COMPUTER_USE_MAX_WAIT_SECONDS = 10;
/** Electron accelerator that turns computer use off while any workspace owns it. */
export const COMPUTER_USE_STOP_ACCELERATOR = "CommandOrControl+Shift+Escape";

export const COMPUTER_USE_ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "mouse_move",
  "left_click_drag",
  "scroll",
  "type",
  "key",
  "wait",
  "cursor_position",
] as const;
export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number];

export const COMPUTER_USE_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type ComputerUseScrollDirection = (typeof COMPUTER_USE_SCROLL_DIRECTIONS)[number];
