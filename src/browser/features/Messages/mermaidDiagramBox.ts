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
  | { kind: "inline"; containerWidth: number; userZoom: number }
  | { kind: "dialog"; viewport: DiagramBox };

export interface DiagramBox {
  width: number;
  height: number;
}

// Below this container width Pele may turn wide layouts vertical, so the diagram also drops
// the height cap that would shrink a tall layout until its labels are unreadable.
export const NARROW_DIAGRAM_WIDTH = 640;
const INLINE_MAX_HEIGHT = 300;

// The expand dialog is at most DIALOG_MAX_PERCENT of an overlay that pads the viewport by
// DIALOG_OVERLAY_PADDING, and its drawing sits inside DIALOG_PADDING. Mermaid.tsx styles the
// dialog with these same numbers, so the room computed here is the room the dialog has.
export const DIALOG_OVERLAY_PADDING = 40;
export const DIALOG_MAX_PERCENT = 90;
export const DIALOG_PADDING = 24;

function assertFinitePositive(box: DiagramBox, message: string) {
  assert(
    Number.isFinite(box.width) && box.width > 0 && Number.isFinite(box.height) && box.height > 0,
    message
  );
}

/** The largest box the expand dialog can have in a viewport, in whole pixels (at least 1). */
export function dialogMaxBox(viewport: DiagramBox): DiagramBox {
  assertFinitePositive(viewport, "The expand dialog needs a finite, positive viewport");
  const max = (side: number) =>
    Math.max(1, Math.floor(((side - 2 * DIALOG_OVERLAY_PADDING) * DIALOG_MAX_PERCENT) / 100));
  return { width: max(viewport.width), height: max(viewport.height) };
}

/** The room the expand dialog leaves for a drawing, in whole pixels (at least 1). */
export function dialogDiagramRoom(viewport: DiagramBox): DiagramBox {
  const max = dialogMaxBox(viewport);
  return {
    width: Math.max(1, max.width - 2 * DIALOG_PADDING),
    height: Math.max(1, max.height - 2 * DIALOG_PADDING),
  };
}

function diagramScale(measured: DiagramBox, frame: DiagramFrame): number {
  if (frame.kind === "dialog") {
    const room = dialogDiagramRoom(frame.viewport);
    // The dialog is the one place that shows a whole diagram, so it fits both axes.
    return Math.min(1, room.width / measured.width, room.height / measured.height);
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
  return {
    width: Math.round(measured.width * scale),
    height: Math.round(measured.height * scale),
  };
}
