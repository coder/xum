// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.
import { LAYOUT_AUDIT_THRESHOLDS as THRESHOLDS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditAxis } from "@/common/types/artifactLayoutAudit";
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
const CONTROL_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "textbox", "combobox"]);
// Diagram surfaces stay outside the general audit. Upstream also lists [data-lavish-ui].
const DIAGRAM = ".mermaid,svg";

/** A clipping ancestor: the padding box that cuts its descendants, on the axes it clips. */
export interface ClippingBoundary {
  el: Element;
  box: Pick<Box, "left" | "right" | "top" | "bottom">;
  axes: LayoutAuditAxis[];
}

export function px(value: string | undefined): number {
  const parsed = Number.parseFloat(String(value || "0"));
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
    .map((node) => node.textContent || "");
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
  return CONTROL_ROLES.has((el.getAttribute("role") || "").toLowerCase());
}

function isHiddenStyle(style: LayoutStyle): boolean {
  const opacity = Number.parseFloat(style.opacity || "1");
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.contentVisibility === "hidden" ||
    (Number.isFinite(opacity) && opacity <= THRESHOLDS.hiddenOpacity)
  );
}

/** Has area, and neither it nor an ancestor is display none, hidden or transparent. */
export function isVisible(page: LayoutPage, el: Element): boolean {
  const rect = page.box(el);
  if (rect.width <= 0 || rect.height <= 0) return false;
  return !selfAndAncestors(el).some((node) => isHiddenStyle(page.style(node)));
}

/** A horizontal scroller between `el` and the root: content past its edge is reachable. */
export function hasHorizontalScrollerAncestor(page: LayoutPage, el: Element): boolean {
  return chainBelowRoot(page, el).some((node) => isScrolling(page.style(node).overflowX));
}

export function hasReachableVerticalScrollerAncestor(
  page: LayoutPage,
  el: Element,
  viewportHeight: number,
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

/** Ellipsis or line-clamp: the author asked for the cut. */
export function isIntentionalTruncation(style: LayoutStyle): boolean {
  return style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp || "0", 10) > 0;
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
    isStandardVisuallyHidden(page.style(node), page.box(node)),
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

/** Ancestors that cut their descendants (overflow hidden or clip), nearest first. */
export function clippingBoundariesFor(page: LayoutPage, el: Element): ClippingBoundary[] {
  const boundaries: ClippingBoundary[] = [];
  for (const node of chainBelowRoot(page, el.parentElement)) {
    const style = page.style(node);
    const axes = clippedAxes(style);
    if (axes.length > 0 && !hasVisualMask(style) && !isRoundedOverflowMask(style)) {
      boundaries.push({ el: node, box: paddingBox(page, node), axes });
    }
  }
  return boundaries;
}

/** Near an animation target (itself, an ancestor or a descendant): motion makes geometry lie. */
export function isNearAnimation(animated: readonly Element[], el: Element): boolean {
  return animated.some((target) => target === el || target.contains(el) || el.contains(target));
}

function selectorPart(page: LayoutPage, node: Element): string {
  const tag = node.tagName.toLowerCase();
  if (node.id) return `${tag}#${page.escapeIdent(node.id)}`;
  const same = Array.from(node.parentElement?.children ?? []).filter(
    (sibling) => sibling.tagName === node.tagName,
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
