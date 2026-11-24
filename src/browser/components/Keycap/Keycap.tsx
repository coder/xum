/**
 * Keycap - OS-aware keyboard key display component.
 * Renders keyboard shortcuts as styled <kbd> elements.
 * Inspired by pulldash keycap patterns.
 */

import React from "react";
import { cn } from "@/common/lib/utils";
import { isMac } from "@/browser/utils/ui/keybinds";

interface KeycapProps {
  /** The key label to display. Special values: "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Enter", "Shift", "Ctrl", "Cmd", "Alt" */
  children: string;
  className?: string;
}

const KEY_DISPLAY_MAP: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "↵",
  Backspace: "⌫",
  Shift: "⇧",
  " ": "Space",
};

const MAC_KEY_MAP: Record<string, string> = {
  Ctrl: "⌘",
  Alt: "⌥",
  Cmd: "⌘",
};

const WIN_KEY_MAP: Record<string, string> = {
  Cmd: "Ctrl",
};

/** The glyph or short name a key label displays as (e.g. "ArrowUp" as an arrow, "Ctrl" as ⌘ on Mac). */
export function formatKeyLabel(key: string): string {
  const onMac = isMac();
  let label = key;

  // Apply platform-specific mappings first
  if (onMac && label in MAC_KEY_MAP) {
    label = MAC_KEY_MAP[label];
  } else if (!onMac && label in WIN_KEY_MAP) {
    label = WIN_KEY_MAP[label];
  }

  // Apply universal display mappings
  if (label in KEY_DISPLAY_MAP) {
    label = KEY_DISPLAY_MAP[label];
  }

  // Single letters: uppercase
  if (label.length === 1 && /[a-z]/.test(label)) {
    label = label.toUpperCase();
  }
  return label;
}

/**
 * Single key cap (styled <kbd>)
 */
export const Keycap: React.FC<KeycapProps> = (props) => {
  const label = formatKeyLabel(props.children);

  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border px-1",
        "border-border-medium bg-dark text-muted text-[10px] font-medium leading-none",
        props.className
      )}
    >
      {label}
    </kbd>
  );
};

interface KeycapGroupProps {
  /** Array of key labels, rendered as a sequence of keycaps */
  keys: string[];
  /** Label to show after the keycaps */
  label?: string;
  className?: string;
}

/**
 * Group of keycaps with an optional label.
 * Renders keys as a tight group with a description.
 * Example: <KeycapGroup keys={["j", "k"]} label="prev / next hunk" />
 */
export const KeycapGroup: React.FC<KeycapGroupProps> = (props) => {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px]", props.className)}>
      <span className="inline-flex items-center gap-0.5">
        {props.keys.map((key, i) => (
          <Keycap key={i}>{key}</Keycap>
        ))}
      </span>
      {props.label && <span className="text-dim">{props.label}</span>}
    </span>
  );
};
