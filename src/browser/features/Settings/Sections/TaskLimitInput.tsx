import React, { useState } from "react";
import { Input } from "@/browser/components/Input/Input";

interface TaskLimitInputProps {
  /** Accessible name; the visible label is a sibling element, not a <label>. */
  label: string;
  value: number;
  min: number;
  max: number;
  /** The parent clamps and saves the number. */
  onCommit: (value: number) => void;
}

/** A whole number in range, as typed. Only these save while the user is still typing. */
function parseInRange(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= min && parsed <= max ? parsed : null;
}

/**
 * A Task Settings limit field (#6384). It used to clamp and autosave on every keystroke, so a
 * cleared field saved 1 and typing "31" after a clear gave "131". Now the field keeps the typed
 * text while the user edits and saves only a whole number in range. On blur or Enter, any other
 * number is clamped by the parent and saved, and an empty or invalid field goes back to the saved
 * value. It never saves an empty field as 1.
 */
export function TaskLimitInput(props: TaskLimitInputProps) {
  // null: show the saved value. A string: the user's text while editing.
  const [draft, setDraft] = useState<string | null>(null);

  const commitDraft = () => {
    if (draft === null) return;
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    if (Number.isFinite(parsed)) props.onCommit(parsed);
    setDraft(null);
  };

  return (
    <Input
      type="number"
      aria-label={props.label}
      value={draft ?? props.value}
      min={props.min}
      max={props.max}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        setDraft(text);
        const parsed = parseInRange(text, props.min, props.max);
        if (parsed !== null) props.onCommit(parsed);
      }}
      onBlur={commitDraft}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") commitDraft();
      }}
      className="border-border-medium bg-background-secondary h-9 w-28"
    />
  );
}
