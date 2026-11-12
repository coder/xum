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
  isInsideHorizontalScroller,
  isNearAnimation,
  isNestedInTextBoundary,
  isReplacedContent,
  isRequiredControl,
  isRootElement,
  isVisible,
  isVisibleTextHolder,
  nestedClippingBoundaries,
  paddingBox,
  rootVerticalScrollLocked,
  selectorFor,
  textFragments,
  textTruncation,
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
  type TextTruncation,
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
 * near motion. The part of every text and control rule that does not depend on the rule. A
 * paragraph judges the text of what it holds, never a box: an element that is judged by its own
 * box (`byOwnBox`) is not exempt for sitting inside one.
 */
function isJudgeable(pass: AuditPass, el: Element, byOwnBox = false): boolean {
  return (
    !isExcludedElement(pass.page, el) &&
    (byOwnBox || !isNestedInTextBoundary(pass.page, el)) &&
    !isNearAnimation(pass.animated, el)
  );
}

function isVisibleText(pass: AuditPass, el: Element): boolean {
  return (
    isJudgeable(pass, el) && auditedText(pass.page, el) !== "" && isVisibleTextHolder(pass.page, el)
  );
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

/**
 * Real content, not a scroll dimension, past the right edge: the evidence for page overflow. A
 * control and a replaced element (an image, a video) are judged by their box, as nothing else
 * says where they end. Text is judged by its lines.
 */
function elementEscapesRightEdge(pass: AuditPass, el: Element): boolean {
  const replaced = isReplacedContent(el);
  const byBox = replaced || isRequiredControl(el);
  const scrolled = byBox
    ? hasHorizontalScrollerAncestor(pass.page, el)
    : isInsideHorizontalScroller(pass.page, el);
  // An image in a link or a table cell is no text for the paragraph around it to judge.
  if (scrolled || !isJudgeable(pass, el, replaced)) return false;
  const visible = byBox ? isVisible(pass.page, el) : isVisibleTextHolder(pass.page, el);
  if (!visible || isPositionedNonControl(pass, el)) return false;
  if (!byBox) return textEscapesRightEdge(pass, el);
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

// A control past the right edge widens the page, and page-horizontal-overflow reports that. A
// fixed control does not widen it, and no scroll brings it back, so its right edge is checked
// here like its left.
function viewportEdgeControlCheck(pass: AuditPass, el: Element, rect: Box): void {
  if (hasHorizontalScrollerAncestor(pass.page, el)) return;
  const escape = viewportEscape(pass, rect, THRESHOLDS.controlMinOutsidePx);
  if (escape === null || (escape.side === "end" && !isFixed(pass, el))) return;
  report(pass, {
    rule: "viewport-unreachable-control",
    selector: selectorFor(pass.page, el),
    axis: "horizontal",
    overflowPx: escape.overflowPx,
  });
}

function isFixed(pass: AuditPass, el: Element): boolean {
  return pass.page.style(el).position === "fixed";
}

// A fixed control, or any control when the root cannot scroll and no scroller on screen holds it,
// must fit the viewport; otherwise it must fit the scrollable page. A sticky control is not
// pinned: it sits in the flow until the user scrolls to it, so one below the fold is reachable.
function isPinnedToViewport(pass: AuditPass, el: Element): boolean {
  if (isFixed(pass, el)) return true;
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
  viewportEdgeControlCheck(pass, el, rect);
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
  if (isInsideHorizontalScroller(pass.page, el) || !isVisibleText(pass, el)) return;
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

function clipAtBoundary(
  boundary: ClippingBoundary,
  fragments: readonly Box[],
  truncation: TextTruncation
): TextClip | null {
  const failure = classifySevereTextOverflow({
    fragments,
    box: boundary.box,
    overflowX: clippedOverflow(boundary, "horizontal"),
    overflowY: clippedOverflow(boundary, "vertical"),
    truncation,
  });
  return failure && { root: boundary.el, ...failure };
}

// The element's own box first, then each clipping element inside it (a text boundary's narrower
// span), then each clipping ancestor: the strongest failure names the root that is reported (a
// later clip wins only by overflowing more).
function strongestTextClip(pass: AuditPass, el: Element): TextClip | null {
  const style = pass.page.style(el);
  const fragments = textFragments(pass.page, el);
  const truncation = textTruncation(style);
  // A `display: contents` element has no box, so its `overflow` cannot cut its own text.
  const own =
    style.display === "contents"
      ? null
      : classifySevereTextOverflow({
          fragments,
          box: paddingBox(pass.page, el),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          truncation,
        });
  let clip: TextClip | null = own && { root: el, ...own };
  // A nested clipper's own ellipsis or line clamp is the author's cut of the text it holds, so it
  // is read from that clipper (`<span class="truncate">` in a paragraph is common).
  for (const nested of nestedClippingBoundaries(pass.page, el)) {
    const nestedTruncation = textTruncation(pass.page.style(nested.boundary.el));
    clip = strongest(clip, clipAtBoundary(nested.boundary, nested.fragments, nestedTruncation));
  }
  for (const boundary of clippingBoundariesFor(pass.page, el)) {
    clip = strongest(clip, clipAtBoundary(boundary, fragments, truncation));
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

// A computed color keeps the notation it was written in (oklch() stays oklch(), color() stays
// color()), so the alpha is read from the text, whatever the function.
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/;

function parseAlpha(text: string): number {
  const value = text.trim();
  return value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
}

/** The alpha of a computed color, or null when it is not a color this knows. NaN: a bad alpha. */
function colorAlpha(color: string): number | null {
  const value = color.trim().toLowerCase();
  if (value === "transparent") return 0;
  const args = COLOR_FUNCTION.exec(value)?.[1];
  if (args === undefined) return null;
  // The alpha follows a slash ("r g b / a", every modern function) or is the fourth comma part
  // (legacy "r, g, b, a"). Neither: the function has no alpha, so it is opaque.
  const slash = args.lastIndexOf("/");
  const alpha = slash >= 0 ? args.slice(slash + 1) : args.split(",")[3];
  return alpha === undefined ? 1 : parseAlpha(alpha);
}

// Opaque: opacity and background alpha both at least 0.95.
function isOpaqueColor(color: string): boolean {
  const alpha = colorAlpha(color);
  return alpha !== null && alpha >= THRESHOLDS.opaqueMin;
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

function isBelowViewport(point: Point, metrics: PageMetrics): boolean {
  return point.x >= 0 && point.x <= metrics.viewportWidth && point.y > metrics.viewportHeight;
}

// A control with no text of its own (an <input value>, a <select>, an icon-only button): its face
// is not a text node, so it is sampled by its box.
function isFacelessControl(page: LayoutPage, el: Element): boolean {
  return auditedText(page, el) === "" && isRequiredControl(el);
}

// The rectangles whose points are sampled: the text lines, or the box of a faceless control.
function sampleRects(pass: AuditPass, el: Element): Box[] {
  const rects = isFacelessControl(pass.page, el)
    ? [pass.page.box(el)]
    : textFragments(pass.page, el);
  return rects.filter((rect) => rect.width * rect.height >= THRESHOLDS.minFragmentArea);
}

/** What the sample points of one candidate found so far. */
interface OcclusionSamples {
  el: Element;
  /** The cover found at each sampled point, null where nothing covers it. */
  covers: Array<Element | null>;
  /** Points below the screen, in document coordinates: sampled after a scroll. */
  below: Point[];
}

// Points inside the viewport are sampled where they are. Points below it wait for a scroll (every
// rect is read here, before any scroll, so all of them are in the one coordinate frame).
function sampleOnScreen(pass: AuditPass, el: Element): OcclusionSamples {
  const samples: OcclusionSamples = { el, covers: [], below: [] };
  for (const point of sampleRects(pass, el).flatMap(fragmentSamplePoints)) {
    if (isInsideViewport(point, pass.metrics)) {
      samples.covers.push(opaqueSiblingBlocker(pass, el, point));
    } else if (isBelowViewport(point, pass.metrics)) {
      samples.below.push({ x: point.x, y: point.y + pass.metrics.scrollY });
    }
  }
  return samples;
}

/**
 * Samples the points below the screen, which a user reaches by scrolling. The points are taken
 * in page order. One that is not in the middle half of the viewport scrolls the window to put it
 * in the middle (the scroll is instant, whatever the page's `scroll-behavior`), and the points
 * that follow reuse that position. The scroll that was reached is read back: a point the page
 * could not bring on screen is skipped, not sampled where it is not. A page that cannot scroll
 * (its root clips vertically) shows a user none of this text. The scroll position is put back
 * before this returns, so a later pass measures the same page.
 */
function sampleBelowScreen(pass: AuditPass, all: readonly OcclusionSamples[]): void {
  const { page, metrics } = pass;
  const pending = all.flatMap((samples) => samples.below.map((point) => ({ samples, point })));
  if (pending.length === 0 || rootVerticalScrollLocked(page)) return;
  pending.sort((a, b) => a.point.y - b.point.y);
  const { viewportHeight } = metrics;
  let top = metrics.scrollY;
  try {
    for (const { samples, point } of pending) {
      const inMiddleHalf =
        point.y - top >= viewportHeight / 4 && point.y - top <= (viewportHeight * 3) / 4;
      if (!inMiddleHalf) top = page.scrollTo(point.y - viewportHeight / 2);
      const clientPoint = { x: point.x, y: point.y - top };
      if (!isInsideViewport(clientPoint, metrics)) continue;
      samples.covers.push(opaqueSiblingBlocker(pass, samples.el, clientPoint));
    }
  } finally {
    page.scrollTo(metrics.scrollY);
  }
}

// How many sample points one blocker covers, of how many in all.
function occlusionOf(samples: OcclusionSamples) {
  const coveredBy = new Map<Element, number>();
  for (const cover of samples.covers) {
    if (cover) coveredBy.set(cover, (coveredBy.get(cover) ?? 0) + 1);
  }
  return {
    occludedSamples: Math.max(0, ...coveredBy.values()),
    totalSamples: samples.covers.length,
  };
}

// Long enough to read (any length for a control, and none at all: it is sampled by its box),
// static (positioned text overlaps on purpose), and not shown by a paragraph around it. A control
// with no text is no text for a paragraph to show, so it is a candidate inside one too.
function isOcclusionCandidate(pass: AuditPass, el: Element): boolean {
  const text = auditedText(pass.page, el);
  const sampled = text.length >= THRESHOLDS.occlusionMinTextChars || isRequiredControl(el);
  return (
    sampled &&
    isJudgeable(pass, el, isFacelessControl(pass.page, el)) &&
    isVisibleTextHolder(pass.page, el) &&
    pass.page.style(el).position === "static"
  );
}

function occlusionCheck(pass: AuditPass, elements: readonly Element[]): void {
  const candidates = elements
    .filter((el) => isOcclusionCandidate(pass, el))
    .slice(0, THRESHOLDS.maxOcclusionCandidates);
  const sampled = candidates.map((el) => sampleOnScreen(pass, el));
  sampleBelowScreen(pass, sampled);
  const failedRoots: Element[] = [];
  for (const samples of sampled) {
    const { el } = samples;
    if (failedRoots.some((root) => root.contains(el))) continue;
    if (!isNearTotalOcclusion(occlusionOf(samples))) continue;
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

/**
 * One measurement of the page. It never changes the DOM. The overlap rule scrolls the window to
 * sample text below the screen and puts it back before this returns.
 */
export function auditLayout(page: LayoutPage): LayoutAuditPageFinding[] {
  const pass = createPass(page);
  const { body } = page.document;
  const elements = Array.from(body.querySelectorAll("*")).slice(0, THRESHOLDS.maxAuditedElements);
  // Text directly in <body> counts like an element's own text. Upstream walks only body's
  // descendants, so a bare `<body>longword</body>` widened the page unseen. Body takes the two
  // rules that read its text. It is no control. A root is never a clip (`textClipCheck` skips it),
  // and a cover is never body's own descendant, which everything else is.
  const textHolders = [body, ...elements];
  pageOverflowCheck(pass, textHolders);
  for (const el of elements) controlChecks(pass, el);
  for (const el of textHolders) leftTextCheck(pass, el);
  for (const el of elements) textClipCheck(pass, el);
  occlusionCheck(pass, elements);
  return pass.findings;
}
