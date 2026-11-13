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
  isRequiredControl,
  isRootElement,
  isScrolling,
  isVisible,
  isVisibleTextHolder,
  judgedTextLines,
  nestedClippingBoundaries,
  paddingBox,
  rootVerticalScrollLocked,
  selectorFor,
  textFragments,
  textTruncation,
  type ClippingBoundary,
  visiblePart,
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
  /** Each element looked at for a scroll box: its panel, or null for one that does not scroll. */
  readonly panels: Map<Element, Panel | null>;
}

interface Point {
  x: number;
  y: number;
}

/**
 * A box that scrolls its contents (`overflow-y: auto | scroll`) and so hides some of them: what a
 * user sees of it before any scroll, with `top` and `bottom` in document coordinates.
 */
interface Panel {
  readonly el: Element;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
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
 * paragraph judges the text of what it holds, never a control: a control (`byOwnBox`) is not
 * exempt for sitting inside one.
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

/** Real content, not a scroll dimension, past the right edge: the evidence for page overflow. */
function elementEscapesRightEdge(pass: AuditPass, el: Element): boolean {
  const control = isRequiredControl(el);
  const scrolled = control
    ? hasHorizontalScrollerAncestor(pass.page, el)
    : isInsideHorizontalScroller(pass.page, el);
  if (scrolled || !isJudgeable(pass, el)) return false;
  const visible = control ? isVisible(pass.page, el) : isVisibleTextHolder(pass.page, el);
  if (!visible || isPositionedNonControl(pass, el)) return false;
  if (!control) return textEscapesRightEdge(pass, el);
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
  // A `display: contents` element has no box: its `overflow` cannot clip, and its ellipsis and line
  // clamp cannot cut or excuse a line, since no box lays the text out. None of them is read.
  const boxless = style.display === "contents";
  const truncation: TextTruncation = boxless ? "none" : textTruncation(style);
  const own = boxless
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

// Off the screen, above or below, where a scroll can bring it. Content above the screen is there
// to find when the page loaded already scrolled (an autofocus, a script that restores a position).
// Above the top of the page (document y under 0) no scroll reaches it.
function isScrollReachable(point: Point, metrics: PageMetrics): boolean {
  const { viewportWidth, viewportHeight, scrollY } = metrics;
  if (point.x < 0 || point.x > viewportWidth) return false;
  return point.y > viewportHeight || (point.y < 0 && point.y + scrollY >= 0);
}

// The rectangles whose points are sampled: the text lines, or for a control with no text line of
// its own the control's box. That is an <input value>, a <select>, an icon-only button, or a
// <textarea> that holds text (its value is drawn from a shadow tree, and a Range over the text it
// holds has no rectangle). Each is cut to the part that a clipping box leaves visible, as seen
// from the element it is drawn in: a clipped-away line has a rectangle, and a point on it would
// find whatever sits there instead.
function sampleRects(pass: AuditPass, el: Element): Box[] {
  const lines = judgedTextLines(pass.page, el);
  const rects =
    lines.length === 0 && isRequiredControl(el) ? [{ rect: pass.page.box(el), holder: el }] : lines;
  return rects.flatMap(({ rect, holder }) => {
    const visible = visiblePart(pass.page, holder, rect);
    return visible && visible.width * visible.height >= THRESHOLDS.minFragmentArea ? [visible] : [];
  });
}

// ---- scrolling panels ------------------------------------------------------------------------

// A box with `overflow-y: auto | scroll`, or null for any other. A box with no area (`display:
// contents`, whose overflow does nothing) is no panel either.
function panelOf(pass: AuditPass, node: Element): Panel | null {
  const known = pass.panels.get(node);
  if (known !== undefined) return known;
  const { page, metrics } = pass;
  let panel: Panel | null = null;
  if (isScrolling(page.style(node).overflowY)) {
    const { left, right, top, bottom } = paddingBox(page, node);
    if (right > left && bottom > top) {
      panel = {
        el: node,
        left,
        right,
        top: top + metrics.scrollY,
        bottom: bottom + metrics.scrollY,
      };
    }
  }
  pass.panels.set(node, panel);
  return panel;
}

// The panels whose content `el`'s rectangles are, outermost first. A panel's own text is held too.
function panelsHolding(pass: AuditPass, el: Element): Panel[] {
  return chainBelowRoot(pass.page, el)
    .flatMap((node) => panelOf(pass, node) ?? [])
    .reverse();
}

type PanelView = "shown" | "scroll" | "sideways";

// Where a point, in document coordinates, sits in the panels that hold it: inside every one
// ("shown"), below or above one ("scroll": scrolling that panel brings it into view), or past the
// left or right edge of one ("sideways": only a horizontal scroll reaches it, and the audit makes
// none). A point that no panel hides is as visible as the page is.
function viewIn(panels: readonly Panel[], point: Point): PanelView {
  if (panels.some((panel) => point.x < panel.left || point.x > panel.right)) return "sideways";
  return panels.some((panel) => point.y < panel.top || point.y > panel.bottom) ? "scroll" : "shown";
}

/** A sample point that waits for a scroll: where it is in the document before any, and its panels. */
interface ScrollPoint extends Point {
  readonly panels: readonly Panel[];
}

/** What the sample points of one candidate found so far. */
interface OcclusionSamples {
  el: Element;
  /** The cover found at each sampled point, null where nothing covers it. */
  covers: Array<Element | null>;
  /** Points above or below the screen, or scrolled out of a panel: sampled after a scroll. */
  offscreen: ScrollPoint[];
}

// Points a user sees without a scroll are sampled where they are. The others wait for a scroll:
// above or below the screen (every rect is read here, before any scroll, so all of them are in the
// one coordinate frame), or hidden by a panel. A point that a panel hides is never sampled where
// it lies: the page shows something else there (the block after the panel, say) and not this text.
function sampleOnScreen(pass: AuditPass, el: Element): OcclusionSamples {
  const samples: OcclusionSamples = { el, covers: [], offscreen: [] };
  const panels = panelsHolding(pass, el);
  for (const point of sampleRects(pass, el).flatMap(fragmentSamplePoints)) {
    const inDocument = { x: point.x, y: point.y + pass.metrics.scrollY };
    const view = viewIn(panels, inDocument);
    if (view === "sideways") continue;
    if (view === "shown" && isInsideViewport(point, pass.metrics)) {
      samples.covers.push(opaqueSiblingBlocker(pass, el, point));
    } else if (view === "scroll" || isScrollReachable(point, pass.metrics)) {
      samples.offscreen.push({ ...inDocument, panels });
    }
  }
  return samples;
}

/**
 * Every scroll the overlap rule makes, so that all of them are put back. A panel's scroll moves
 * what it holds (the points, and the panels inside it) up by how far it went: positions are
 * worked out from the ones read before any scroll, and the position reached is read back each time.
 */
interface ScrollTrail {
  readonly page: LayoutPage;
  readonly metrics: PageMetrics;
  /** The root clips vertically: the window cannot scroll. */
  readonly windowLocked: boolean;
  windowTop: number;
  windowMoved: boolean;
  /** The panels scrolled so far, each with the position it started at and the one it is at. */
  readonly panels: Map<Element, PanelScroll>;
  panelScrolls: number;
}

interface PanelScroll {
  readonly start: number;
  now: number;
  /** The way its content ended before a scroll arrived: asking for more that way moves nothing. */
  end?: "up" | "down";
}

function shiftOf(trail: ScrollTrail, panel: Panel): number {
  const scroll = trail.panels.get(panel.el);
  return scroll ? scroll.now - scroll.start : 0;
}

// Where the point is in the document now: each panel that scrolled moved it up.
function currentY(trail: ScrollTrail, point: ScrollPoint): number {
  return point.panels.reduce((y, panel) => y - shiftOf(trail, panel), point.y);
}

// A point at least a quarter of the way in from both edges: not at an edge, where a sticky bar or
// a scrollbar sits, and a scroll that put one point there serves the points near it too.
function inMiddleHalf(y: number, top: number, bottom: number): boolean {
  return y - top >= (bottom - top) / 4 && y - top <= ((bottom - top) * 3) / 4;
}

function isWithin(y: number, top: number, bottom: number): boolean {
  return y >= top && y <= bottom;
}

// Whether a scroll of the panel toward `way` may go ahead: not past a bound (`maxScrolledPanels`,
// `maxPanelScrolls`), and not toward an end the panel is known to have. A box that scrolls nowhere
// is tried once, not for each of its points.
function mayScrollPanel(trail: ScrollTrail, panel: Panel, way: "up" | "down"): boolean {
  const scroll = trail.panels.get(panel.el);
  if (scroll?.end === way || trail.panelScrolls >= THRESHOLDS.maxPanelScrolls) return false;
  return scroll !== undefined || trail.panels.size < THRESHOLDS.maxScrolledPanels;
}

// Recorded before the first scroll of the panel, so a scroll that throws is still put back.
function startScroll(trail: ScrollTrail, panel: Panel): PanelScroll {
  const start = trail.page.scrollTopOf(panel.el);
  const scroll = { start, now: start };
  trail.panels.set(panel.el, scroll);
  return scroll;
}

// One scroll of a panel by `delta`, if it may go ahead.
function scrollPanelBy(trail: ScrollTrail, panel: Panel, delta: number): void {
  const way = delta > 0 ? "down" : "up";
  if (!mayScrollPanel(trail, panel, way)) return;
  const scroll = trail.panels.get(panel.el) ?? startScroll(trail, panel);
  trail.panelScrolls += 1;
  const asked = scroll.now + delta;
  scroll.now = trail.page.scrollElementTo(panel.el, asked);
  if (Math.abs(scroll.now - asked) > THRESHOLDS.scrollRoundingPx) scroll.end = way;
}

// The part of its panel's box a user sees, where the panels outside it left it: each of them moved
// the box up by the distance it scrolled.
function boxNow(trail: ScrollTrail, panels: readonly Panel[], index: number) {
  const panel = panels[index];
  const moved = panels.slice(0, index).reduce((sum, outer) => sum + shiftOf(trail, outer), 0);
  return { top: panel.top - moved, bottom: panel.bottom - moved };
}

// Scrolls the panels that hold the point, the innermost first, until each one shows it (in the
// middle of its box when it had to scroll). The innermost goes first because its scroll puts the
// point in the middle of its box, and the panel around it then has one place to show. Returns
// where the point is in the document then, or null when a panel does not show it: a bound was
// reached, the end of its content stopped the scroll, or the box scrolls nothing that holds it.
function revealInPanels(trail: ScrollTrail, point: ScrollPoint): number | null {
  const { panels } = point;
  for (let index = panels.length - 1; index >= 0; index--) {
    const { top, bottom } = boxNow(trail, panels, index);
    const y = currentY(trail, point);
    if (!isWithin(y, top, bottom)) scrollPanelBy(trail, panels[index], y - (top + bottom) / 2);
  }
  const y = currentY(trail, point);
  const shown = panels.every((_, index) => {
    const { top, bottom } = boxNow(trail, panels, index);
    return isWithin(y, top, bottom);
  });
  return shown ? y : null;
}

// Scrolls the window, unless it already shows the point in its middle half and the window can
// scroll (the scroll is instant, whatever the page's `scroll-behavior`). Returns the point's
// place on the screen: the scroll reached is read back, as the end of the page limits it.
function revealInWindow(trail: ScrollTrail, y: number): number {
  const { viewportHeight } = trail.metrics;
  if (!trail.windowLocked && !inMiddleHalf(y, trail.windowTop, trail.windowTop + viewportHeight)) {
    trail.windowMoved = true;
    trail.windowTop = trail.page.scrollTo(y - viewportHeight / 2);
  }
  return y - trail.windowTop;
}

// Every restore runs, even when an earlier one threw: the error that comes out holds all failures.
function restoreScrolls(trail: ScrollTrail): void {
  const restores: Array<() => unknown> = [];
  for (const [el, { start }] of trail.panels) {
    restores.push(() => trail.page.scrollElementTo(el, start));
  }
  if (trail.windowMoved) restores.push(() => trail.page.scrollTo(trail.metrics.scrollY));
  const failures: unknown[] = [];
  for (const restore of restores) {
    try {
      restore();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "a scroll position was not put back");
}

/**
 * Samples the points that wait for a scroll, which a user reaches by scrolling: the page for what
 * is above or below the screen, a panel for what it hides. The points are taken in page order. A
 * panel that hides a point scrolls it into the middle of its box, the innermost panel first, and
 * the points that follow reuse that position. Then the window scrolls to put the point in the middle
 * of the viewport, as far as the page lets it: a point that no scroll brings on screen is skipped,
 * not sampled where it is not. A page that cannot scroll (its root clips vertically) shows a user
 * none of what lies off the screen, but its panels still scroll. Every scroll is put back before
 * this returns, so a later pass measures the same page.
 *
 * A measured element that is gone when its panel has scrolled (a list that draws only the rows
 * that show) leaves its sample unknown: the point is skipped, and counts as neither covered nor
 * free. The same holds for a point beyond the bounds on panels and panel scrolls: the work stays
 * inside the time budget, and the rest of that panel is not sampled.
 */
function sampleOffScreen(pass: AuditPass, all: readonly OcclusionSamples[]): void {
  const pending = all.flatMap((samples) => samples.offscreen.map((point) => ({ samples, point })));
  if (pending.length === 0) return;
  pending.sort((a, b) => a.point.y - b.point.y);
  const { page, metrics } = pass;
  const trail: ScrollTrail = {
    page,
    metrics,
    windowLocked: rootVerticalScrollLocked(page),
    windowTop: metrics.scrollY,
    windowMoved: false,
    panels: new Map(),
    panelScrolls: 0,
  };
  try {
    for (const { samples, point } of pending) {
      const y = revealInPanels(trail, point);
      if (y === null || (point.panels.length > 0 && !samples.el.isConnected)) continue;
      const clientPoint = { x: point.x, y: revealInWindow(trail, y) };
      if (!isInsideViewport(clientPoint, metrics)) continue;
      samples.covers.push(opaqueSiblingBlocker(pass, samples.el, clientPoint));
    }
  } finally {
    restoreScrolls(trail);
  }
}

// How many of the sample points sit under a cover, of how many in all. Covers add up: two panels
// side by side that together hide the text make it as unreadable as one panel does.
function occlusionOf(samples: OcclusionSamples) {
  return {
    occludedSamples: samples.covers.filter((cover) => cover !== null).length,
    totalSamples: samples.covers.length,
  };
}

// Long enough to read (any length for a control), static (positioned text overlaps on purpose),
// and not shown by a paragraph around it. A control is a candidate inside one too: the
// paragraph's lines are no stand-in for its face, and have none for a control with no text line.
function isOcclusionCandidate(pass: AuditPass, el: Element): boolean {
  const text = auditedText(pass.page, el);
  const control = isRequiredControl(el);
  const sampled = text.length >= THRESHOLDS.occlusionMinTextChars || control;
  return (
    sampled &&
    isJudgeable(pass, el, control) &&
    isVisibleTextHolder(pass.page, el) &&
    pass.page.style(el).position === "static"
  );
}

function occlusionCheck(pass: AuditPass, elements: readonly Element[]): void {
  const candidates = elements
    .filter((el) => isOcclusionCandidate(pass, el))
    .slice(0, THRESHOLDS.maxOcclusionCandidates);
  const sampled = candidates.map((el) => sampleOnScreen(pass, el));
  sampleOffScreen(pass, sampled);
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
    panels: new Map(),
  };
}

/**
 * One measurement of the page. It never changes the DOM. The overlap rule scrolls the window and
 * the panels that hide text, to sample it, and puts every scroll back before this returns.
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
