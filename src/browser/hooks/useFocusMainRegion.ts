import { useEffect, type RefObject } from "react";
import { createCustomEvent, CUSTOM_EVENTS } from "@/common/constants/events";

interface FocusableTarget {
  focus: (options?: FocusOptions) => void;
}

function canFocusTarget(target: FocusableTarget | null): target is FocusableTarget {
  if (!target) {
    return false;
  }

  if (!(target instanceof HTMLElement)) {
    return true;
  }

  return target.closest("[inert]") === null && !target.hidden;
}

export function requestMainRegionFocus(): void {
  requestAnimationFrame(() => {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.FOCUS_MAIN_REGION));
  });
}

/** Focuses the active route's primary region after collapsible layout chrome moves away. */
export function useFocusMainRegion(targetRef: RefObject<FocusableTarget | null>): void {
  useEffect(() => {
    const handleFocusMainRegion = () => {
      const target = targetRef.current;
      if (!canFocusTarget(target)) {
        return;
      }

      target.focus(target instanceof HTMLElement ? { preventScroll: true } : undefined);
    };

    window.addEventListener(CUSTOM_EVENTS.FOCUS_MAIN_REGION, handleFocusMainRegion);
    return () => window.removeEventListener(CUSTOM_EVENTS.FOCUS_MAIN_REGION, handleFocusMainRegion);
  }, [targetRef]);
}
