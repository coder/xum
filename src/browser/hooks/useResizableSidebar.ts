/**
 * useResizableSidebar - Custom hook for drag-based sidebar resizing
 *
 * Provides encapsulated resize logic without wrapping DOM elements, preserving
 * existing scroll container hierarchy. Uses global mouse listeners during drag
 * to track cursor position regardless of where the mouse moves.
 *
 * Design principles:
 * - No interference with scroll containers or flex layout
 * - Persistent width via localStorage
 * - Smooth dragging with visual feedback (cursor changes)
 * - Boundary enforcement (min/max constraints)
 * - Clean mount/unmount of event listeners
 *
 * @example
 * const { width, startResize } = useResizableSidebar({
 *   enabled: isReviewTab,
 *   defaultWidth: 600,
 *   minWidth: 300,
 *   maxWidth: 1200,
 *   storageKey: 'review-sidebar-width',
 * });
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { getStorageChangeEvent } from "@/common/constants/events";
import {
  readPersistedRawString,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";

export type ResizableSidebarSide = "left" | "right";

interface UseResizableSidebarOptions {
  /** Enable/disable resize functionality (typically tied to tab state) */
  enabled: boolean;
  /** Initial width when no stored value exists */
  defaultWidth: number;
  /** Minimum allowed width (enforced during drag) */
  minWidth: number;
  /** Maximum allowed width (enforced during drag) */
  maxWidth: number;
  /** Optional dynamic max width resolver (e.g., based on viewport size) */
  getMaxWidthPx?: () => number;
  /** localStorage key for persisting width across sessions */
  storageKey: string;
  /** Which side of the viewport the sidebar is on. Impacts drag direction. */
  side?: ResizableSidebarSide;
  /**
   * Opt in to drag-to-collapse. Dragging the handle far past the minimum width snaps the
   * sidebar closed, and dragging back out within the same gesture reopens it. Called only when
   * the snapped state flips during a drag, so callers can persist it directly.
   */
  onDragCollapseChange?: (collapsed: boolean) => void;
}

interface UseResizableSidebarResult {
  /** Current sidebar width in pixels */
  width: number;
  /** Whether user is actively dragging the resize handle */
  isResizing: boolean;
  /** Function to call on handle mouseDown to initiate resize */
  startResize: (e: React.MouseEvent) => void;
  /** Placeholder for type compatibility (not used in render) */
  ResizeHandle: React.FC;
}

export function resolveInitialResizableSidebarWidth(args: {
  storedValue: string | null;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}): number {
  const effectiveMaxWidth = Math.max(args.minWidth, args.maxWidth);
  const fallbackWidth = Math.max(args.minWidth, Math.min(effectiveMaxWidth, args.defaultWidth));

  if (!args.storedValue) {
    return fallbackWidth;
  }

  const parsedWidth = Number.parseInt(args.storedValue, 10);
  if (!Number.isFinite(parsedWidth)) {
    return fallbackWidth;
  }

  return Math.max(args.minWidth, Math.min(effectiveMaxWidth, parsedWidth));
}

/**
 * A drag snaps the sidebar closed once the pointer would make it narrower than this fraction of
 * `minWidth` (VS Code's sash snap rule). Between this point and `minWidth` the sidebar holds at
 * its minimum, which gives the drag a short "detent" before it collapses.
 */
const DRAG_COLLAPSE_SNAP_RATIO = 0.5;

type ResizeDragResult = { collapsed: true } | { collapsed: false; width: number };

/** Maps the unclamped width a drag asks for to a clamped width or a snapped-closed sidebar. */
function resolveResizeDrag(args: {
  rawWidth: number;
  minWidth: number;
  maxWidth: number;
  collapsible: boolean;
}): ResizeDragResult {
  if (args.collapsible && args.rawWidth < args.minWidth * DRAG_COLLAPSE_SNAP_RATIO) {
    return { collapsed: true };
  }
  return {
    collapsed: false,
    width: Math.max(args.minWidth, Math.min(args.maxWidth, args.rawWidth)),
  };
}

export function useResizableSidebar({
  enabled,
  defaultWidth,
  minWidth,
  maxWidth,
  getMaxWidthPx,
  storageKey,
  side = "right",
  onDragCollapseChange,
}: UseResizableSidebarOptions): UseResizableSidebarResult {
  // Load persisted width from localStorage on mount
  // Always load persisted value regardless of enabled flag to maintain size across workspace switches
  const [width, setWidth] = useState<number>(() => {
    const resolvedMaxWidth = (() => {
      if (typeof getMaxWidthPx === "function") {
        const candidate = getMaxWidthPx();
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
          return Math.min(maxWidth, candidate);
        }
      }
      return maxWidth;
    })();

    try {
      return resolveInitialResizableSidebarWidth({
        storedValue: readPersistedRawString(storageKey),
        defaultWidth,
        minWidth,
        maxWidth: resolvedMaxWidth,
      });
    } catch {
      // Ignore storage errors (private browsing, quota exceeded, etc.)
      return resolveInitialResizableSidebarWidth({
        storedValue: null,
        defaultWidth,
        minWidth,
        maxWidth: resolvedMaxWidth,
      });
    }
  });

  const [isResizing, setIsResizing] = useState(false);

  // Refs to track drag state without causing re-renders
  const startXRef = useRef<number>(0); // Mouse X position when drag started
  const startWidthRef = useRef<number>(0); // Sidebar width when drag started
  // Whether the current drag has snapped the sidebar closed; reset on every drag start.
  const dragCollapsedRef = useRef(false);

  const getMaxWidthPxRef = useRef(getMaxWidthPx);
  useEffect(() => {
    getMaxWidthPxRef.current = getMaxWidthPx;
  }, [getMaxWidthPx]);

  const onDragCollapseChangeRef = useRef(onDragCollapseChange);
  useEffect(() => {
    onDragCollapseChangeRef.current = onDragCollapseChange;
  }, [onDragCollapseChange]);

  const resolveMaxWidthPx = useCallback(() => {
    const candidate = getMaxWidthPxRef.current?.();
    const resolved =
      typeof candidate === "number" && Number.isFinite(candidate)
        ? Math.min(maxWidth, candidate)
        : maxWidth;
    return Math.max(minWidth, resolved);
  }, [maxWidth, minWidth]);

  // Persist width changes to localStorage
  useEffect(() => {
    if (!enabled) return;
    updatePersistedState<number>(storageKey, width);
  }, [width, storageKey, enabled]);

  // Keep width in sync when updated externally (e.g., layout presets)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleExternalUpdate = () => {
      if (isResizing) {
        return;
      }

      const stored = readPersistedString(storageKey);
      if (!stored) {
        return;
      }

      const parsed = parseInt(stored, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }

      const maxWidthPx = resolveMaxWidthPx();
      const clamped = Math.max(minWidth, Math.min(maxWidthPx, parsed));
      setWidth((prev) => (prev === clamped ? prev : clamped));
    };

    const eventName = getStorageChangeEvent(storageKey);
    window.addEventListener(eventName, handleExternalUpdate as EventListener);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === storageKey) {
        handleExternalUpdate();
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(eventName, handleExternalUpdate as EventListener);
      window.removeEventListener("storage", handleStorage);
    };
  }, [storageKey, minWidth, maxWidth, isResizing, resolveMaxWidthPx]);

  // Keep current width within bounds when the viewport or container-derived max changes.
  // Use a layout effect so first-paint width corrections happen before the sidebar becomes visible.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    if (isResizing) return;

    const handleResize = () => {
      const maxWidthPx = resolveMaxWidthPx();
      setWidth((prev) => {
        const clamped = Math.max(minWidth, Math.min(maxWidthPx, prev));
        return prev === clamped ? prev : clamped;
      });
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [isResizing, minWidth, resolveMaxWidthPx]);

  /**
   * Handle mouse movement during drag.
   * Calculates new width based on horizontal mouse delta from start position.
   *
   * Width grows as mouse moves:
   * - left for right-side sidebars
   * - right for left-side sidebars
   */
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      const deltaX =
        side === "right" ? startXRef.current - e.clientX : e.clientX - startXRef.current;

      const result = resolveResizeDrag({
        rawWidth: startWidthRef.current + deltaX,
        minWidth,
        maxWidth: resolveMaxWidthPx(),
        collapsible: onDragCollapseChangeRef.current != null,
      });

      if (result.collapsed !== dragCollapsedRef.current) {
        dragCollapsedRef.current = result.collapsed;
        onDragCollapseChangeRef.current?.(result.collapsed);
      }

      // While snapped closed, keep the pre-drag width so reopening the sidebar later restores
      // the size the user had, not the clamped minimum the drag passed through.
      setWidth(result.collapsed ? startWidthRef.current : result.width);
    },
    [isResizing, minWidth, side, resolveMaxWidthPx]
  );

  /**
   * Handle mouse up to end drag session
   * Width is already persisted via useEffect, just need to clear drag state
   */
  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  /**
   * Attach/detach global mouse listeners during drag
   * Using document-level listeners ensures we track mouse even if it leaves
   * the resize handle area during drag (critical for smooth UX)
   */
  useEffect(() => {
    if (!isResizing) return;

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    // Prevent text selection and show resize cursor globally during drag
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  /**
   * Initiate drag session
   * Called by resize handle's onMouseDown event
   * Records starting position and width for delta calculations
   */
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      dragCollapsedRef.current = false;
    },
    [enabled, width]
  );

  // Dummy component for type compatibility (not rendered, actual handle is in AIView)
  const ResizeHandle: React.FC = () => null;

  return {
    width: enabled ? width : defaultWidth,
    isResizing,
    startResize,
    ResizeHandle,
  };
}
