import * as React from "react";

import { cn } from "@/common/lib/utils";

import { Popover, PopoverAnchor, PopoverContent } from "@/browser/components/Popover/Popover";

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverContent>;

interface HoverClickPopoverProps {
  /** Trigger element for the popover. */
  children: React.ReactElement;
  /** Content to render inside the popover. */
  content: React.ReactNode;
  side?: PopoverContentProps["side"];
  align?: PopoverContentProps["align"];
  sideOffset?: PopoverContentProps["sideOffset"];
  contentClassName?: string;
  contentProps?: Omit<PopoverContentProps, "children">;
  /** Track pointer down/up to avoid closing during drag interactions. */
  interactiveContent?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Invisible hit-area bridge for hover popovers; covers the sideOffset gap on the resolved
// trigger-facing side. Radix may collision-flip placement, so these use runtime data-side.
const HOVER_BRIDGE_CLASSNAME = cn(
  "overflow-visible before:pointer-events-auto before:absolute before:content-['']",
  "data-[side=bottom]:before:-top-2 data-[side=bottom]:before:right-0 data-[side=bottom]:before:left-0 data-[side=bottom]:before:h-2",
  "data-[side=top]:before:-bottom-2 data-[side=top]:before:right-0 data-[side=top]:before:left-0 data-[side=top]:before:h-2",
  "data-[side=left]:before:top-0 data-[side=left]:before:-right-2 data-[side=left]:before:bottom-0 data-[side=left]:before:w-2",
  "data-[side=right]:before:top-0 data-[side=right]:before:bottom-0 data-[side=right]:before:-left-2 data-[side=right]:before:w-2"
);

function composeEventHandlers<E extends { defaultPrevented?: boolean }>(
  userHandler: ((event: E) => void) | undefined,
  ourHandler: ((event: E) => void) | undefined
) {
  return (event: E) => {
    userHandler?.(event);
    if (event.defaultPrevented) return;
    ourHandler?.(event);
  };
}

/**
 * Hover previews the content; click pins it open.
 * This keeps indicator popovers quick to inspect but persistent on demand.
 */
export const HoverClickPopover: React.FC<HoverClickPopoverProps> = (props) => {
  const [isPinned, setIsPinned] = React.useState(false);
  const [isHovering, setIsHovering] = React.useState(false);
  const [isFocused, setIsFocused] = React.useState(false);
  const [isInteracting, setIsInteracting] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const closeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const isOpen = isPinned || isHovering || isFocused;

  const cancelPendingClose = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const scheduleClose = () => {
    if (isPinned || (props.interactiveContent && isInteracting)) return;
    cancelPendingClose();
    closeTimeoutRef.current = setTimeout(() => {
      setIsHovering(false);
    }, 100); // Grace period for pointer to travel between elements
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      cancelPendingClose();
      setIsPinned(false);
      setIsHovering(false);
      setIsFocused(false);
      setIsInteracting(false);
    }
    props.onOpenChange?.(open);
  };

  const handleTriggerClick = () => {
    if (isPinned) {
      setIsPinned(false);
      setIsHovering(false);
      setIsFocused(false);
      return;
    }

    setIsPinned(true);
    setIsFocused(false);
  };

  const handleTriggerPointerEnter = (event: React.PointerEvent<HTMLButtonElement>) => {
    // Avoid disabling hover for mouse on hybrid devices: only ignore *touch* pointers.
    if (event.pointerType === "touch") return;
    cancelPendingClose();
    setIsHovering(true);
  };

  const handleTriggerPointerLeave = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && contentRef.current?.contains(relatedTarget)) {
      return;
    }
    scheduleClose();
  };

  const handleTriggerFocus = () => {
    cancelPendingClose();
    setIsFocused(true);
  };

  const handleTriggerBlur = (event: React.FocusEvent<HTMLButtonElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && contentRef.current?.contains(relatedTarget)) {
      return;
    }
    setIsFocused(false);
  };

  const handleContentPointerEnter = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    cancelPendingClose();
    setIsHovering(true);
  };

  const handleContentPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && triggerRef.current?.contains(relatedTarget)) {
      return;
    }
    scheduleClose();
  };

  const handleContentFocus = () => {
    cancelPendingClose();
    setIsFocused(true);
  };

  const handleContentBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && triggerRef.current?.contains(relatedTarget)) {
      return;
    }
    if (relatedTarget instanceof Node && contentRef.current?.contains(relatedTarget)) {
      return;
    }
    setIsFocused(false);
  };

  const handleContentMouseDown = () => {
    if (props.interactiveContent) setIsInteracting(true);
  };

  const handleContentMouseUp = () => {
    if (props.interactiveContent) setIsInteracting(false);
  };

  const triggerProps = props.children.props as React.ButtonHTMLAttributes<HTMLButtonElement>;
  const trigger = React.cloneElement(props.children, {
    ref: triggerRef,
    "aria-expanded": isOpen,
    "aria-haspopup": triggerProps["aria-haspopup"] ?? "dialog",
    onClick: composeEventHandlers(triggerProps.onClick, handleTriggerClick),
    onFocus: composeEventHandlers(triggerProps.onFocus, handleTriggerFocus),
    onBlur: composeEventHandlers(triggerProps.onBlur, handleTriggerBlur),
    onPointerEnter: composeEventHandlers(triggerProps.onPointerEnter, handleTriggerPointerEnter),
    onPointerLeave: composeEventHandlers(triggerProps.onPointerLeave, handleTriggerPointerLeave),
  });

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        {...props.contentProps}
        ref={contentRef}
        side={props.side}
        align={props.align}
        sideOffset={props.sideOffset}
        className={cn(
          HOVER_BRIDGE_CLASSNAME,
          props.contentClassName,
          props.contentProps?.className
        )}
        onPointerEnter={composeEventHandlers(
          props.contentProps?.onPointerEnter,
          handleContentPointerEnter
        )}
        onPointerLeave={composeEventHandlers(
          props.contentProps?.onPointerLeave,
          handleContentPointerLeave
        )}
        onFocus={composeEventHandlers(props.contentProps?.onFocus, handleContentFocus)}
        onBlur={composeEventHandlers(props.contentProps?.onBlur, handleContentBlur)}
        onMouseDown={composeEventHandlers(props.contentProps?.onMouseDown, handleContentMouseDown)}
        onMouseUp={composeEventHandlers(props.contentProps?.onMouseUp, handleContentMouseUp)}
      >
        {props.content}
      </PopoverContent>
    </Popover>
  );
};
