export type RobotModifier = "command" | "control" | "alt" | "shift";

export interface ParsedKeyCombo {
  /** robotjs key name (`enter`, `pageup`, `f5`, or a single character). */
  key: string;
  modifiers: RobotModifier[];
}

const MODIFIER_ALIASES: Record<string, RobotModifier> = {
  cmd: "command",
  command: "command",
  super: "command",
  meta: "command",
  win: "command",
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

const NAMED_KEYS: Record<string, string> = {
  return: "enter",
  enter: "enter",
  tab: "tab",
  escape: "escape",
  esc: "escape",
  backspace: "backspace",
  delete: "delete",
  space: "space",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  page_up: "pageup",
  pageup: "pageup",
  page_down: "pagedown",
  pagedown: "pagedown",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `f${i + 1}`])),
};

export const ACCEPTED_KEY_NAMES =
  "Return/Enter, Tab, Escape/Esc, BackSpace, Delete, space, Up, Down, Left, Right, Home, End, " +
  "Page_Up, Page_Down, F1-F12, or a single character; modifiers cmd, ctrl, alt/option, shift";

function resolveKey(name: string, combo: string): string {
  // Single characters are typed as themselves; "A" means the a key (add shift explicitly).
  if (name.length === 1) {
    return name.toLowerCase();
  }
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named == null) {
    throw new Error(`Unknown key "${name}" in "${combo}". Accepted keys: ${ACCEPTED_KEY_NAMES}.`);
  }
  return named;
}

/** Parses xdotool-style combos such as "cmd+shift+4", "Return", or "ctrl+c". */
export function parseKeyCombo(combo: string): ParsedKeyCombo {
  const trimmed = combo.trim();
  if (trimmed.length === 0) {
    throw new Error(`Key must not be empty. Accepted keys: ${ACCEPTED_KEY_NAMES}.`);
  }

  let keyName: string;
  let modifierNames: string[];
  if (trimmed === "+") {
    keyName = "+";
    modifierNames = [];
  } else if (trimmed.endsWith("++")) {
    keyName = "+";
    modifierNames = trimmed.slice(0, -2).split("+");
  } else {
    const parts = trimmed.split("+");
    keyName = parts[parts.length - 1];
    modifierNames = parts.slice(0, -1);
  }

  const modifiers: RobotModifier[] = [];
  for (const name of modifierNames) {
    const modifier = MODIFIER_ALIASES[name.trim().toLowerCase()];
    if (modifier == null) {
      throw new Error(
        `Unknown modifier "${name}" in "${combo}". Accepted keys: ${ACCEPTED_KEY_NAMES}.`
      );
    }
    if (!modifiers.includes(modifier)) {
      modifiers.push(modifier);
    }
  }

  return { key: resolveKey(keyName.trim(), combo), modifiers };
}
