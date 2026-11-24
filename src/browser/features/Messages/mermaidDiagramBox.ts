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

/**
 * Where the diagram is drawn. An inline container width of 0 means unknown (not laid out yet).
 * The dialog's room is the measured content box of the element that holds the drawing: a side
 * of 0 is unknown, so that axis does not limit the drawing.
 */
export type DiagramFrame =
  | { kind: "inline"; containerWidth: number; userZoom: number }
  | { kind: "dialog"; room: DiagramBox };

export interface DiagramBox {
  width: number;
  height: number;
}

// Below this container width Pele may turn wide layouts vertical, so the diagram also drops
// the height cap that would shrink a tall layout until its labels are unreadable.
export const NARROW_DIAGRAM_WIDTH = 640;
const INLINE_MAX_HEIGHT = 300;

function assertFinitePositive(box: DiagramBox, message: string) {
  assert(
    Number.isFinite(box.width) && box.width > 0 && Number.isFinite(box.height) && box.height > 0,
    message
  );
}

function diagramScale(measured: DiagramBox, frame: DiagramFrame): number {
  if (frame.kind === "dialog") {
    const { room } = frame;
    assert(
      Number.isFinite(room.width) &&
        room.width >= 0 &&
        Number.isFinite(room.height) &&
        room.height >= 0,
      "The expand dialog needs a finite, non-negative room"
    );
    // The dialog is the one place that shows a whole diagram, so it fits both axes. It never
    // enlarges a small diagram, and an axis that is not measured yet does not limit it.
    return Math.min(
      1,
      room.width > 0 ? room.width / measured.width : 1,
      room.height > 0 ? room.height / measured.height : 1
    );
  }
  const { containerWidth, userZoom } = frame;
  // A wide diagram keeps its measured width here and pans inside its frame.
  if (containerWidth > 0 && containerWidth < NARROW_DIAGRAM_WIDTH) return userZoom;
  // mutation-equivalent: a width in (0, 1] is narrow and returned above, so here it is 0 or 640+
  const fitsWidth = containerWidth > 0 ? containerWidth / measured.width : 1;
  return Math.min(1, INLINE_MAX_HEIGHT / measured.height, fitsWidth) * userZoom;
}

/**
 * The whole pixel size of a diagram's <svg>, from the size Pele measured. Engines disagree on how
 * to size a replaced element from its intrinsic dimensions, min-content and max-height, and on
 * what CSS zoom does to layout (iPhone Safari painted a diagram far outside its frame), so
 * nothing but this number decides the box. Mermaid.tsx hands it to the stylesheet as
 * --diagram-width and --diagram-height.
 */
export function diagramPixelSize(measured: DiagramBox, frame: DiagramFrame): DiagramBox {
  assertFinitePositive(measured, "A diagram needs a finite, positive measured size");
  const scale = diagramScale(measured, frame);
  // A very wide, short diagram scaled to a narrow room would round to nothing and vanish.
  const pixels = (side: number) => Math.max(1, Math.round(side * scale));
  return { width: pixels(measured.width), height: pixels(measured.height) };
}
