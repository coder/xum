// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.
import { LAYOUT_AUDIT_THRESHOLDS as THRESHOLDS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import {
  auditedText,
  chainBelowRoot,
  clippingBoundariesFor,
  hasHorizontalScrollerAncestor,
  hasReachableVerticalScrollerAncestor,
  isExcludedElement,
  isIntentionalTruncation,
  isNearAnimation,
  isNestedInTextBoundary,
  isRequiredControl,
  isRootElement,
  isVisible,
  paddingBox,
  rootVerticalScrollLocked,
  selectorFor,
  textFragments,
  type ClippingBoundary,
} from "./elementFacts";
import {
  classifyMaterialRectEscape,
  classifySevereTextOverflow,
  findingKey,
  isMaterialPageOverflow,
  isNearTotalOcclusion,
  materialViewportPx,
  strongest,
} from "./geometry";
import type { Box, LayoutPage, PageMetrics } from "./layoutPage";

/**
 * One measurement pass over a page: six rules, each reporting the outermost element that
 * fails, once. Upstream's `auditLayout` and the helpers it calls, minus Lavish's own-UI
 * exclusions (Xum injects nothing into the audited page). Rule order is upstream's: page
 * overflow, then per element the control checks, then text unreachable on the left, then
 * clipped text, then overlap.
 */

/** What one pass shares between its rule checks. */
interface AuditPass {
  readonly page: LayoutPage;
  readonly metrics: PageMetrics;
  readonly animated: readonly Element[];
  /** Elements already blamed for a clip: anything inside one is not reported again. */
  readonly failedRoots: Element[];
  readonly findings: LayoutAuditPageFinding[];
  readonly seen: Set<string>;
}

interface Point {
  x: number;
  y: number;
}

function roundedOverflowPx(value: number): number {
  return (
    Math.round(Math.max(0, value) * THRESHOLDS.overflowPrecision) / THRESHOLDS.overflowPrecision
  );
}

/** Adds a finding unless its rule, selector and axis were already reported in this pass. */
function report(pass: AuditPass, finding: LayoutAuditPageFinding): void {
  const key = findingKey(finding);
  if (pass.seen.has(key)) return;
  pass.seen.add(key);
  pass.findings.push({ ...finding, overflowPx: roundedOverflowPx(finding.overflowPx) });
}

function isRootFailure(pass: AuditPass, el: Element): boolean {
  return pass.failedRoots.some((root) => root.contains(el));
}

/**
 * Not a diagram, mask or screen-reader-only text, not a span that its paragraph judges, and not
 * near motion. The part of every text and control rule that does not depend on the rule.
 */
function isJudgeable(pass: AuditPass, el: Element): boolean {
  return (
    !isExcludedElement(pass.page, el) &&
    !isNestedInTextBoundary(pass.page, el) &&
    !isNearAnimation(pass.animated, el)
  );
}

function isVisibleText(pass: AuditPass, el: Element): boolean {
  return isJudgeable(pass, el) && auditedText(pass.page, el) !== "" && isVisible(pass.page, el);
}

/** Absolute, fixed or sticky text stays put on purpose; a positioned control is still checked. */
function isPositionedNonControl(pass: AuditPass, el: Element): boolean {
  const position = pass.page.style(el).position;
  const positioned = position === "absolute" || position === "fixed" || position === "sticky";
  return positioned && !isRequiredControl(el);
}

function viewportEscape(pass: AuditPass, rect: Partial<Box>, minOutsidePx: number) {
  const { viewportWidth, viewportHeight } = pass.metrics;
  return classifyMaterialRectEscape({
    rect,
    boundary: { left: 0, right: viewportWidth, top: 0, bottom: viewportHeight },
    axes: ["horizontal"],
    minOutsidePx,
  });
}

// ---- page-horizontal-overflow ----------------------------------------------------------------

function textEscapesRightEdge(pass: AuditPass, el: Element): boolean {
  if (auditedText(pass.page, el) === "") return false;
  const materialPx = materialViewportPx(pass.metrics.viewportWidth);
  return textFragments(pass.page, el).some(
    (fragment) => viewportEscape(pass, fragment, materialPx)?.side === "end"
  );
}

/** Real content, not a scroll dimension, past the right edge: the evidence for page overflow. */
function elementEscapesRightEdge(pass: AuditPass, el: Element): boolean {
  if (hasHorizontalScrollerAncestor(pass.page, el) || !isJudgeable(pass, el)) return false;
  if (!isVisible(pass.page, el) || isPositionedNonControl(pass, el)) return false;
  if (!isRequiredControl(el)) return textEscapesRightEdge(pass, el);
  const rect = pass.page.box(el);
  return viewportEscape(pass, rect, THRESHOLDS.controlMinOutsidePx)?.side === "end";
}

function pageOverflowCheck(pass: AuditPass, elements: readonly Element[]): void {
  const { viewportWidth, scrollWidth } = pass.metrics;
  const overflowPx = scrollWidth - viewportWidth;
  const hasEscapedContent = elements.some((el) => elementEscapesRightEdge(pass, el));
  if (isMaterialPageOverflow({ overflowPx, viewportWidth, hasEscapedContent })) {
    report(pass, {
      rule: "page-horizontal-overflow",
      selector: "html",
      axis: "horizontal",
      overflowPx,
    });
  }
}

// ---- controls: clipped-control and viewport-unreachable-control ------------------------------

interface ControlClip {
  boundary: ClippingBoundary;
  escape: NonNullable<ReturnType<typeof classifyMaterialRectEscape>>;
  overflowPx: number;
}

function strongestControlClip(page: LayoutPage, el: Element, rect: Box): ControlClip | null {
  let clipped: ControlClip | null = null;
  for (const boundary of clippingBoundariesFor(page, el)) {
    const escape = classifyMaterialRectEscape({
      rect,
      boundary: boundary.box,
      axes: boundary.axes,
    });
    clipped = strongest(clipped, escape && { boundary, escape, overflowPx: escape.overflowPx });
  }
  return clipped;
}

function clippedControlCheck(pass: AuditPass, el: Element, rect: Box): void {
  const clipped = strongestControlClip(pass.page, el, rect);
  if (clipped === null || isRootFailure(pass, clipped.boundary.el)) return;
  pass.failedRoots.push(clipped.boundary.el);
  report(pass, {
    rule: "clipped-control",
    selector: selectorFor(pass.page, clipped.boundary.el),
    axis: clipped.escape.axis,
    overflowPx: clipped.escape.overflowPx,
  });
}

function leftEdgeControlCheck(pass: AuditPass, el: Element, rect: Box): void {
  if (hasHorizontalScrollerAncestor(pass.page, el)) return;
  const escape = viewportEscape(pass, rect, THRESHOLDS.controlMinOutsidePx);
  if (escape?.side !== "start") return;
  report(pass, {
    rule: "viewport-unreachable-control",
    selector: selectorFor(pass.page, el),
    axis: "horizontal",
    overflowPx: escape.overflowPx,
  });
}

// A fixed or sticky control, or any control when the root cannot scroll and no scroller on screen
// holds it, must fit the viewport; otherwise it must fit the scrollable page.
function isPinnedToViewport(pass: AuditPass, el: Element): boolean {
  const position = pass.page.style(el).position;
  if (position === "fixed" || position === "sticky") return true;
  const { page, metrics } = pass;
  return (
    rootVerticalScrollLocked(page) &&
    !hasReachableVerticalScrollerAncestor(page, el, metrics.viewportHeight)
  );
}

function verticalControlEscape(pass: AuditPass, el: Element, rect: Box) {
  const { scrollY, viewportHeight, scrollHeight } = pass.metrics;
  if (isPinnedToViewport(pass, el)) {
    return classifyMaterialRectEscape({
      rect,
      boundary: { top: 0, bottom: viewportHeight },
      axes: ["vertical"],
    });
  }
  const pageRect = { top: rect.top + scrollY, bottom: rect.bottom + scrollY, height: rect.height };
  return classifyMaterialRectEscape({
    rect: pageRect,
    boundary: { top: 0, bottom: scrollHeight },
    axes: ["vertical"],
  });
}

function verticalControlCheck(pass: AuditPass, el: Element, rect: Box): void {
  const escape = verticalControlEscape(pass, el, rect);
  if (escape === null) return;
  report(pass, {
    rule: "viewport-unreachable-control",
    selector: selectorFor(pass.page, el),
    axis: "vertical",
    overflowPx: escape.overflowPx,
  });
}

function controlChecks(pass: AuditPass, el: Element): void {
  const { page } = pass;
  if (!isRequiredControl(el) || isExcludedElement(page, el) || isNearAnimation(pass.animated, el)) {
    return;
  }
  if (!isVisible(page, el)) return;
  const rect = page.box(el);
  clippedControlCheck(pass, el, rect);
  leftEdgeControlCheck(pass, el, rect);
  verticalControlCheck(pass, el, rect);
}

// ---- viewport-unreachable-content ------------------------------------------------------------

function leftmostTextEscape(pass: AuditPass, el: Element) {
  const materialPx = materialViewportPx(pass.metrics.viewportWidth);
  let escape: { side: "start" | "end"; overflowPx: number } | null = null;
  for (const fragment of textFragments(pass.page, el)) {
    const candidate = viewportEscape(pass, fragment, materialPx);
    escape = strongest(escape, candidate?.side === "start" ? candidate : null);
  }
  return escape;
}

function leftTextCheck(pass: AuditPass, el: Element): void {
  if (hasHorizontalScrollerAncestor(pass.page, el) || !isVisibleText(pass, el)) return;
  if (isPositionedNonControl(pass, el)) return;
  const escape = leftmostTextEscape(pass, el);
  if (escape === null) return;
  report(pass, {
    rule: "viewport-unreachable-content",
    selector: selectorFor(pass.page, el),
    axis: "horizontal",
    overflowPx: escape.overflowPx,
  });
}

// ---- clipped-text ----------------------------------------------------------------------------

interface TextClip {
  root: Element;
  axis: "horizontal" | "vertical";
  overflowPx: number;
}

const clippedOverflow = (boundary: ClippingBoundary, axis: "horizontal" | "vertical") =>
  boundary.axes.includes(axis) ? "hidden" : "auto";

// The element's own box first, then each clipping ancestor: the strongest failure names the root
// that is reported (an ancestor's clip wins only by overflowing more).
function strongestTextClip(pass: AuditPass, el: Element): TextClip | null {
  const style = pass.page.style(el);
  const fragments = textFragments(pass.page, el);
  const isTruncated = isIntentionalTruncation(style);
  const own = classifySevereTextOverflow({
    fragments,
    box: paddingBox(pass.page, el),
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    isTruncated,
  });
  let clip: TextClip | null = own && { root: el, ...own };
  for (const boundary of clippingBoundariesFor(pass.page, el)) {
    const failure = classifySevereTextOverflow({
      fragments,
      box: boundary.box,
      overflowX: clippedOverflow(boundary, "horizontal"),
      overflowY: clippedOverflow(boundary, "vertical"),
      isTruncated,
    });
    clip = strongest(clip, failure && { root: boundary.el, ...failure });
  }
  return clip;
}

function textClipCheck(pass: AuditPass, el: Element): void {
  if (isRootElement(pass.page, el) || isRootFailure(pass, el) || !isVisibleText(pass, el)) return;
  const clip = strongestTextClip(pass, el);
  if (clip === null) return;
  pass.failedRoots.push(clip.root);
  report(pass, {
    rule: "clipped-text",
    selector: selectorFor(pass.page, clip.root),
    axis: clip.axis,
    overflowPx: clip.overflowPx,
  });
}

// ---- overlapping-text ------------------------------------------------------------------------

// Opaque: opacity and background alpha both at least 0.95. Computed styles are rgb()/rgba().
function isOpaqueColor(color: string): boolean {
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color.trim().toLowerCase());
  if (rgba === null) return false;
  const parts = rgba[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return true;
  const alpha = Number(parts[3]);
  return Number.isFinite(alpha) && alpha >= THRESHOLDS.opaqueMin;
}

function isOpaqueSurface(page: LayoutPage, el: Element): boolean {
  const style = page.style(el);
  if (Number.parseFloat(style.opacity || "1") < THRESHOLDS.opaqueMin) return false;
  return isOpaqueColor(style.backgroundColor || "");
}

// Product of the opacities from `node` up to, not including, `stopParent`.
function effectiveOpacityTo(page: LayoutPage, node: Element, stopParent: Element | null): number {
  let opacity = 1;
  for (
    let current: Element | null = node;
    current && current !== stopParent;
    current = current.parentElement
  ) {
    const value = Number.parseFloat(page.style(current).opacity || "1");
    if (Number.isFinite(value)) opacity *= value;
  }
  return opacity;
}

// Walking up from the element on top, the first node that shares a parent with the text's own
// chain and sits on an opaque surface is the cover (a sibling block, not a descendant).
function findOpaqueSibling(
  pass: AuditPass,
  textChain: readonly Element[],
  top: Element
): Element | null {
  let foundOpaqueSurface = false;
  for (const node of chainBelowRoot(pass.page, top)) {
    if (isNearAnimation(pass.animated, node)) return null;
    foundOpaqueSurface = foundOpaqueSurface || isOpaqueSurface(pass.page, node);
    const sharesParent = textChain.some((target) => target.parentElement === node.parentElement);
    if (
      sharesParent &&
      foundOpaqueSurface &&
      effectiveOpacityTo(pass.page, top, node.parentElement) >= THRESHOLDS.opaqueMin
    ) {
      return node;
    }
  }
  return null;
}

function opaqueSiblingBlocker(pass: AuditPass, el: Element, point: Point): Element | null {
  const top = pass.page.elementAt(point.x, point.y);
  if (!top || top === el || el.contains(top) || top.contains(el)) return null;
  return findOpaqueSibling(pass, chainBelowRoot(pass.page, el), top);
}

function fragmentSamplePoints(fragment: Box): Point[] {
  const positions = THRESHOLDS.samplePositions;
  return positions.flatMap((xRatio) =>
    positions.map((yRatio) => ({
      x: fragment.left + fragment.width * xRatio,
      y: fragment.top + fragment.height * yRatio,
    }))
  );
}

function isInsideViewport(point: Point, metrics: PageMetrics): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= metrics.viewportWidth &&
    point.y <= metrics.viewportHeight
  );
}

function occlusionPoints(pass: AuditPass, el: Element): Point[] {
  return textFragments(pass.page, el)
    .filter((fragment) => fragment.width * fragment.height >= THRESHOLDS.minFragmentArea)
    .flatMap(fragmentSamplePoints)
    .filter((point) => isInsideViewport(point, pass.metrics));
}

// How many sample points one blocker covers, of how many in all.
function sampleOcclusion(pass: AuditPass, el: Element) {
  const points = occlusionPoints(pass, el);
  const coveredBy = new Map<Element, number>();
  for (const point of points) {
    const blocker = opaqueSiblingBlocker(pass, el, point);
    if (blocker) coveredBy.set(blocker, (coveredBy.get(blocker) ?? 0) + 1);
  }
  return { occludedSamples: Math.max(0, ...coveredBy.values()), totalSamples: points.length };
}

// Long enough to read (any length for a control), static (positioned text overlaps on purpose),
// and not shown by a paragraph around it.
function isOcclusionCandidate(pass: AuditPass, el: Element): boolean {
  const text = auditedText(pass.page, el);
  const hasText =
    text.length >= THRESHOLDS.occlusionMinTextChars || (text.length > 0 && isRequiredControl(el));
  return (
    hasText &&
    isJudgeable(pass, el) &&
    isVisible(pass.page, el) &&
    pass.page.style(el).position === "static"
  );
}

function occlusionCheck(pass: AuditPass, elements: readonly Element[]): void {
  const candidates = elements
    .filter((el) => isOcclusionCandidate(pass, el))
    .slice(0, THRESHOLDS.maxOcclusionCandidates);
  const failedRoots: Element[] = [];
  for (const el of candidates) {
    if (failedRoots.some((root) => root.contains(el))) continue;
    if (!isNearTotalOcclusion(sampleOcclusion(pass, el))) continue;
    failedRoots.push(el);
    report(pass, {
      rule: "overlapping-text",
      selector: selectorFor(pass.page, el),
      axis: "horizontal",
      overflowPx: 0,
    });
  }
}

// ---- the pass --------------------------------------------------------------------------------

function createPass(page: LayoutPage): AuditPass {
  return {
    page,
    metrics: page.metrics(),
    animated: page.animatedElements(),
    failedRoots: [],
    findings: [],
    seen: new Set(),
  };
}

/** One measurement of the page. Pure reads: it never changes the DOM. */
export function auditLayout(page: LayoutPage): LayoutAuditPageFinding[] {
  const pass = createPass(page);
  const elements = Array.from(page.document.body.querySelectorAll("*")).slice(
    0,
    THRESHOLDS.maxAuditedElements
  );
  pageOverflowCheck(pass, elements);
  for (const el of elements) controlChecks(pass, el);
  for (const el of elements) leftTextCheck(pass, el);
  for (const el of elements) textClipCheck(pass, el);
  occlusionCheck(pass, elements);
  return pass.findings;
}
