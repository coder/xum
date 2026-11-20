import { Window } from "happy-dom";
import type { BrowserWindow } from "./browserPage";
import type { Box, LayoutPage, LayoutStyle, PageMetrics, SettleSignals } from "./layoutPage";

/**
 * A LayoutPage over a happy-dom document, with geometry taken from attributes, so the rules
 * run in bun test with no layout engine. Structure (parents, matches, closest, text nodes) is
 * the real DOM's; only what a browser would measure comes from the markup:
 *
 *   data-box="x y w h"            the element's border box (default: empty, so not visible)
 *   data-lines="x y w h; ..."     rects of the element's first direct text node
 *   data-css="overflow-x: hidden; opacity: 0.5"   computed style over browser-like defaults
 *   data-animated                 the element is the target of a running animation
 *   data-z="2"                    stacking for elementAt (default 0; a tie goes to the later element)
 *   data-scroll="40"              a scrolling box's scrollTop before the audit (default 0)
 *   data-scroll-height="900"      the height of its content: it scrolls to this minus its own
 *                                 height at most (default: it does not scroll)
 *
 * Coordinates are client coordinates at the page's first scroll position (`viewport.scrollY`) and
 * the first scrollTop of every scrolling box. `scrollTo` moves the fake window and
 * `scrollElementTo` a box (one with `overflow-y: auto | scroll`), and `elementAt` reads the markup
 * at the scrolled positions, as a browser's hit test does: what a box holds moves up with its
 * scroll, and only what its own box shows can be hit. `box` and `textLines` do not follow the
 * scroll: the rules read them before any scroll, and a test that needs the page read after one
 * uses a real browser.
 */

const DEFAULT_STYLE: LayoutStyle = {
  display: "block",
  visibility: "visible",
  contentVisibility: "visible",
  opacity: "1",
  position: "static",
  overflowX: "visible",
  overflowY: "visible",
  textOverflow: "clip",
  webkitLineClamp: "none",
  whiteSpace: "normal",
  maskImage: "none",
  webkitMaskImage: "none",
  clipPath: "none",
  clip: "auto",
  backgroundColor: "rgba(0, 0, 0, 0)",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
};

export interface FakeLayoutPageOptions {
  viewport?: {
    width: number;
    height: number;
    /** Default: the viewport's own width. */
    scrollWidth?: number;
    /** Default: the viewport's own height. */
    scrollHeight?: number;
    scrollY?: number;
  };
  /** What the settle signals resolve to. Everything settles at once by default. */
  settle?: Partial<{
    layoutQuiet: boolean;
    domQuiet: boolean;
    animationsSettled: boolean;
    documentComplete: boolean;
  }>;
}

export interface FakeLayoutPage {
  readonly page: LayoutPage;
  readonly signals: SettleSignals;
  /**
   * Signal calls, measurements and scrolls, in the order they happened ("measure" = one
   * page.metrics(), "scrollTo 1200" = one page.scrollTo(1200)).
   */
  readonly calls: string[];
  byId(id: string): Element;
  [Symbol.dispose](): void;
}

function numbers(attribute: string | null, count: number, what: string): number[] {
  const values = (attribute ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  if (values.length === 0) return Array<number>(count).fill(0);
  if (values.length !== count || values.some(Number.isNaN))
    throw new Error(`bad ${what}: ${attribute ?? ""}`);
  return values;
}

function toBox([x, y, width, height]: number[]): Box {
  return { left: x, top: y, right: x + width, bottom: y + height, width, height };
}

function boxOf(el: Element): Box {
  return toBox(numbers(el.getAttribute("data-box"), 4, "data-box"));
}

function linesOf(el: Element): Box[] {
  const lines = (el.getAttribute("data-lines") ?? "").split(";").filter((part) => part.trim());
  return lines.map((line) => toBox(numbers(line, 4, "data-lines")));
}

function isStyleKey(key: string): key is keyof LayoutStyle {
  return key in DEFAULT_STYLE;
}

function styleOf(el: Element): LayoutStyle {
  const overrides: Partial<LayoutStyle> = {};
  for (const declaration of (el.getAttribute("data-css") ?? "").split(";")) {
    const [name, ...value] = declaration.split(":");
    if (!name?.trim()) continue;
    const key = name.trim().replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (!isStyleKey(key)) throw new Error(`unknown style in data-css: ${name}`);
    overrides[key] = value.join(":").trim();
  }
  // Computed `visibility` inherits: an element has its parent's unless it sets its own.
  const inherited = el.parentElement
    ? styleOf(el.parentElement).visibility
    : DEFAULT_STYLE.visibility;
  return { ...DEFAULT_STYLE, visibility: inherited, ...overrides };
}

function firstTextNode(el: Element): Node | undefined {
  return Array.from(el.childNodes).find((node) => node.nodeType === 3 && node.textContent?.trim());
}

function linesOfTextNode(node: Text): Box[] {
  const parent = node.parentElement;
  return parent && node === firstTextNode(parent) ? linesOf(parent) : [];
}

function contains(box: Box, x: number, y: number): boolean {
  return box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function isPanel(el: Element): boolean {
  const { overflowY } = styleOf(el);
  return overflowY === "auto" || overflowY === "scroll";
}

/** How far each scrolling box is from where it started: the page's contents moved up by this much. */
type PanelShift = (el: Element) => number;

// The box where the scrolled panels above `el` left it.
function scrolledBox(el: Element, shiftOf: PanelShift): Box {
  const box = boxOf(el);
  let moved = 0;
  for (let panel = el.parentElement; panel; panel = panel.parentElement) moved += shiftOf(panel);
  return toBox([box.left, box.top - moved, box.width, box.height]);
}

// A scrolling box cuts what it holds at its own box: the rest cannot be hit.
function isShownByPanels(el: Element, x: number, y: number, shiftOf: PanelShift): boolean {
  for (let panel = el.parentElement; panel; panel = panel.parentElement) {
    if (isPanel(panel) && !contains(scrolledBox(panel, shiftOf), x, y)) return false;
  }
  return true;
}

function topElementAt(
  document: Document,
  x: number,
  y: number,
  shiftOf: PanelShift
): Element | null {
  let top: Element | null = null;
  let topZ = Number.NEGATIVE_INFINITY;
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const z = Number(el.getAttribute("data-z") ?? 0);
    const hit = contains(scrolledBox(el, shiftOf), x, y) && isShownByPanels(el, x, y, shiftOf);
    if (hit && z >= topZ) {
      top = el;
      topZ = z;
    }
  }
  return top;
}

function nameOf(el: Element): string {
  return el.id ? `#${el.id}` : el.tagName.toLowerCase();
}

function createSignals(options: FakeLayoutPageOptions, calls: string[]): SettleSignals {
  const settle = {
    layoutQuiet: true,
    domQuiet: true,
    animationsSettled: true,
    documentComplete: true,
    ...options.settle,
  };
  // Every signal records that it was awaited and resolves at once with the configured value.
  const signal = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    fontsReady: () => signal("fonts", undefined),
    layoutQuiet: () => signal("layoutQuiet", settle.layoutQuiet),
    domQuiet: () => signal("domQuiet", settle.domQuiet),
    finiteAnimationsSettled: () => signal("animations", settle.animationsSettled),
    frames: () => signal("frames", undefined),
    sleep: () => signal("sleep", undefined),
    documentComplete: () => (calls.push("documentComplete"), settle.documentComplete),
  };
}

export function createFakeLayoutPage(
  bodyHtml: string,
  options: FakeLayoutPageOptions = {}
): FakeLayoutPage {
  const window = new Window();
  window.document.body.innerHTML = bodyHtml;
  const document = window.document as unknown as Document;
  const calls: string[] = [];
  const viewport = options.viewport ?? { width: 1000, height: 800 };
  const firstScrollY = viewport.scrollY ?? 0;
  const scrollHeight = viewport.scrollHeight ?? viewport.height;
  const metrics: PageMetrics = {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scrollY: firstScrollY,
    scrollWidth: viewport.scrollWidth ?? viewport.width,
    scrollHeight,
  };
  let scrollY = firstScrollY;
  const firstScrollTop = (el: Element) => Number(el.getAttribute("data-scroll") ?? 0);
  const scrollTops = new Map<Element, number>();
  const scrollTopOf = (el: Element) => scrollTops.get(el) ?? firstScrollTop(el);
  const shiftOf: PanelShift = (el) => scrollTopOf(el) - firstScrollTop(el);
  const page: LayoutPage = {
    document,
    metrics: () => (calls.push("measure"), { ...metrics, scrollY }),
    box: boxOf,
    style: styleOf,
    renderedText: (el) => el.textContent ?? "",
    textLines: linesOfTextNode,
    elementAt: (x, y) => topElementAt(document, x, y + (scrollY - firstScrollY), shiftOf),
    scrollTo(top) {
      calls.push(`scrollTo ${top}`);
      // The end of the page limits the scroll, as in a browser.
      scrollY = Math.min(Math.max(0, top), Math.max(0, scrollHeight - viewport.height));
      return scrollY;
    },
    scrollTopOf,
    scrollElementTo(el, top) {
      calls.push(`scrollPanel ${nameOf(el)} ${top}`);
      // The end of its content limits the scroll, as in a browser.
      const contentHeight = Number(el.getAttribute("data-scroll-height") ?? 0);
      const reached = Math.min(Math.max(0, top), Math.max(0, contentHeight - boxOf(el).height));
      scrollTops.set(el, reached);
      return reached;
    },
    animatedElements: () => Array.from(document.querySelectorAll("[data-animated]")),
    escapeIdent: (value) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`),
  };
  return {
    page,
    signals: createSignals(options, calls),
    calls,
    byId(id) {
      const el = document.getElementById(id);
      if (!el) throw new Error(`no element #${id}`);
      return el;
    },
    [Symbol.dispose]() {
      window.close();
    },
  };
}

export interface FakeBrowserWindow {
  readonly win: BrowserWindow;
  [Symbol.dispose](): void;
}

/**
 * A happy-dom window typed as the browser window that browserPage.ts reads. happy-dom has no
 * layout, so tests stub the individual browser APIs under test (getAnimations, ResizeObserver,
 * createRange) on the returned window.
 */
export function createFakeBrowserWindow(
  options: { width?: number; height?: number; bodyHtml?: string; url?: string } = {}
): FakeBrowserWindow {
  const window = new Window({
    width: options.width ?? 390,
    height: options.height ?? 844,
    url: options.url,
  });
  window.document.body.innerHTML = options.bodyHtml ?? "";
  return {
    // happy-dom's Window is not structurally the DOM lib's Window & typeof globalThis.
    win: window as unknown as BrowserWindow,
    [Symbol.dispose]() {
      window.close();
    },
  };
}
