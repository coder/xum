import { useEffect, useRef } from "react";

const FOCUS_HISTORY_LIMIT = 3;

/**
 * Return focus to the opener when a route-backed modal (Settings, Analytics) closes.
 *
 * Radix only returns focus to a DialogTrigger, and these modals open from shortcuts, menus, and
 * the command palette, whose focused item often unmounts as the modal opens. Recent focus is
 * tracked while closed so closing can fall back to the latest element still on the page.
 * Spread the returned handlers onto `DialogContent`.
 */
export function useModalFocusReturn(isOpen: boolean): {
  onOpenAutoFocus: () => void;
  onCloseAutoFocus: (event: Event) => void;
} {
  const focusHistoryRef = useRef<HTMLElement[]>([]);
  const returnFocusRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    if (isOpen) {
      return;
    }
    const recordFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      focusHistoryRef.current = [
        target,
        ...focusHistoryRef.current.filter((element) => element !== target),
      ].slice(0, FOCUS_HISTORY_LIMIT);
    };
    document.addEventListener("focusin", recordFocus);
    return () => document.removeEventListener("focusin", recordFocus);
  }, [isOpen]);

  return {
    onOpenAutoFocus: () => {
      returnFocusRef.current = focusHistoryRef.current;
    },
    onCloseAutoFocus: (event) => {
      event.preventDefault();
      const candidates = returnFocusRef.current;
      returnFocusRef.current = [];
      // Closing by navigating elsewhere can hand focus to the destination (a newly shown chat
      // input autofocuses); only recover focus that fell back to the body.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active.isConnected) {
        return;
      }
      for (const candidate of candidates) {
        if (!candidate.isConnected) {
          continue;
        }
        candidate.focus();
        if (document.activeElement === candidate) {
          return;
        }
      }
    },
  };
}
