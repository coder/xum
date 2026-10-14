import { lazy, useState } from "react";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";
import { useRouter } from "@/browser/contexts/RouterContext";
import { useModalFocusReturn } from "@/browser/hooks/useModalFocusReturn";

// T3 (#5971): the dashboard and its recharts charts stay off the first load until Analytics
// first opens.
const AnalyticsDashboard = lazy(() =>
  import("./AnalyticsDashboard").then((module) => ({ default: module.AnalyticsDashboard }))
);

/**
 * Mounts the lazy Analytics dashboard on its first open, then keeps it mounted as before this
 * split, so reopening does not remount it. Focus history is recorded here, from app start: the
 * dashboard mounts already open, so it never saw the opener and the first close would drop focus
 * on the body.
 */
export function LazyAnalyticsDashboard() {
  const { isAnalyticsOpen } = useRouter();
  const focusReturn = useModalFocusReturn(isAnalyticsOpen);
  // Latch during render, not in an effect: a restored /analytics URL is open on the first render.
  const [opened, setOpened] = useState(isAnalyticsOpen);
  if (isAnalyticsOpen && !opened) {
    setOpened(true);
  }
  return opened ? (
    <LazyFeature name="Analytics">
      <AnalyticsDashboard focusReturn={focusReturn} />
    </LazyFeature>
  ) : null;
}
