import { useEffect, useRef } from "react";

/**
 * Focuses the Review panel when focusTrigger changes (preserves current hunk selection). During
 * workspace setup only the placeholder renders, so the request waits for the real panel (#7449).
 * The pending request holds the trigger value it came with. A new value replaces it, and 0 (the
 * request went to another Review tab) clears it. Any focus move while it waits (the user clicks
 * the chat input) also clears it.
 */
export function useReviewFocusRequest(
  panelRef: React.RefObject<HTMLElement | null>,
  focusTrigger: number | undefined,
  isCreating: boolean
): void {
  const pendingTriggerRef = useRef<number | null>(null);
  useEffect(() => {
    pendingTriggerRef.current = null;
    if (!focusTrigger) return;
    if (!isCreating) {
      panelRef.current?.focus();
      return;
    }
    pendingTriggerRef.current = focusTrigger;
    const cancel = () => (pendingTriggerRef.current = null);
    document.addEventListener("focusin", cancel, { once: true });
    return () => document.removeEventListener("focusin", cancel);
    // isCreating is read, not a trigger: the effect below handles the end of setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelRef, focusTrigger]);
  useEffect(() => {
    if (isCreating || pendingTriggerRef.current !== focusTrigger) return;
    pendingTriggerRef.current = null;
    panelRef.current?.focus();
    // focusTrigger is read, not a trigger: the effect above handles a new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelRef, isCreating]);
}
