import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/common/lib/utils";
import { useSafeAreaCollisionPadding } from "@/browser/hooks/useSafeAreaCollisionPadding";
import { stopKeyboardPropagation } from "@/browser/utils/events";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(
  (
    { className, align = "center", sideOffset = 4, collisionPadding, onEscapeKeyDown, ...props },
    ref
  ) => {
    const safeCollisionPadding = useSafeAreaCollisionPadding(collisionPadding);
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={safeCollisionPadding}
          onEscapeKeyDown={(e) => {
            // Prevent Escape from propagating to global handlers (e.g., stream interrupt).
            e.stopPropagation();
            onEscapeKeyDown?.(e);
          }}
          className={cn(
            "bg-dark border-border z-[1600] w-(--radix-popover-trigger-width) min-w-[200px] rounded-md border shadow-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  }
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

/**
 * Content props for a popover opened with `<Popover modal>` that holds its own controls (rows,
 * fields, a filter). The page has several global key listeners (shortcuts, the composer's
 * suggestion menu); giving each an exception for each popover did not hold up in review. Instead
 * the popover is modal: `aria-modal` makes isDialogOpen() true, so shortcuts stand down, and keys
 * pressed inside stop here, so document listeners never act on them. Radix closes on Escape in
 * the capture phase, before this runs.
 */
const MODAL_POPOVER_CONTENT_PROPS = {
  "aria-modal": true,
  onKeyDown: stopKeyboardPropagation,
} as const;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, MODAL_POPOVER_CONTENT_PROPS };
