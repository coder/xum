// Shared by story plays that guard WCAG text contrast (#4300, #4718).

/** Resolve any computed CSS color (rgb, oklab, color-mix) to sRGB 0-255 + alpha 0-1. */
function toRgba(color: string): [number, number, number, number] {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

function over(
  top: [number, number, number, number],
  bottom: [number, number, number, number]
): [number, number, number, number] {
  const mix = (i: number) => top[i] * top[3] + bottom[i] * (1 - top[3]);
  return [mix(0), mix(1), mix(2), 1];
}

/** WCAG 2.x contrast of an element's text against its composited ancestor backgrounds. */
export function textContrast(element: HTMLElement): number {
  const layers: Array<[number, number, number, number]> = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const bg = toRgba(getComputedStyle(node).backgroundColor);
    if (bg[3] > 0) layers.push(bg);
    if (bg[3] === 1) break;
  }
  const background = layers.reduceRight<[number, number, number, number]>(
    (acc, layer) => over(layer, acc),
    [255, 255, 255, 1]
  );
  const text = over(toRgba(getComputedStyle(element).color), background);
  const luminance = (c: [number, number, number, number]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(text), luminance(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

export interface TokenTextContrast {
  element: HTMLElement;
  token: string;
  text: string;
  ratio: number;
}

/**
 * Contrast of every visible text element under `root` whose color is one of the CSS color
 * tokens in `tokenVars` (for example `--color-muted`). A play can then check a token across a
 * whole screen without naming elements or class names. Elements dimmed with opacity and inactive
 * controls are skipped: their contrast does not come from the token alone (WCAG also exempts
 * inactive controls).
 */
export function tokenTextContrasts(root: HTMLElement, tokenVars: string[]): TokenTextContrast[] {
  const tokenByColor = resolveTokenColors(root.ownerDocument, tokenVars);
  const results: TokenTextContrast[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    const token = tokenByColor.get(getComputedStyle(element).color);
    if (!token) continue;
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    if (!ownText) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (element.closest(":disabled, [aria-disabled='true']")) continue;
    let dimmed = false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || Number(style.opacity) < 1) dimmed = true;
    }
    if (dimmed) continue;
    results.push({ element, token, text: ownText.slice(0, 40), ratio: textContrast(element) });
  }
  return results;
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
