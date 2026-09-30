import type { ClassValue } from "clsx";

import { cn } from "@/common/lib/utils";

// Keep adjacent composer pickers visually aligned while leaving placement and width to each picker.
export const COMPOSER_PICKER_PANEL_CLASS =
  "bg-surface-primary border-border-light overflow-hidden rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)] outline-none";

export function composerPickerOptionClass(
  state: { isHighlighted: boolean; isSelected: boolean },
  ...classNames: ClassValue[]
): string {
  return cn(
    "flex cursor-pointer items-center gap-2.5 px-2.5 text-[11px] font-medium transition-colors duration-100",
    state.isHighlighted ? "bg-hover text-foreground" : "bg-transparent hover:bg-hover",
    state.isSelected ? "text-foreground" : "text-light hover:text-foreground",
    classNames
  );
}
