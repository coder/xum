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
