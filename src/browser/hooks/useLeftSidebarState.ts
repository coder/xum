import { useState } from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useNarrowViewport } from "@/browser/hooks/useNarrowViewport";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";

/**
 * The left sidebar's collapsed state and its one toggle: an inline sidebar at wide widths, a
 * drawer over the page at narrow widths.
 */
export function useLeftSidebarState(): { collapsed: boolean; toggle: () => void } {
  const isNarrow = useNarrowViewport();
  // Auto-collapse the wide sidebar by default when the app starts at phone width.
  const startsNarrow =
    typeof window !== "undefined" && window.innerWidth <= NARROW_VIEWPORT_MAX_WIDTH_PX;
  const [wideCollapsed, setWideCollapsed] = usePersistedState(
    LEFT_SIDEBAR_COLLAPSED_KEY,
    startsNarrow,
    { listener: true }
  );
  // Folding devices (iPhone Duo) move between the phone and desktop layouts. A persisted drawer
  // would pop open over the chat on every fold, so the drawer's open state lives in memory, never
  // touches the wide sidebar's saved flag, and closes whenever the layout turns wide (render-time
  // reset), so each return to narrow starts closed.
  const [drawerOpen, setDrawerOpen] = useState(false);
  if (drawerOpen && !isNarrow) {
    setDrawerOpen(false);
  }

  const toggle = () => {
    if (isNarrow) {
      setDrawerOpen((open) => !open);
    } else {
      setWideCollapsed((prev) => !prev);
    }
  };

  return { collapsed: isNarrow ? !drawerOpen : wideCollapsed, toggle };
}
