import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface PopoverErrorState {
  id: string;
  error: string;
  position: { top: number; left: number };
}

export interface UsePopoverErrorResult {
  error: PopoverErrorState | null;
  showError: (id: string, error: string, anchor?: { top: number; left: number }) => void;
  clearError: () => void;
}

/**
 * Hook for managing popover error state with auto-dismiss and click-outside behavior.
 * @param autoDismissMs - Time in ms before auto-dismissing (default: 5000). `null` keeps the
 *   popover until its dismiss button: for text the user must be able to reread or copy after
 *   the row it came from is gone, such as what a forced removal left behind (#5143).
 */
export function usePopoverError(autoDismissMs: number | null = 5000): UsePopoverErrorResult {
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
      if (autoDismissMs === null) return;

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
    if (!error || autoDismissMs === null) return;

    const handleClickOutside = () => clearError();

    // Delay to avoid immediate dismissal from the triggering click
    const timeoutId = window.setTimeout(() => {
      document.addEventListener("click", handleClickOutside, { once: true });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("click", handleClickOutside);
    };
  }, [error, clearError, autoDismissMs]);

  return useMemo(() => ({ error, showError, clearError }), [error, showError, clearError]);
}
