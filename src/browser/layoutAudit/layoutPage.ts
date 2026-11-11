// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.

/** A client rectangle. A DOMRect satisfies it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** The computed-style subset the rules read. A real CSSStyleDeclaration satisfies it. */
export type LayoutStyle = Pick<
  CSSStyleDeclaration,
  | "display"
  | "visibility"
  | "contentVisibility"
  | "opacity"
  | "position"
  | "overflowX"
  | "overflowY"
  | "textOverflow"
  | "webkitLineClamp"
  | "whiteSpace"
  | "maskImage"
  | "webkitMaskImage"
  | "clipPath"
  | "clip"
  | "backgroundColor"
  | "borderTopWidth"
  | "borderRightWidth"
  | "borderBottomWidth"
  | "borderLeftWidth"
  | "borderTopLeftRadius"
  | "borderTopRightRadius"
  | "borderBottomRightRadius"
  | "borderBottomLeftRadius"
>;

export interface PageMetrics {
  /** window.innerWidth, else the root's clientWidth, else 0. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly scrollY: number;
  /** The document's scrollable size. */
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

/**
 * Everything a rule needs that only a layout engine can answer. Structure (parentElement,
 * contains, matches, closest, childNodes, getAttribute) is read straight off the Elements: it
 * needs no layout, and happy-dom implements it, so the rules run under bun test against real
 * Elements while geometry comes from fixtures (fakeLayoutPage.testHarness.ts). Only
 * browserPage.ts touches the real window.
 */
export interface LayoutPage {
  readonly document: Document;
  metrics(): PageMetrics;
  box(el: Element): Box;
  style(el: Element): LayoutStyle;
  /** innerText (the rendered text), else textContent. */
  renderedText(el: Element): string;
  /** The rendered line rectangles of one text node, empty ones dropped. */
  textLines(node: Text): Box[];
  elementAt(x: number, y: number): Element | null;
  /**
   * Scrolls the window to `top` at once, whatever the page's `scroll-behavior`, and returns the
   * position it reached: the end of the page limits it. `elementAt`, `box` and `textLines` read
   * the page at that position afterwards.
   */
  scrollTo(top: number): number;
  /** Targets of running or pending animations. */
  animatedElements(): Element[];
  escapeIdent(value: string): string;
}

/** Waiting, kept apart from measuring so the sampling order is tested with fake signals. */
export interface SettleSignals {
  fontsReady(): Promise<void>;
  /** True when no element resized for `quietMs` before `maxMs` ran out. */
  layoutQuiet(quietMs: number, maxMs: number): Promise<boolean>;
  /** True when the DOM was left unchanged for `quietMs` before `maxMs` ran out. */
  domQuiet(quietMs: number, maxMs: number): Promise<boolean>;
  /** True when every finite running animation finished within `maxMs`. */
  finiteAnimationsSettled(maxMs: number): Promise<boolean>;
  frames(count: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  documentComplete(): boolean;
}
