import assert from "@/common/utils/assert";

export interface Keybind {
  key: string;
  /**
   * Optional physical key identifier (KeyboardEvent.code).
   * Use this for shifted punctuation shortcuts where event.key differs by layout,
   * but the physical key should remain stable.
   */
  code?: string;
  ctrl?: boolean;
  /**
   * Allow Shift even when this keybind doesn't require it.
   *
   * Useful for keyboard layouts where producing a character (e.g. "/") requires Shift,
   * but the resulting `KeyboardEvent.key` is still that character.
   */
  allowShift?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /**
   * On macOS, Ctrl-based shortcuts traditionally use Cmd instead.
   * Use this field to control that behavior:
   * - "either" (default): accept Ctrl or Cmd
   * - "command": require Cmd specifically
   * - "control": require the Control key specifically
   */
  macCtrlBehavior?: "either" | "command" | "control";
  /**
   * Marks a keybind as deprecated. Deprecated keybinds still function (kept for
   * muscle memory / backwards-compat) but are hidden from generated keybind
   * references (e.g. Settings → Keybinds) so they aren't advertised to users.
   */
  deprecated?: boolean;
}

export function hasModifierKeybind(keybind: Keybind): boolean {
  return [keybind.ctrl, keybind.shift, keybind.alt, keybind.meta].some((v) => v === true);
}

export function normalizeKeybind(raw: unknown): Keybind | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;

  const rawKey = typeof record.key === "string" ? record.key : "";
  const key = rawKey === " " ? rawKey : rawKey.trim();
  if (!key) {
    return undefined;
  }

  const code =
    typeof record.code === "string" && record.code.trim().length > 0
      ? record.code.trim()
      : undefined;
  const allowShift = typeof record.allowShift === "boolean" ? record.allowShift : undefined;
  const ctrl = typeof record.ctrl === "boolean" ? record.ctrl : undefined;
  const shift = typeof record.shift === "boolean" ? record.shift : undefined;
  const alt = typeof record.alt === "boolean" ? record.alt : undefined;
  const meta = typeof record.meta === "boolean" ? record.meta : undefined;

  const macCtrlBehavior =
    record.macCtrlBehavior === "either" ||
    record.macCtrlBehavior === "command" ||
    record.macCtrlBehavior === "control"
      ? record.macCtrlBehavior
      : undefined;

  const result: Keybind = {
    key,
    code,
    allowShift,
    ctrl,
    shift,
    alt,
    meta,
    macCtrlBehavior,
  };

  assert(typeof result.key === "string" && result.key.length > 0, "Keybind.key must be non-empty");

  return result;
}
