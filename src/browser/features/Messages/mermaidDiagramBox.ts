import assert from "@/common/utils/assert";

/**
 * What one Pele render produced. The sanitized markup and the size Pele measured for it always
 * travel together, so the box a diagram is drawn in never comes from a different layout than the
 * markup inside it.
 */
export interface RenderedDiagram {
  svg: string;
  /** Pele's measured size in CSS px: the size the drawing has at scale 1. */
  width: number;
  height: number;
  chart: string;
}

/** Where the diagram is drawn. An inline container width of 0 means unknown (not laid out yet). */
export type DiagramFrame =
  | { kind: "inline"; containerWidth: number; zoom: number }
  | { kind: "dialog"; viewportHeight: number };

export interface DiagramBox {
  width: number;
  height: number;
}

// Below this container width Pele may turn wide layouts vertical, so the diagram also drops
// the height cap that would shrink a tall layout until its labels are unreadable.
export const NARROW_DIAGRAM_WIDTH = 640;
const INLINE_MAX_HEIGHT = 300;
const DIALOG_HEIGHT_FRACTION = 0.8;

function diagramScale(measured: DiagramBox, frame: DiagramFrame): number {
  if (frame.kind === "dialog") {
    return Math.min(1, (frame.viewportHeight * DIALOG_HEIGHT_FRACTION) / measured.height);
  }
  const { containerWidth, zoom } = frame;
  // A wide diagram keeps its measured width here and pans inside its frame.
  if (containerWidth > 0 && containerWidth < NARROW_DIAGRAM_WIDTH) return zoom;
  const fitsWidth = containerWidth > 0 ? containerWidth / measured.width : 1;
  return Math.min(1, INLINE_MAX_HEIGHT / measured.height, fitsWidth) * zoom;
}

/**
 * The whole pixel size of a diagram's <svg>, from the size Pele measured. Engines disagree on how
 * to size a replaced element from its intrinsic dimensions, min-content and max-height, and on
 * what CSS zoom does to layout (iPhone Safari painted a diagram far outside its frame), so
 * nothing but this number decides the box. Mermaid.tsx hands it to the stylesheet as
 * --diagram-width and --diagram-height.
 */
export function diagramPixelSize(measured: DiagramBox, frame: DiagramFrame): DiagramBox {
  assert(
    Number.isFinite(measured.width) &&
      measured.width > 0 &&
      Number.isFinite(measured.height) &&
      measured.height > 0,
    "A diagram needs a finite, positive measured size"
  );
  const scale = diagramScale(measured, frame);
  return {
    width: Math.round(measured.width * scale),
    height: Math.round(measured.height * scale),
  };
}
