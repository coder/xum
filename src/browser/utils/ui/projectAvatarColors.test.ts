import { describe, expect, test } from "bun:test";
import { DEFAULT_SECTION_COLOR, SECTION_COLOR_PALETTE } from "@/common/constants/ui";
import {
  getContrastRatio,
  getHashedProjectColor,
  getProjectAvatarColors,
  getProjectMonogram,
} from "./projectAvatarColors";

const HEX = /^#[0-9a-f]{6}$/;

// WCAG 2.x AA for normal text, written out so the bar does not move with the module's constant.
const WCAG_AA_NORMAL_TEXT = 4.5;

// Palette colors, the custom extremes a user can type, and a sweep of hues and lightnesses so
// no mid-tone corner of the color picker escapes the guarantee.
const sweep = Array.from({ length: 24 }, (_, hue) =>
  [0x22, 0x80, 0xdd].map((level) => {
    const channel = (offset: number) =>
      Math.round(level * (0.5 + 0.5 * Math.cos(((hue * 15 + offset) * Math.PI) / 180)));
    return `#${[0, 120, 240].map((offset) => channel(offset).toString(16).padStart(2, "0")).join("")}`;
  })
).flat();
const INPUTS = [...SECTION_COLOR_PALETTE.map(([, hex]) => hex), "#000000", "#ffffff", ...sweep];

// The sweep below measures with getContrastRatio, so pin it to published WCAG values first.
describe("getContrastRatio", () => {
  test.each([
    { foreground: "#000000", background: "#ffffff", ratio: 21 },
    { foreground: "#ffffff", background: "#000000", ratio: 21 },
    { foreground: "#767676", background: "#ffffff", ratio: 4.54 },
    { foreground: "#777777", background: "#ffffff", ratio: 4.48 },
    { foreground: "#ff0000", background: "#ffffff", ratio: 4 },
  ])("$foreground on $background is $ratio:1", ({ foreground, background, ratio }) => {
    expect(getContrastRatio(foreground, background)).toBeCloseTo(ratio, 2);
  });
});

describe("getProjectAvatarColors", () => {
  test.each(["dark", "light"] as const)(
    "every input gets an opaque pair at WCAG AA in %s mode",
    (mode) => {
      const failures = INPUTS.flatMap((input) => {
        const colors = getProjectAvatarColors(input, mode);
        const ratio = getContrastRatio(colors.foreground, colors.background);
        const opaque = HEX.test(colors.background) && HEX.test(colors.foreground);
        return opaque && ratio >= WCAG_AA_NORMAL_TEXT
          ? []
          : [`${input}: ${colors.foreground} on ${colors.background} = ${ratio.toFixed(2)}`];
      });
      expect(failures).toEqual([]);
    }
  );

  test("dark mode backgrounds stay dark and light mode backgrounds stay light", () => {
    // The avatar is a tint of the sidebar, not a saturated chip: a mode mix-up would invert it.
    for (const input of INPUTS) {
      expect(
        getContrastRatio(getProjectAvatarColors(input, "dark").background, "#000000")
      ).toBeLessThan(2);
      expect(
        getContrastRatio(getProjectAvatarColors(input, "light").background, "#ffffff")
      ).toBeLessThan(1.3);
    }
  });
});

describe("getHashedProjectColor", () => {
  test("is stable per name and spreads different names apart", () => {
    expect(getHashedProjectColor("coder")).toBe(getHashedProjectColor("coder"));
    const colors = new Set(["coder", "xum", "dogfood", "docs", "infra"].map(getHashedProjectColor));
    expect(colors.size).toBe(5);
    expect(colors.has(DEFAULT_SECTION_COLOR)).toBe(false);
  });
});

describe("getProjectMonogram", () => {
  test.each([
    { name: "xum", monogram: "X" },
    { name: "  _coder", monogram: "C" },
    { name: "2026 roadmap", monogram: "2" },
    { name: "ñandú", monogram: "Ñ" },
    { name: "", monogram: "#" },
    { name: "---", monogram: "#" },
  ])("$name -> $monogram", ({ name, monogram }) => {
    expect(getProjectMonogram(name)).toBe(monogram);
  });
});
