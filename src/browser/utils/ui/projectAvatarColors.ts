/**
 * Colors for the flat sidebar's project monogram avatars: a low-chroma tint of the project color
 * behind a high-contrast letter of the same hue. The math runs in OKLCH so every hue gets the
 * same perceived lightness, and the letter is then pushed away from the background until the pair
 * meets WCAG AA for normal text (4.5:1), whatever color the user typed.
 */

import { resolveSectionColor } from "@/common/constants/ui";

export type ProjectAvatarMode = "dark" | "light";

export interface ProjectAvatarColors {
  background: string;
  foreground: string;
}

/** WCAG AA for normal text; the 11px letter is not "large text". */
const PROJECT_AVATAR_MIN_CONTRAST = 4.5;

interface Oklch {
  l: number;
  c: number;
  h: number;
}

type Rgb = readonly [number, number, number];

// Tuned against the design handoff's dark-mode samples (coder red, xum teal, dogfood green):
// their backgrounds sit near OKLCH lightness 0.28 and chroma 0.03-0.05, their letters near 0.81
// and 0.08-0.12. Light mode mirrors the pattern.
const AVATAR_TONES: Record<
  ProjectAvatarMode,
  {
    background: { l: number; chromaScale: number; maxC: number };
    letter: { l: number; maxC: number };
    step: number;
  }
> = {
  dark: {
    background: { l: 0.28, chromaScale: 0.3, maxC: 0.045 },
    letter: { l: 0.81, maxC: 0.1 },
    step: 0.01,
  },
  light: {
    background: { l: 0.94, chromaScale: 0.3, maxC: 0.04 },
    letter: { l: 0.45, maxC: 0.12 },
    step: -0.01,
  },
};

// Base tone for projects without a configured color: a mid-lightness color of a hashed hue, so
// projects stay apart without the user picking colors.
const HASHED_BASE_TONE = { l: 0.68, c: 0.12 };

function mapRgb(rgb: Rgb, fn: (channel: number) => number): Rgb {
  return [fn(rgb[0]), fn(rgb[1]), fn(rgb[2])];
}

function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(rgb: Rgb): string {
  return `#${[...rgb].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return c * 255;
}

// OKLab conversions from https://bottosson.github.io/posts/oklab/.
function rgbToOklch(rgb: Rgb): Oklch {
  const [r, g, b] = mapRgb(rgb, srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.hypot(labA, labB),
    h: Math.atan2(labB, labA),
  };
}

/** Linear sRGB channels in [0, 1] when in gamut; out-of-gamut values fall outside. */
function oklchToLinearRgb(color: Oklch): Rgb {
  const labA = color.c * Math.cos(color.h);
  const labB = color.c * Math.sin(color.h);
  const l = (color.l + 0.3963377774 * labA + 0.2158037573 * labB) ** 3;
  const m = (color.l - 0.1055613458 * labA - 0.0638541728 * labB) ** 3;
  const s = (color.l - 0.0894841775 * labA - 1.291485548 * labB) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function isInGamut(linear: Rgb): boolean {
  return linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

/** Keeps lightness and hue, and lowers chroma until the color fits sRGB. */
function oklchToRgb(color: Oklch): Rgb {
  let low = 0;
  let high = color.c;
  if (!isInGamut(oklchToLinearRgb(color))) {
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      if (isInGamut(oklchToLinearRgb({ ...color, c: mid }))) low = mid;
      else high = mid;
    }
    high = low;
  }
  const linear = oklchToLinearRgb({ ...color, c: high });
  return mapRgb(linear, (channel) =>
    Math.round(Math.min(255, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, channel))))))
  );
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = mapRgb(rgb, srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getContrastRatio(foregroundHex: string, backgroundHex: string): number {
  const foreground = parseHex(foregroundHex);
  const background = parseHex(backgroundHex);
  if (!foreground || !background) return 1;
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Background and letter colors (opaque `#rrggbb`) for a project avatar. `baseHex` is the
 * project's resolved color; anything unparsable is treated as a neutral gray.
 */
export function getProjectAvatarColors(
  baseHex: string,
  mode: ProjectAvatarMode
): ProjectAvatarColors {
  const base = rgbToOklch(parseHex(baseHex) ?? [128, 128, 128]);
  const tone = AVATAR_TONES[mode];
  const background = toHex(
    oklchToRgb({
      l: tone.background.l,
      c: Math.min(base.c * tone.background.chromaScale, tone.background.maxC),
      h: base.h,
    })
  );
  const letterChroma = Math.min(base.c, tone.letter.maxC);
  let letterL = tone.letter.l;
  let foreground = toHex(oklchToRgb({ l: letterL, c: letterChroma, h: base.h }));
  // Lightness 1 (white) or 0 (black) always clears 4.5:1 against these backgrounds, so the loop
  // ends with a passing letter.
  while (
    getContrastRatio(foreground, background) < PROJECT_AVATAR_MIN_CONTRAST &&
    letterL > 0 &&
    letterL < 1
  ) {
    letterL = Math.min(1, Math.max(0, letterL + tone.step));
    foreground = toHex(oklchToRgb({ l: letterL, c: letterChroma, h: base.h }));
  }
  return { background, foreground };
}

/** The project's configured color when it has one (hex or palette name), else `fallback`. */
export function resolveProjectAvatarColor(
  configured: string | null | undefined,
  fallback: string
): string {
  return configured ? resolveSectionColor(configured) : fallback;
}

/**
 * A stable color for a project without a configured one: the hue comes from an FNV-1a hash of
 * its display name, so the same project gets the same avatar on every load.
 */
export function getHashedProjectColor(name: string): string {
  let hash = 0x811c9dc5;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hue = ((hash % 360) * Math.PI) / 180;
  return toHex(oklchToRgb({ ...HASHED_BASE_TONE, h: hue }));
}

/**
 * The avatar letter: the name's first Unicode letter or digit, uppercased, with up to two of its
 * accents. NFC keeps a decomposed accent on its letter; more marks ("zalgo" text) would stack
 * outside the avatar. An uppercase that expands ("ß" -> "SS", "ŉ" -> "ʼN") keeps only its first
 * capital, since the avatar fits one character.
 */
export function getProjectMonogram(name: string): string {
  const match = /([\p{L}\p{N}])(\p{M}{0,2})/u.exec(name.normalize("NFC"));
  if (match == null) {
    return "#";
  }
  const upper = match[1].toLocaleUpperCase().normalize("NFC");
  const capital = /[\p{Lu}\p{Lt}\p{N}]\p{M}*/u.exec(upper)?.[0] ?? upper;
  return capital + match[2];
}
