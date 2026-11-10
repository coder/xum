// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.
import { LAYOUT_AUDIT_THRESHOLDS as THRESHOLDS } from "@/common/constants/artifactLayoutAudit";
import type {
  LayoutAuditAxis,
  LayoutAuditPageFinding,
} from "@/common/types/artifactLayoutAudit";
import type { Box } from "./layoutPage";

/** A rectangle or boundary where only the edges of the axes in play need to be present. */
type Edges = Partial<Box>;

type Side = "start" | "end";

interface AxisOverflow {
  overflowPx: number;
  outsideRatio: number;
  centerOutside: boolean;
  side: Side;
}

// One table instead of upstream's two copies of the per-axis arithmetic.
const AXIS_EDGES: Record<
  LayoutAuditAxis,
  { start: "left" | "top"; end: "right" | "bottom"; size: "width" | "height" }
> = {
  horizontal: { start: "left", end: "right", size: "width" },
  vertical: { start: "top", end: "bottom", size: "height" },
};

/**
 * How far `rect` sticks out of `boundary` along one axis. Null when an edge is missing or not
 * finite, or the rect has no size: nothing can be judged then. Upstream computes this twice,
 * in overflowOf (text) and in classifyMaterialRectEscape (controls).
 */
function axisOverflow(rect: Edges, boundary: Edges, axis: LayoutAuditAxis): AxisOverflow | null {
  const edges = AXIS_EDGES[axis];
  const start = Number(rect[edges.start]);
  const end = Number(rect[edges.end]);
  const boundaryStart = Number(boundary[edges.start]);
  const boundaryEnd = Number(boundary[edges.end]);
  const explicitSize = Number(rect[edges.size]);
  const size = Number.isFinite(explicitSize) ? Math.max(0, explicitSize) : Math.max(0, end - start);
  if (![start, end, boundaryStart, boundaryEnd, size].every(Number.isFinite) || size <= 0) {
    return null;
  }
  const before = Math.max(0, boundaryStart - start);
  const after = Math.max(0, end - boundaryEnd);
  const center = start + size / 2;
  return {
    overflowPx: Math.max(before, after),
    outsideRatio: Math.min(1, (before + after) / size),
    centerOutside: center < boundaryStart || center > boundaryEnd,
    side: before >= after ? "start" : "end",
  };
}

/** The candidate with the larger overflowPx. A tie keeps `current` (upstream's strict `>`). */
export function strongest<T extends { overflowPx: number }>(
  current: T | null,
  candidate: T | null,
): T | null {
  if (candidate === null) return current;
  return current === null || candidate.overflowPx > current.overflowPx ? candidate : current;
}

const isClipping = (overflow: string) => overflow === "hidden" || overflow === "clip";

export interface TextOverflow {
  axis: LayoutAuditAxis;
  overflowPx: number;
}

export interface TextOverflowInput {
  /** Rendered line rectangles of the element's text. */
  fragments: readonly Box[];
  /** The box that clips or frames the text (a padding box). */
  box: Edges;
  overflowX: string;
  overflowY: string;
  /** Ellipsis or line-clamp: the author asked for the cut. */
  isTruncated: boolean;
}

// A severe text failure needs rendered-fragment proof. Scroll dimensions include harmless font
// ink, masks, transforms and offscreen carousel content, so they are never sufficient.
function severeHorizontal(fragment: Box, input: TextOverflowInput): TextOverflow | null {
  const horizontal = axisOverflow(fragment, input.box, "horizontal");
  if (horizontal === null || !isClipping(input.overflowX)) return null;
  const severe =
    horizontal.overflowPx > THRESHOLDS.textEpsilonPx &&
    (horizontal.centerOutside || horizontal.outsideRatio >= THRESHOLDS.minOutsideRatio);
  return severe ? { axis: "horizontal", overflowPx: horizontal.overflowPx } : null;
}

// Downward loss counts only when the line's center leaves the box. A box that clips or lets text
// spill (overflow visible) is judged; a scroller is not.
function severeVertical(fragment: Box, input: TextOverflowInput): TextOverflow | null {
  const vertical = axisOverflow(fragment, input.box, "vertical");
  if (vertical === null) return null;
  if (!isClipping(input.overflowY) && input.overflowY !== "visible") return null;
  const severe = vertical.overflowPx > THRESHOLDS.textEpsilonPx && vertical.centerOutside;
  return severe ? { axis: "vertical", overflowPx: vertical.overflowPx } : null;
}

/**
 * Upstream classifySevereTextOverflow, without its `isVisuallyHidden` input (no call site ever
 * set it: hidden text is excluded before the classifier runs) and its tunable ratio and epsilon
 * (every call site used the defaults, which now live in LAYOUT_AUDIT_THRESHOLDS).
 */
export function classifySevereTextOverflow(input: TextOverflowInput): TextOverflow | null {
  if (input.isTruncated) return null;
  let best: TextOverflow | null = null;
  for (const fragment of input.fragments) {
    best = strongest(best, severeHorizontal(fragment, input));
    best = strongest(best, severeVertical(fragment, input));
  }
  return best;
}

export interface RectEscape {
  axis: LayoutAuditAxis;
  side: Side;
  overflowPx: number;
}

export function classifyMaterialRectEscape(input: {
  rect: Edges;
  boundary: Edges;
  axes?: readonly LayoutAuditAxis[];
  minOutsidePx?: number;
}): RectEscape | null {
  const { rect, boundary, axes = ["horizontal", "vertical"], minOutsidePx = THRESHOLDS.controlMinOutsidePx } = input;
  let best: RectEscape | null = null;
  for (const axis of axes) {
    const outside = axisOverflow(rect, boundary, axis);
    const material =
      outside !== null &&
      outside.overflowPx >= minOutsidePx &&
      (outside.centerOutside || outside.outsideRatio >= THRESHOLDS.minOutsideRatio);
    if (material) best = strongest(best, { axis, side: outside.side, overflowPx: outside.overflowPx });
  }
  return best;
}

/** The overflow that counts as material for text: max(24 px, 5% of the viewport). */
export function materialViewportPx(viewportWidth: number): number {
  return Math.max(
    THRESHOLDS.pageOverflowMinPx,
    viewportWidth * THRESHOLDS.pageOverflowMinViewportRatio,
  );
}

// Tiny document deltas are cosmetic. A page failure is reportable only when meaningful content
// materially escapes the usable viewport; the caller proves that from actual element bounds.
export function isMaterialPageOverflow(input: {
  overflowPx: number;
  viewportWidth: number;
  hasEscapedContent: boolean;
}): boolean {
  return (
    input.hasEscapedContent &&
    Number.isFinite(input.overflowPx) &&
    input.overflowPx >= materialViewportPx(input.viewportWidth)
  );
}

/** A finding's identity within one pass: its rule, element and axis (never its size). */
export function findingKey(finding: LayoutAuditPageFinding): string {
  return `${finding.rule}:${finding.selector}:${finding.axis}`;
}

/** Findings of `second` that `first` also holds: a real defect is in both samples. */
export function findStableLayoutFindings(
  first: readonly LayoutAuditPageFinding[],
  second: readonly LayoutAuditPageFinding[],
): LayoutAuditPageFinding[] {
  const firstKeys = new Set(first.map(findingKey));
  return second.filter((finding) => firstKeys.has(findingKey(finding)));
}

export function isNearTotalOcclusion(input: {
  occludedSamples: number;
  totalSamples: number;
}): boolean {
  return (
    input.totalSamples >= THRESHOLDS.occlusionMinSamples &&
    input.occludedSamples / input.totalSamples >= THRESHOLDS.occlusionMinRatio
  );
}
