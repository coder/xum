import { lazy, useState } from "react";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useModalFocusReturn } from "@/browser/hooks/useModalFocusReturn";

// T3 (#5971): Settings and all its sections stay off the first load until Settings first opens.
const SettingsPage = lazy(() =>
  import("./SettingsPage").then((module) => ({ default: module.SettingsPage }))
);

/**
 * Mounts the lazy Settings page on its first open, then keeps it mounted so the dialog's close
 * animation still plays. Focus history is recorded here, from app start: the page mounts already
 * open, so it never saw the opener and the first close would drop focus on the body.
 */
export function LazySettingsPage() {
  const { isOpen } = useSettings();
  const focusReturn = useModalFocusReturn(isOpen);
  // Latch during render, not in an effect: a restored /settings URL is open on the first render.
  const [opened, setOpened] = useState(isOpen);
  if (isOpen && !opened) {
    setOpened(true);
  }
  return opened ? (
    <LazyFeature name="Settings">
      <SettingsPage focusReturn={focusReturn} />
    </LazyFeature>
  ) : null;
}
