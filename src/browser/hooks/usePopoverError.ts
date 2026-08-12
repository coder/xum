import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface PopoverErrorAnchor {
  top: number;
  left: number;
}

export interface PopoverErrorState {
  id: string;
  error: string;
  position: PopoverErrorAnchor;
}

export interface UsePopoverErrorResult {
  error: PopoverErrorState | null;
  showError: (id: string, error: string, anchor?: PopoverErrorAnchor) => void;
  clearError: () => void;
}

/** Gutter between the triggering control's right edge and the error popover. */
const POPOVER_ERROR_ANCHOR_GAP_PX = 10;

/**
 * Places an error popover just outside the right edge of the control that triggered it.
 * Every trigger has to apply the same two conversions — getBoundingClientRect is
 * viewport-relative while the popover is positioned in document space, hence the scrollY
 * offset — so keep them here rather than re-deriving the arithmetic at each call site.
 * A missing element yields `undefined`, which lets showError fall back to its default
 * corner placement (callers whose trigger unmounts on click pass it through the same way).
 */
export function resolvePopoverErrorAnchor(
  element: HTMLElement | null | undefined
): PopoverErrorAnchor | undefined {
  if (element == null) {
    return undefined;
  }
  const rect = element.getBoundingClientRect();
  return { top: rect.top + window.scrollY, left: rect.right + POPOVER_ERROR_ANCHOR_GAP_PX };
}

/**
 * Hook for managing popover error state with auto-dismiss and click-outside behavior.
 * @param autoDismissMs - Time in ms before auto-dismissing (default: 5000)
 */
export function usePopoverError(autoDismissMs = 5000): UsePopoverErrorResult {
  const [error, setError] = useState<PopoverErrorState | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearError = useCallback(() => {
    setError(null);
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const showError = useCallback(
    (id: string, errorMsg: string, anchor?: { top: number; left: number }) => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }

      const position = anchor ?? {
        top: window.scrollY + 32,
        left: Math.max(window.innerWidth - 420, 16),
      };

      setError({ id, error: errorMsg, position });

      timeoutRef.current = window.setTimeout(() => {
        setError(null);
        timeoutRef.current = null;
      }, autoDismissMs);
    },
    [autoDismissMs]
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Click-outside to dismiss
  useEffect(() => {
    if (!error) return;

    const handleClickOutside = () => clearError();

    // Delay to avoid immediate dismissal from the triggering click
    const timeoutId = window.setTimeout(() => {
      document.addEventListener("click", handleClickOutside, { once: true });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("click", handleClickOutside);
    };
  }, [error, clearError]);

  return useMemo(() => ({ error, showError, clearError }), [error, showError, clearError]);
}
