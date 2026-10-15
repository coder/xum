import React from "react";
import { PanelLeft, SquarePen } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { DESKTOP_TITLEBAR_HEIGHT_CLASS, isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";

/**
 * Hosts of the left sidebar toggle (the sidebar's TitleBar while expanded, page headers while
 * collapsed) share this left padding and the titlebar height, so the icon stays put when the
 * sidebar opens or closes.
 */
export const LEFT_SIDEBAR_TOGGLE_HOST_CLASS = "titlebar-safe-left titlebar-safe-left-gutter-4";

const ICON_BUTTON_CLASS = "text-muted hover:text-foreground h-6 w-6 shrink-0";

interface SidebarCollapseButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}

export const SidebarCollapseButton: React.FC<SidebarCollapseButtonProps> = (props) => {
  const label = props.collapsed ? "Open sidebar" : "Collapse sidebar";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onToggle}
          // "menu": at phone widths the collapsed sidebar opens as a drawer.
          aria-label={props.collapsed ? "Open sidebar menu" : label}
          className={cn(ICON_BUTTON_CLASS, isDesktopMode() && "titlebar-no-drag", props.className)}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} ({formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)})
      </TooltipContent>
    </Tooltip>
  );
};

/**
 * Page-header controls that stand in for the collapsed left sidebar: its toggle, its "New chat"
 * action, and (with `divider`) a line before the page's own header title.
 */
export const CollapsedSidebarHeaderControls: React.FC<{
  onToggle: () => void;
  divider?: boolean;
}> = (props) => (
  <div className={cn("flex shrink-0 items-center gap-1", isDesktopMode() && "titlebar-no-drag")}>
    <SidebarCollapseButton collapsed onToggle={props.onToggle} className="mobile-menu-btn" />
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.NEW_CHAT_REQUESTED))}
          aria-label="New chat"
          className={ICON_BUTTON_CLASS}
        >
          <SquarePen className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>New chat ({formatKeybind(KEYBINDS.NEW_WORKSPACE)})</TooltipContent>
    </Tooltip>
    {props.divider && <div aria-hidden className="bg-border-light mx-1.5 h-4 w-px" />}
  </div>
);

/**
 * A header with only those controls, for workspace states without a header of their own (an
 * incompatible workspace, the loading placeholder). The collapsed sidebar has no width, so without
 * it a pointer user could not reopen the sidebar from these states.
 */
export const CollapsedSidebarHeaderBar: React.FC<{ onToggle: () => void }> = (props) => (
  <div
    className={cn(
      "bg-sidebar border-border-light mobile-sticky-header flex shrink-0 items-center border-b px-2 [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2",
      LEFT_SIDEBAR_TOGGLE_HOST_CLASS,
      isDesktopMode() ? `${DESKTOP_TITLEBAR_HEIGHT_CLASS} titlebar-drag` : "h-8"
    )}
  >
    <CollapsedSidebarHeaderControls onToggle={props.onToggle} />
  </div>
);
