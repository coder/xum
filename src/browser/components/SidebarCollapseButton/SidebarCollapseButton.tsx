import { PanelLeft, SquarePen } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { DESKTOP_TITLEBAR_HEIGHT_CLASS, isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";

// Shared by the bar and its spacers, so a spacer is exactly as wide as the bar in every layout:
// the titlebar insets, phone gutters and 44px touch targets (`left-sidebar-toggle-host` and
// `mobile-menu-btn` in globals.css) all key off these classes.
const BAR_LAYOUT_CLASS =
  "left-sidebar-toggle-host titlebar-safe-left titlebar-safe-left-gutter-4 flex shrink-0 items-center gap-1";
const ICON_BUTTON_CLASS = "text-muted hover:text-foreground h-6 w-6 shrink-0";
const TOGGLE_BUTTON_CLASS = cn(ICON_BUTTON_CLASS, "mobile-menu-btn");
const DIVIDER_CLASS = "bg-border-light mx-1.5 h-4 w-px";

interface LeftSidebarToggleBarProps {
  collapsed: boolean;
  /** Whether the bar offers New chat: only while collapsed and when the page has a target. */
  showNewChat: boolean;
  onToggle: () => void;
}

/**
 * The left sidebar's toggle (and, while it is collapsed, its New chat action). The app shell
 * mounts it once, fixed at the window's top-left, outside the animated sidebar and the page
 * headers: it stays put while the sidebar width animates, keeps focus across toggles, and exists
 * on every page state, including the page loading and failure frames. Headers under it reserve its
 * width with {@link LeftSidebarToggleBarSpacer}.
 *
 * z-[1050]: above sticky page headers (z-50) and the phone sidebar drawer (z-1000), below the
 * full-screen right sidebar (z-1100) and dialogs (z-1500).
 */
export function LeftSidebarToggleBar(props: LeftSidebarToggleBarProps) {
  const isDesktop = isDesktopMode();
  const toggleLabel = props.collapsed ? "Open sidebar" : "Collapse sidebar";
  return (
    <div
      data-testid="left-sidebar-toggle-bar"
      className={cn(
        BAR_LAYOUT_CLASS,
        "fixed top-[env(safe-area-inset-top)] left-[env(safe-area-inset-left)] z-[1050]",
        isDesktop ? `${DESKTOP_TITLEBAR_HEIGHT_CLASS} titlebar-drag` : "h-8"
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onToggle}
            // "menu": at phone widths the collapsed sidebar opens as a drawer.
            aria-label={props.collapsed ? "Open sidebar menu" : toggleLabel}
            className={cn(TOGGLE_BUTTON_CLASS, isDesktop && "titlebar-no-drag")}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {toggleLabel}
          <span className="mobile-hide-shortcut-hints">
            {" "}
            ({formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)})
          </span>
        </TooltipContent>
      </Tooltip>
      {props.showNewChat && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                // ProjectSidebar stays mounted while collapsed and owns the draft logic.
                onClick={() =>
                  window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.NEW_CHAT_REQUESTED))
                }
                aria-label="New chat"
                className={cn(ICON_BUTTON_CLASS, isDesktop && "titlebar-no-drag")}
              >
                <SquarePen className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              New chat
              <span className="mobile-hide-shortcut-hints">
                {" "}
                ({formatKeybind(KEYBINDS.NEW_WORKSPACE)})
              </span>
            </TooltipContent>
          </Tooltip>
          <div aria-hidden className={DIVIDER_CLASS} />
        </>
      )}
    </div>
  );
}

/**
 * An invisible, inert copy of {@link LeftSidebarToggleBar} for the header the bar covers (the
 * sidebar's TitleBar while expanded, the page header while collapsed), so header content starts
 * after the bar. Real buttons, so the coarse-pointer 44px minimum widens them like the bar's.
 */
export function LeftSidebarToggleBarSpacer(props: { showNewChat: boolean }) {
  return (
    <div aria-hidden className={cn(BAR_LAYOUT_CLASS, "invisible")}>
      <Button variant="ghost" size="icon" tabIndex={-1} className={TOGGLE_BUTTON_CLASS} />
      {props.showNewChat && (
        <>
          <Button variant="ghost" size="icon" tabIndex={-1} className={ICON_BUTTON_CLASS} />
          <div className={DIVIDER_CLASS} />
        </>
      )}
    </div>
  );
}
