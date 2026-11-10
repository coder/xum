import { Window } from "happy-dom";
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
  /** Signal calls and measurements, in the order they happened ("measure" = one page.metrics()). */
  readonly calls: string[];
  byId(id: string): Element;
  [Symbol.dispose](): void;
}

function numbers(attribute: string | null, count: number, what: string): number[] {
  const values = (attribute ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  if (values.length === 0) return Array<number>(count).fill(0);
  if (values.length !== count || values.some(Number.isNaN)) throw new Error(`bad ${what}: ${attribute}`);
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
  return { ...DEFAULT_STYLE, ...overrides };
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

function topElementAt(document: Document, x: number, y: number): Element | null {
  let top: Element | null = null;
  let topZ = Number.NEGATIVE_INFINITY;
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const z = Number(el.getAttribute("data-z") ?? 0);
    if (contains(boxOf(el), x, y) && z >= topZ) {
      top = el;
      topZ = z;
    }
  }
  return top;
}

function createSignals(options: FakeLayoutPageOptions, calls: string[]): SettleSignals {
  const settle = { layoutQuiet: true, domQuiet: true, animationsSettled: true, documentComplete: true, ...options.settle };
  return {
    fontsReady: async () => void calls.push("fonts"),
    layoutQuiet: async () => (calls.push("layoutQuiet"), settle.layoutQuiet),
    domQuiet: async () => (calls.push("domQuiet"), settle.domQuiet),
    finiteAnimationsSettled: async () => (calls.push("animations"), settle.animationsSettled),
    frames: async () => void calls.push("frames"),
    sleep: async () => void calls.push("sleep"),
    documentComplete: () => (calls.push("documentComplete"), settle.documentComplete),
  };
}

export function createFakeLayoutPage(
  bodyHtml: string,
  options: FakeLayoutPageOptions = {},
): FakeLayoutPage {
  const window = new Window();
  window.document.body.innerHTML = bodyHtml;
  const document = window.document as unknown as Document;
  const calls: string[] = [];
  const viewport = options.viewport ?? { width: 1000, height: 800 };
  const metrics: PageMetrics = {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scrollY: viewport.scrollY ?? 0,
    scrollWidth: viewport.scrollWidth ?? viewport.width,
    scrollHeight: viewport.scrollHeight ?? viewport.height,
  };
  const page: LayoutPage = {
    document,
    metrics: () => (calls.push("measure"), metrics),
    box: boxOf,
    style: styleOf,
    renderedText: (el) => el.textContent ?? "",
    textLines: linesOfTextNode,
    elementAt: (x, y) => topElementAt(document, x, y),
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
