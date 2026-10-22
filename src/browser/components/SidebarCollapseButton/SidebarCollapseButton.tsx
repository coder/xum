import { PanelLeft, PanelRight, SquarePen } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { DESKTOP_TITLEBAR_HEIGHT_CLASS, isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { usePinnedViewCoversWindow } from "@/browser/hooks/usePinnedViewCoversWindow";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
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
 * An inert copy of {@link LeftSidebarToggleBar}, hidden, for the header the bar covers (the
 * sidebar's TitleBar while expanded, the page header while collapsed), so header content starts
 * after the bar. Real buttons, so the coarse-pointer 44px minimum widens them like the bar's.
 */
export function LeftSidebarToggleBarSpacer(props: { showNewChat: boolean }) {
  // Electron drags the window where the last app-region rect in DOM order under the pointer is
  // drag, and the hosting header's drag box comes after the fixed bar, so it covers the bar's
  // no-drag buttons. The copy's no-drag button slots, later still, punch the holes back. An
  // `invisible` box reports no region, so desktop hides the copy with opacity instead.
  const isDesktop = isDesktopMode();
  const slotClass = isDesktop && "titlebar-no-drag";
  return (
    <div
      aria-hidden
      className={cn(BAR_LAYOUT_CLASS, isDesktop ? "pointer-events-none opacity-0" : "invisible")}
    >
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        className={cn(TOGGLE_BUTTON_CLASS, slotClass)}
      />
      {props.showNewChat && (
        <>
          <Button
            variant="ghost"
            size="icon"
            tabIndex={-1}
            className={cn(ICON_BUTTON_CLASS, slotClass)}
          />
          <div className={DIVIDER_CLASS} />
        </>
      )}
    </div>
  );
}

/**
 * The spacer for the toolbar of a pinned view (Artifacts fullscreen, a maximized App View tab;
 * render it only while pinned). In a wide window the view covers the workspace shell, and while
 * the left sidebar is collapsed the toggle bar sits over the view's top-left corner, as over the
 * workspace header. Renders nothing otherwise: a view that covers the window covers the bar.
 */
export function PinnedViewToggleBarSpacer() {
  const coversWindow = usePinnedViewCoversWindow();
  // App owns this key. Its default (collapsed in a narrow window) never applies here: the spacer
  // shows only in a wide window.
  const [collapsed] = usePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false, { listener: true });
  // Collapsed inside a workspace, so the bar offers New chat too (App's toggleBarShowsNewChat).
  return collapsed && !coversWindow ? <LeftSidebarToggleBarSpacer showNewChat /> : null;
}

// Shared by the right toggle bar and its title bar hole. `right-sidebar-toggle` (globals.css)
// shows them only where the docked right sidebar can show; the inset matches the header's
// collapsed padding and the tab strip's, so the spacers under the bar line up with it.
const RIGHT_BAR_LAYOUT_CLASS =
  "right-sidebar-toggle titlebar-safe-right titlebar-safe-right-gutter-2 items-center";

interface RightSidebarToggleProps {
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * The right sidebar's toggle, like {@link LeftSidebarToggleBar}: WorkspaceShell mounts it once at
 * the shell's top-right corner, outside the sidebar, so it keeps its size, place and focus in both
 * states while the sidebar's width animates. The header under it reserves its width with
 * {@link RightSidebarToggleSpacer} while the sidebar is collapsed, and the sidebar's top-right tab
 * strip does while it is expanded.
 *
 * pb-px: the header and the strip draw a 1px bottom border inside their height, so their content
 * centers 0.5px higher than the bar's full height would.
 * z-20: above the overview card (z-10) and the sliding panel, below immersive review (z-50).
 * pointer-events-none: the bar's box spans the full title bar inset, but the strip caps its own
 * (`titlebar-safe-right-capped`), so where the inset passes that cap (a narrow split pane) the
 * box covers the strip's controls; only the button takes clicks. Electron's drag regions ignore
 * pointer-events.
 */
export function RightSidebarToggle(props: RightSidebarToggleProps) {
  const isDesktop = isDesktopMode();
  const label = props.collapsed ? "Expand right sidebar" : "Collapse right sidebar";
  return (
    <div
      data-testid="right-sidebar-toggle-bar"
      className={cn(
        RIGHT_BAR_LAYOUT_CLASS,
        "pointer-events-none absolute top-0 right-0 z-20 pb-px",
        isDesktop ? `${DESKTOP_TITLEBAR_HEIGHT_CLASS} titlebar-drag` : "h-8"
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onToggle}
            aria-label={label}
            className={cn(
              ICON_BUTTON_CLASS,
              "pointer-events-auto",
              isDesktop && "titlebar-no-drag"
            )}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          {label}
          <span className="mobile-hide-shortcut-hints">
            {" "}
            ({formatKeybind(KEYBINDS.TOGGLE_RIGHT_SIDEBAR)})
          </span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * An invisible, inert copy of {@link RightSidebarToggle}'s button for the row the bar covers (the
 * workspace header while the sidebar is collapsed, the top-right tab strip while it is expanded),
 * so that row's own controls end before the bar.
 */
export function RightSidebarToggleSpacer(props: { className?: string }) {
  return (
    <Button
      aria-hidden
      variant="ghost"
      size="icon"
      tabIndex={-1}
      className={cn(ICON_BUTTON_CLASS, "invisible", props.className)}
    />
  );
}

/**
 * A no-drag box under {@link RightSidebarToggle}'s button, which WorkspaceShell mounts after the
 * sidebar. Electron drags the window where the last app-region rect in DOM order under the pointer
 * is drag, and the toggle comes before the sidebar (for Tab order), so the sidebar's tab strip
 * covers it, also on every frame of the width slide, when the strip's room is not under it.
 * Transparent, not `invisible`: an `invisible` box reports no region.
 */
export function RightSidebarToggleHole() {
  if (!isDesktopMode()) return null;
  return (
    <div
      aria-hidden
      className={cn(
        RIGHT_BAR_LAYOUT_CLASS,
        "pointer-events-none absolute top-0 right-0 pb-px opacity-0",
        DESKTOP_TITLEBAR_HEIGHT_CLASS
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        className={cn(ICON_BUTTON_CLASS, "titlebar-no-drag")}
      />
    </div>
  );
}
