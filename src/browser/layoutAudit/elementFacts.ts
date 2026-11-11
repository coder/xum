// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.
import { LAYOUT_AUDIT_THRESHOLDS as THRESHOLDS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditAxis } from "@/common/types/artifactLayoutAudit";
import type { TextTruncation } from "./geometry";
import type { Box, LayoutPage, LayoutStyle } from "./layoutPage";

/**
 * What a rule may ask about one element before it measures anything: is it text the author
 * meant to show, is it hidden, masked or scrolling, which box clips it. Every function here is
 * a port of one upstream helper, except `selectorFor` (see audit.ts) and the shared walks.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SEMANTIC_TEXT_BOUNDARY =
  "p,h1,h2,h3,h4,h5,h6,button,label,a[href],li,dt,dd,th,td,legend,figcaption,summary,[role='button'],[role='link'],[role='alert'],[role='status']";
// Upstream also lists [data-lavish-action] (Lavish's own UI), which Xum never injects.
const CONTROL = "button,input,select,textarea,a[href],summary,[role]";
const DISABLED_CONTROL = "input[type='hidden'],[disabled],[aria-disabled='true']";
const CONTROL_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "combobox",
]);
// Diagram surfaces stay outside the general audit. Upstream also lists [data-lavish-ui].
const DIAGRAM = ".mermaid,svg";

/** A clipping ancestor: the padding box that cuts its descendants, on the axes it clips. */
export interface ClippingBoundary {
  el: Element;
  box: Pick<Box, "left" | "right" | "top" | "bottom">;
  axes: LayoutAuditAxis[];
}

export function px(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isClipping(overflow: string): boolean {
  return overflow === "hidden" || overflow === "clip";
}

export function isScrolling(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll";
}

/** `el`, its parent, and so on up to <html>. */
export function selfAndAncestors(el: Element | null): Element[] {
  const chain: Element[] = [];
  for (let node = el; node; node = node.parentElement) chain.push(node);
  return chain;
}

export function isRootElement(page: LayoutPage, el: Element): boolean {
  return el === page.document.body || el === page.document.documentElement;
}

/** `el` and its ancestors, stopping before <body> and <html>. */
export function chainBelowRoot(page: LayoutPage, el: Element | null): Element[] {
  const chain: Element[] = [];
  for (let node = el; node && !isRootElement(page, node); node = node.parentElement) {
    chain.push(node);
  }
  return chain;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function directText(el: Element): string {
  const own = Array.from(el.childNodes)
    .filter((node) => node.nodeType === TEXT_NODE)
    .map((node) => node.textContent ?? "");
  return normalizeText(own.join(" "));
}

export function isSemanticTextBoundary(el: Element): boolean {
  return el.matches(SEMANTIC_TEXT_BOUNDARY);
}

/** The text a rule judges for `el`: all of it for a text boundary (a paragraph), else its own. */
export function auditedText(page: LayoutPage, el: Element): string {
  return isSemanticTextBoundary(el) ? normalizeText(page.renderedText(el)) : directText(el);
}

/** A span inside a paragraph is judged with the paragraph, not on its own. */
export function isNestedInTextBoundary(page: LayoutPage, el: Element): boolean {
  if (isSemanticTextBoundary(el)) return false;
  return chainBelowRoot(page, el.parentElement).some(isSemanticTextBoundary);
}

export function isRequiredControl(el: Element): boolean {
  if (!el.matches(CONTROL) || el.matches(DISABLED_CONTROL)) return false;
  if (!el.hasAttribute("role")) return true;
  return CONTROL_ROLES.has((el.getAttribute("role") ?? "").toLowerCase());
}

// `visibility` is not here: it inherits and a descendant may switch it back on (see isVisible).
function isHiddenStyle(style: LayoutStyle): boolean {
  const opacity = Number.parseFloat(style.opacity || "1");
  return (
    style.display === "none" ||
    style.contentVisibility === "hidden" ||
    (Number.isFinite(opacity) && opacity <= THRESHOLDS.hiddenOpacity)
  );
}

/**
 * Has area, is not `visibility: hidden`, and neither it nor an ancestor is display none, hidden
 * by content-visibility or transparent. Computed `visibility` inherits, so the element's own
 * value is the effective one: a `visibility: visible` descendant of a hidden container is
 * painted and reachable. Display, content-visibility and opacity cannot be switched back on by a
 * descendant, so those walk the ancestors.
 */
export function isVisible(page: LayoutPage, el: Element): boolean {
  const rect = page.box(el);
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (page.style(el).visibility === "hidden") return false;
  return !selfAndAncestors(el).some((node) => isHiddenStyle(page.style(node)));
}

function hasHorizontalScroller(page: LayoutPage, chain: readonly Element[]): boolean {
  return chain.some((node) => isScrolling(page.style(node).overflowX));
}

/**
 * Text in a horizontal scroller, the scroller's own text included (upstream's walk): scrolling
 * shows it.
 */
export function isInsideHorizontalScroller(page: LayoutPage, el: Element): boolean {
  return hasHorizontalScroller(page, chainBelowRoot(page, el));
}

/**
 * A horizontal scroller between `el`'s parent and the root, for a control: scrolling a control's
 * own contents (a textarea scrolls by default) never moves the control into view.
 */
export function hasHorizontalScrollerAncestor(page: LayoutPage, el: Element): boolean {
  return hasHorizontalScroller(page, chainBelowRoot(page, el.parentElement));
}

export function hasReachableVerticalScrollerAncestor(
  page: LayoutPage,
  el: Element,
  viewportHeight: number
): boolean {
  return chainBelowRoot(page, el.parentElement).some((node) => {
    const rect = page.box(node);
    return isScrolling(page.style(node).overflowY) && rect.bottom > 0 && rect.top < viewportHeight;
  });
}

export function rootVerticalScrollLocked(page: LayoutPage): boolean {
  const roots = [page.document.documentElement, page.document.body];
  return roots.some((node) => isClipping(page.style(node).overflowY));
}

export function paddingBox(page: LayoutPage, el: Element): ClippingBoundary["box"] {
  const rect = page.box(el);
  const style = page.style(el);
  return {
    left: rect.left + px(style.borderLeftWidth),
    right: rect.right - px(style.borderRightWidth),
    top: rect.top + px(style.borderTopWidth),
    bottom: rect.bottom - px(style.borderBottomWidth),
  };
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === TEXT_NODE;
}

// Document order. A text boundary's descendants count; any other element reads only its own.
function collectTextNodes(parent: Node, descend: boolean, found: Text[]): void {
  for (const node of Array.from(parent.childNodes)) {
    if (isTextNode(node)) {
      if (node.textContent?.trim()) found.push(node);
    } else if (descend && node.nodeType === ELEMENT_NODE) {
      collectTextNodes(node, descend, found);
    }
  }
}

/** The rendered line rectangles of the text `el` is judged on. */
export function textFragments(page: LayoutPage, el: Element): Box[] {
  const nodes: Text[] = [];
  collectTextNodes(el, isSemanticTextBoundary(el), nodes);
  return nodes.flatMap((node) => page.textLines(node));
}

/** Which cut the author asked for; a line clamp wins over an ellipsis (it covers both axes). */
export function textTruncation(style: LayoutStyle): TextTruncation {
  if (Number.parseInt(style.webkitLineClamp || "0", 10) > 0) return "line-clamp";
  return style.textOverflow === "ellipsis" ? "ellipsis" : "none";
}

function isSet(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered !== "none" && lowered !== "";
}

function hasVisualMask(style: LayoutStyle): boolean {
  return isSet(style.maskImage || style.webkitMaskImage || "") || isSet(style.clipPath || "");
}

function clipsOverflow(style: LayoutStyle): boolean {
  return isClipping(style.overflowX) || isClipping(style.overflowY);
}

// A rounded box with overflow hidden cuts glyph ink at its corners on purpose.
function isRoundedOverflowMask(style: LayoutStyle): boolean {
  const radii = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ];
  return clipsOverflow(style) && radii.some((radius) => px(radius) > 0);
}

function hasVisualMaskAncestor(page: LayoutPage, el: Element): boolean {
  return selfAndAncestors(el).some((node) => {
    const style = page.style(node);
    return hasVisualMask(style) || isRoundedOverflowMask(style);
  });
}

// A legacy `clip` that is not "auto" or a clip-path: the common screen-reader-only recipe.
function hasClipDeclaration(style: LayoutStyle): boolean {
  return (style.clip || "").toLowerCase() !== "auto" || isSet(style.clipPath || "");
}

function isStandardVisuallyHidden(style: LayoutStyle, rect: Box): boolean {
  const positioned = style.position === "absolute" || style.position === "fixed";
  const tiny =
    rect.width <= THRESHOLDS.visuallyHiddenMaxPx && rect.height <= THRESHOLDS.visuallyHiddenMaxPx;
  return (
    positioned &&
    tiny &&
    isClipping(style.overflowX) &&
    (style.whiteSpace === "nowrap" || hasClipDeclaration(style))
  );
}

function hasStandardVisuallyHiddenAncestor(page: LayoutPage, el: Element): boolean {
  return selfAndAncestors(el).some((node) =>
    isStandardVisuallyHidden(page.style(node), page.box(node))
  );
}

/** Diagrams, masked or rounded-clipped content and screen-reader-only text are never audited. */
export function isExcludedElement(page: LayoutPage, el: Element): boolean {
  return (
    el.closest(DIAGRAM) !== null ||
    hasVisualMaskAncestor(page, el) ||
    hasStandardVisuallyHiddenAncestor(page, el)
  );
}

function clippedAxes(style: LayoutStyle): LayoutAuditAxis[] {
  const axes: LayoutAuditAxis[] = [];
  if (isClipping(style.overflowX)) axes.push("horizontal");
  if (isClipping(style.overflowY)) axes.push("vertical");
  return axes;
}

// A box that cuts its contents on purpose (a mask, rounded corners with overflow hidden) is no
// boundary: it cuts glyph ink at its edge by design.
function clippingBoundaryOf(page: LayoutPage, node: Element): ClippingBoundary | null {
  const style = page.style(node);
  const axes = clippedAxes(style);
  if (axes.length === 0 || hasVisualMask(style) || isRoundedOverflowMask(style)) return null;
  return { el: node, box: paddingBox(page, node), axes };
}

/** Ancestors that cut their descendants (overflow hidden or clip), nearest first. */
export function clippingBoundariesFor(page: LayoutPage, el: Element): ClippingBoundary[] {
  return chainBelowRoot(page, el.parentElement).flatMap(
    (node) => clippingBoundaryOf(page, node) ?? []
  );
}

/** A clipping element inside a text boundary, and the rendered lines of the text it holds. */
export interface NestedClip {
  boundary: ClippingBoundary;
  fragments: Box[];
}

// A nested clipper is judged like a clipping ancestor, and only when it is shown. The text it
// holds is filtered by the caller: text under a diagram, mask or screen-reader-only element
// (the clipper itself included) is never evidence of a cut.
function nestedClipFor(page: LayoutPage, node: Element): NestedClip | null {
  const boundary = clippingBoundaryOf(page, node);
  return boundary !== null && isVisible(page, node) ? { boundary, fragments: [] } : null;
}

// The nested clippers that hold `node`, nearest first: judged ones only, each looked up once.
function clippersHolding(
  page: LayoutPage,
  node: Text,
  boundary: Element,
  clips: Map<Element, NestedClip | null>
): NestedClip[] {
  const found: NestedClip[] = [];
  for (
    let holder = node.parentElement;
    holder && holder !== boundary;
    holder = holder.parentElement
  ) {
    if (!clips.has(holder)) clips.set(holder, nestedClipFor(page, holder));
    const clip = clips.get(holder);
    if (clip) found.push(clip);
  }
  return found;
}

/**
 * The clipping elements between a text boundary's text and the boundary (a paragraph's narrower
 * `overflow: hidden` span), each with the lines it holds. The boundary measures its text against
 * its own box and its clipping ancestors, so a clipper inside it would cut text that no box
 * reaches. Text that no rule judges (a diagram label, screen-reader-only text) is no evidence of
 * a cut. Another element reads only its own text, so it has none.
 */
export function nestedClippingBoundaries(page: LayoutPage, el: Element): NestedClip[] {
  if (!isSemanticTextBoundary(el)) return [];
  const nodes: Text[] = [];
  collectTextNodes(el, true, nodes);
  const clips = new Map<Element, NestedClip | null>();
  for (const node of nodes) {
    const clippers = clippersHolding(page, node, el, clips);
    if (
      clippers.length === 0 ||
      (node.parentElement && isExcludedElement(page, node.parentElement))
    ) {
      continue;
    }
    const lines = page.textLines(node);
    for (const clip of clippers) clip.fragments.push(...lines);
  }
  return Array.from(clips.values()).filter((clip) => clip !== null);
}

/** Near an animation target (itself, an ancestor or a descendant): motion makes geometry lie. */
export function isNearAnimation(animated: readonly Element[], el: Element): boolean {
  return animated.some((target) => target === el || target.contains(el) || el.contains(target));
}

function selectorPart(page: LayoutPage, node: Element): string {
  const tag = node.tagName.toLowerCase();
  if (node.id) return `${tag}#${page.escapeIdent(node.id)}`;
  const same = Array.from(node.parentElement?.children ?? []).filter(
    (sibling) => sibling.tagName === node.tagName
  );
  return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag;
}

/**
 * A CSS-like path for a finding: up to five parts, cut at the nearest id, `:nth-of-type` where
 * siblings share a tag. Upstream's `selector`.
 */
export function selectorFor(page: LayoutPage, el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    parts.unshift(selectorPart(page, node));
    if (node.id || parts.length >= THRESHOLDS.selectorMaxParts) break;
  }
  return parts.join(" > ");
}
