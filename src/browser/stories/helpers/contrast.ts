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
