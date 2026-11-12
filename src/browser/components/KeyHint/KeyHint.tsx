import type { ReactNode } from "react";
import { cn } from "@/common/lib/utils";

/**
 * A keycap next to the control it triggers ("esc", a formatted keybind). Shown only where a
 * keyboard is likely (a hovering, fine pointer): shortcuts must not show on touch layouts.
 */
export function KeyHint(props: { children: ReactNode; className?: string }) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "border-border-medium bg-hover text-muted hidden shrink-0 rounded-[4px] border px-1.5 py-px font-mono text-[10.5px] leading-normal font-medium [@media(hover:hover)_and_(pointer:fine)]:inline-block",
        props.className
      )}
    >
      {props.children}
    </kbd>
  );
}
