import { useState } from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useNarrowViewportSession } from "@/browser/hooks/useNarrowViewport";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";

/**
 * The left sidebar's collapsed state and its one toggle: an inline sidebar at wide widths, a
 * drawer over the page at narrow widths.
 */
export function useLeftSidebarState(): { collapsed: boolean; toggle: () => void } {
  const narrowSession = useNarrowViewportSession();
  const isNarrow = narrowSession !== 0;
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
  // touches the wide sidebar's saved flag, and belongs to one narrow session: each return to
  // narrow starts closed. Keyed by the session rather than reset during the wide render: with
  // that render-phase reset next to useSyncExternalStore, React 18 skipped the app's re-render on
  // the next fold, and the drawer showed open.
  const [drawerSession, setDrawerSession] = useState<number | null>(null);
  const drawerOpen = isNarrow && drawerSession === narrowSession;

  const toggle = () => {
    if (isNarrow) {
      setDrawerSession((open) => (open === narrowSession ? null : narrowSession));
    } else {
      setWideCollapsed((prev) => !prev);
    }
  };

  return { collapsed: isNarrow ? !drawerOpen : wideCollapsed, toggle };
}
