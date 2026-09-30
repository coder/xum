import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { clamp } from "@/common/utils/clamp";
import {
  getThumbMetrics,
  parseDiffLines,
  pointerYToLineIndex,
  scrollTopForLine,
} from "./immersiveMinimapMath";

interface ImmersiveMinimapProps {
  content: string;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  activeLineIndex: number | null;
  onSelectLineIndex: (lineIndex: number) => void;
  /** Diff line indices where review comments exist (drawn as yellow indicators) */
  commentLineIndices: ReadonlySet<number>;
  /** Bump after parent-owned scroll positioning so the canvas reads fresh scrollTop before reveal. */
  redrawNonce?: number;
}

const DEFAULT_ADD_COLOR = "rgba(34, 197, 94, 0.85)";
const DEFAULT_REMOVE_COLOR = "rgba(239, 68, 68, 0.85)";
const DEFAULT_ACTIVE_LINE_COLOR = "rgba(255, 255, 255, 0.9)";
const DEFAULT_COMMENT_COLOR = "rgba(234, 179, 8, 0.85)";
const THUMB_FILL_COLOR = "rgba(255, 255, 255, 0.15)";
const THUMB_BORDER_COLOR = "rgba(255, 255, 255, 0.3)";

const readThemeColor = (cssVariableName: string, fallback: string): string => {
  const rootStyles = getComputedStyle(document.documentElement);
  const resolvedColor = rootStyles.getPropertyValue(cssVariableName).trim();
  return resolvedColor.length > 0 ? resolvedColor : fallback;
};

export const ImmersiveMinimap: React.FC<ImmersiveMinimapProps> = (props) => {
  // Computed synchronously during render — React Compiler memoizes based on
  // props.content. Avoids the useState+useEffect flash where the component
  // briefly renders null before the parsed data arrives.
  const lineCategories = parseDiffLines(props.content);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const stopThumbDrag = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    document.body.classList.remove("cursor-grabbing");
  }, []);

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || lineCategories.length === 0) {
      return;
    }

    const trackWidth = canvas.clientWidth;
    const trackHeight = canvas.clientHeight;
    if (trackWidth <= 0 || trackHeight <= 0) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const deviceWidth = Math.max(1, Math.floor(trackWidth * dpr));
    const deviceHeight = Math.max(1, Math.floor(trackHeight * dpr));

    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const addColor = readThemeColor("--color-success", DEFAULT_ADD_COLOR);
    const removeColor = readThemeColor("--color-danger", DEFAULT_REMOVE_COLOR);
    const activeLineColor = readThemeColor("--color-review-accent", DEFAULT_ACTIVE_LINE_COLOR);

    const totalLines = lineCategories.length;
    const lineHeight = trackHeight / totalLines;

    for (let lineIndex = 0; lineIndex < totalLines; lineIndex += 1) {
      const category = lineCategories[lineIndex];
      if (category === "context") {
        continue;
      }

      context.fillStyle = category === "add" ? addColor : removeColor;
      context.fillRect(0, lineIndex * lineHeight, trackWidth, Math.max(1, Math.ceil(lineHeight)));
    }

    // Draw yellow indicators for lines with review comments
    if (props.commentLineIndices.size > 0) {
      const commentColor = readThemeColor("--color-warning", DEFAULT_COMMENT_COLOR);
      context.fillStyle = commentColor;
      for (const commentIdx of props.commentLineIndices) {
        if (commentIdx >= 0 && commentIdx < totalLines) {
          const y = commentIdx * lineHeight;
          context.fillRect(0, y, trackWidth, Math.max(2, Math.ceil(lineHeight)));
        }
      }
    }

    const scrollContainer = props.scrollContainerRef.current;
    if (scrollContainer) {
      const { thumbTop, thumbHeight } = getThumbMetrics(
        scrollContainer.scrollTop,
        scrollContainer.scrollHeight,
        scrollContainer.clientHeight,
        trackHeight
      );

      context.fillStyle = THUMB_FILL_COLOR;
      context.fillRect(0, thumbTop, trackWidth, thumbHeight);
      context.strokeStyle = THUMB_BORDER_COLOR;
      context.lineWidth = 1;
      context.strokeRect(
        0.5,
        thumbTop + 0.5,
        Math.max(0, trackWidth - 1),
        Math.max(0, thumbHeight - 1)
      );
    }

    if (props.activeLineIndex !== null) {
      const clampedActiveLine = clamp(props.activeLineIndex, 0, totalLines - 1);
      const activeY = (clampedActiveLine / Math.max(totalLines - 1, 1)) * trackHeight;

      context.fillStyle = activeLineColor;
      context.fillRect(0, Math.max(0, activeY - 1), trackWidth, 2);
    }
  }, [lineCategories, props.activeLineIndex, props.commentLineIndices, props.scrollContainerRef]);

  useLayoutEffect(() => {
    // Canvas pixels are visible layout state; redraw before paint so hydration
    // swaps do not show one frame of the previous minimap/scroll thumb.
    redrawCanvas();
  }, [redrawCanvas, props.redrawNonce]);

  useEffect(() => {
    const scrollContainer = props.scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const handleScroll = () => {
      redrawCanvas();
    };

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [props.scrollContainerRef, redrawCanvas]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const scrollContainer = props.scrollContainerRef.current;
    const canvas = canvasRef.current;
    if (!scrollContainer || !canvas) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      redrawCanvas();
    });
    resizeObserver.observe(scrollContainer);
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
    };
  }, [props.scrollContainerRef, redrawCanvas]);

  useEffect(() => {
    return () => {
      stopThumbDrag();
    };
  }, [stopThumbDrag]);

  const onSelectLineIndex = props.onSelectLineIndex;
  const scrollContainerRef = props.scrollContainerRef;

  const handleCanvasMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || lineCategories.length === 0) {
        return;
      }

      const scrollContainer = scrollContainerRef.current;
      const bounds = canvas.getBoundingClientRect();
      const pointerY = event.clientY - bounds.top;

      if (scrollContainer) {
        const thumbMetrics = getThumbMetrics(
          scrollContainer.scrollTop,
          scrollContainer.scrollHeight,
          scrollContainer.clientHeight,
          bounds.height
        );

        const isPressingThumb =
          thumbMetrics.maxThumbTop > 0 &&
          pointerY >= thumbMetrics.thumbTop &&
          pointerY <= thumbMetrics.thumbTop + thumbMetrics.thumbHeight;

        if (isPressingThumb) {
          event.preventDefault();
          stopThumbDrag();

          const pointerOffset = pointerY - thumbMetrics.thumbTop;

          const handleMouseMove = (moveEvent: MouseEvent) => {
            const latestCanvas = canvasRef.current;
            const latestScrollContainer = scrollContainerRef.current;
            if (!latestCanvas || !latestScrollContainer) {
              return;
            }

            const latestBounds = latestCanvas.getBoundingClientRect();
            const nextPointerY = moveEvent.clientY - latestBounds.top;
            const nextMetrics = getThumbMetrics(
              latestScrollContainer.scrollTop,
              latestScrollContainer.scrollHeight,
              latestScrollContainer.clientHeight,
              latestBounds.height
            );
            const nextThumbTop = clamp(nextPointerY - pointerOffset, 0, nextMetrics.maxThumbTop);
            const scrollRatio =
              nextMetrics.maxThumbTop > 0 ? nextThumbTop / nextMetrics.maxThumbTop : 0;
            const maxScrollTop = Math.max(
              latestScrollContainer.scrollHeight - latestScrollContainer.clientHeight,
              0
            );

            latestScrollContainer.scrollTop = scrollRatio * maxScrollTop;
            redrawCanvas();
          };

          const handleMouseUp = () => {
            stopThumbDrag();
            redrawCanvas();
          };

          dragCleanupRef.current = () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
          };

          window.addEventListener("mousemove", handleMouseMove);
          window.addEventListener("mouseup", handleMouseUp, { once: true });
          document.body.classList.add("cursor-grabbing");
          return;
        }
      }

      const lineIndex = pointerYToLineIndex(pointerY, bounds.height, lineCategories.length);
      onSelectLineIndex(lineIndex);

      if (scrollContainer) {
        scrollContainer.scrollTop = scrollTopForLine(
          lineIndex,
          lineCategories.length,
          scrollContainer.scrollHeight,
          scrollContainer.clientHeight
        );
      }

      redrawCanvas();
    },
    [lineCategories.length, onSelectLineIndex, scrollContainerRef, redrawCanvas, stopThumbDrag]
  );

  if (lineCategories.length === 0) {
    return null;
  }

  return (
    <div className="h-full w-6 shrink-0 bg-[var(--color-bg-dark)]" data-testid="immersive-minimap">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-pointer"
        onMouseDown={handleCanvasMouseDown}
        data-testid="immersive-minimap-canvas"
      />
    </div>
  );
};
