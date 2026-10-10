// Shared by story plays that guard WCAG text contrast (#4300, #4718).

type Rgba = [number, number, number, number];

/** Resolve any computed CSS color (rgb, oklab, color-mix) to sRGB 0-255 + alpha 0-1. */
function toRgba(color: string): Rgba {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (i: number) => top[i] * top[3] + bottom[i] * (1 - top[3]);
  return [mix(0), mix(1), mix(2), 1];
}

/** Splits a CSS list on top-level commas only: colors such as rgba(...) contain commas too. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

/**
 * The color of a one-color `linear-gradient(c, c)` background image, or null. The review diff
 * paints its review-range highlight this way, on top of the line's tint (#5985). The computed
 * value lists one layer per shorthand layer (`linear-gradient(...), none`); `none` paints nothing.
 */
export function flatGradientColor(backgroundImage: string): Rgba | null {
  const layers = splitTopLevel(backgroundImage).filter((layer) => layer !== "none");
  if (layers.length !== 1) return null;
  const match = /^linear-gradient\((.+)\)$/.exec(layers[0]);
  if (!match) return null;
  const stops = splitTopLevel(match[1]);
  if (stops.length !== 2 || stops[0] !== stops[1]) return null;
  return toRgba(stops[0]);
}

/** The opaque color behind `element`: its own and its ancestors' backgrounds, composited. */
function compositedBackground(element: HTMLElement): Rgba {
  const layers: Rgba[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    // A background image paints above the same element's background color.
    const overlay = flatGradientColor(style.backgroundImage);
    if (overlay && overlay[3] > 0) layers.push(overlay);
    const bg = toRgba(style.backgroundColor);
    if (bg[3] > 0) layers.push(bg);
    if (bg[3] === 1) break;
  }
  return layers.reduceRight<Rgba>((acc, layer) => over(layer, acc), [255, 255, 255, 1]);
}

function contrastRatio(text: Rgba, background: Rgba): number {
  const luminance = (c: Rgba) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(text), luminance(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.x contrast of an element's text against its composited ancestor backgrounds. */
export function textContrast(element: HTMLElement): number {
  const background = compositedBackground(element);
  return contrastRatio(over(toRgba(getComputedStyle(element).color), background), background);
}

/**
 * WCAG 2.x contrast of an element's text on its own (often translucent) background drawn over
 * the opaque color `base`, a computed color string. Lets a play check a tinted chip on every
 * background its row can have (for example the selected row color), not only the current one.
 */
export function textContrastOnBase(element: HTMLElement, base: string): number {
  const style = getComputedStyle(element);
  const background = over(toRgba(style.backgroundColor), toRgba(base));
  return contrastRatio(over(toRgba(style.color), background), background);
}

/** The nearest ancestor of `element` (or itself) whose background is opaque. */
export function opaqueBackgroundOwner(element: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (toRgba(getComputedStyle(node).backgroundColor)[3] === 1) return node;
  }
  return null;
}

/**
 * WCAG 2.x contrast of the CSS color `color` drawn on the background behind `element`. Lets a
 * play check a color value (for example a replacement in a syntax theme) on the backgrounds the
 * app really renders, including tints that only exist on some lines.
 */
export function colorContrastOn(color: string, element: HTMLElement): number {
  const background = compositedBackground(element);
  return contrastRatio(over(toRgba(color), background), background);
}

export interface TextContrast {
  element: HTMLElement;
  text: string;
  ratio: number;
}

/**
 * Contrast of every visible element under `root` (and `root` itself) that has its own text.
 * Elements dimmed with opacity and inactive controls are skipped: their contrast does not come
 * from their color alone (WCAG also exempts inactive controls).
 */
export function textContrasts(root: HTMLElement): TextContrast[] {
  const results: TextContrast[] = [];
  for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    const text = ownVisibleText(element);
    if (text) results.push({ element, text: text.slice(0, 40), ratio: textContrast(element) });
  }
  return results;
}

export interface TokenTextContrast extends TextContrast {
  token: string;
}

/**
 * Contrast of every visible text element under `root` whose color is one of the CSS color
 * tokens in `tokenVars` (for example `--color-muted`). A play can then check a token across a
 * whole screen without naming elements or class names. The same elements as `textContrasts` are
 * skipped.
 */
export function tokenTextContrasts(root: HTMLElement, tokenVars: string[]): TokenTextContrast[] {
  const tokenByColor = resolveTokenColors(root.ownerDocument, tokenVars);
  const results: TokenTextContrast[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    const token = tokenByColor.get(getComputedStyle(element).color);
    if (!token) continue;
    const text = ownVisibleText(element);
    if (!text) continue;
    results.push({ element, token, text: text.slice(0, 40), ratio: textContrast(element) });
  }
  return results;
}

/** The element's own text when it is visible, not dimmed and not an inactive control; else "". */
function ownVisibleText(element: HTMLElement): string {
  const ownText = [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
  if (!ownText) return "";
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return "";
  if (element.closest(":disabled, [aria-disabled='true']")) return "";
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || Number(style.opacity) < 1) return "";
  }
  return ownText;
}

/**
 * Computed color string of each token: the root's custom property, normalized on a canvas to the
 * `rgb(r, g, b)` form that computed `color` values use. It never touches the DOM, because plays
 * call it inside `waitFor`, which re-runs its callback on every DOM mutation.
 */
function resolveTokenColors(doc: Document, tokenVars: string[]): Map<string, string> {
  const rootStyle = getComputedStyle(doc.documentElement);
  const tokenByColor = new Map<string, string>();
  for (const tokenVar of tokenVars) {
    const [r, g, b] = toRgba(rootStyle.getPropertyValue(tokenVar).trim());
    tokenByColor.set(`rgb(${r}, ${g}, ${b})`, tokenVar);
  }
  return tokenByColor;
}
