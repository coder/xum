import { describe, expect, test } from "bun:test";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import {
  classifyMaterialRectEscape,
  classifySevereTextOverflow,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isNearTotalOcclusion,
  materialViewportPx,
  strongest,
} from "./geometry";
import type { Box } from "./layoutPage";

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

const BOX_300x20 = { left: 0, right: 300, top: 0, bottom: 20 };

function textOverflow(
  fragments: Box[],
  boxEdges: { left: number; right: number; top: number; bottom: number },
  overflowX = "hidden",
  overflowY = "hidden",
  isTruncated = false,
) {
  return classifySevereTextOverflow({ fragments, box: boxEdges, overflowX, overflowY, isTruncated });
}

describe("classifySevereTextOverflow", () => {
  test("a line that stays inside its box is not a failure", () => {
    expect(textOverflow([box(0, 0, 300, 20)], BOX_300x20)).toBeNull();
  });

  test("sideways: the pixel floor is 1 px, whatever the share (5 px line: 1 px out is 20%)", () => {
    const line = [box(0, 0, 5, 20)];
    expect(textOverflow(line, { left: 0, right: 4, top: 0, bottom: 20 })).toBeNull();
    expect(textOverflow(line, { left: 0, right: 3, top: 0, bottom: 20 })).toEqual({
      axis: "horizontal",
      overflowPx: 2,
    });
  });

  test("sideways: 19% of the line outside is tolerated, 20% is a failure", () => {
    expect(textOverflow([box(0, 0, 100, 20)], { left: 0, right: 81, top: 0, bottom: 20 })).toBeNull();
    expect(textOverflow([box(0, 0, 100, 20)], { left: 0, right: 80, top: 0, bottom: 20 })).toEqual({
      axis: "horizontal",
      overflowPx: 20,
    });
  });

  test("sideways: a line leaving on the left counts too", () => {
    expect(textOverflow([box(-30, 0, 100, 20)], { left: 0, right: 300, top: 0, bottom: 20 })).toEqual({
      axis: "horizontal",
      overflowPx: 30,
    });
  });

  test("sideways loss needs a clipping box: visible and scrolling boxes are not judged", () => {
    const wide = [box(0, 0, 400, 20)];
    expect(textOverflow(wide, BOX_300x20, "visible", "visible")).toBeNull();
    expect(textOverflow(wide, BOX_300x20, "auto", "visible")).toBeNull();
    expect(textOverflow(wide, BOX_300x20, "clip", "visible")?.axis).toBe("horizontal");
  });

  test("downward: only a line whose center left the box counts", () => {
    // The center of a 20 px line at top 0 is y 10: a box ending at 11 still holds it.
    expect(textOverflow([box(0, 0, 280, 20)], { left: 0, right: 300, top: 0, bottom: 11 })).toBeNull();
    expect(textOverflow([box(0, 0, 280, 20)], { left: 0, right: 300, top: 0, bottom: 9 })).toEqual({
      axis: "vertical",
      overflowPx: 11,
    });
  });

  test("downward: a box that lets text spill (overflow visible) is judged, a scroller is not", () => {
    const wrapped = [box(4, 2, 52, 16), box(4, 20, 50, 16)];
    const frame = { left: 0, right: 62, top: 0, bottom: 24 };
    expect(textOverflow(wrapped, frame, "visible", "visible")).toEqual({ axis: "vertical", overflowPx: 12 });
    expect(textOverflow(wrapped, frame, "visible", "auto")).toBeNull();
    expect(textOverflow(wrapped, frame, "visible", "scroll")).toBeNull();
  });

  test("downward: the pixel floor is 1 px even when the center is out (a 1.5 px high line)", () => {
    const frame = { left: 0, right: 300, top: 0, bottom: 10 };
    // Both lines have their center below the box edge (y 10.25 and 10.5); only 1 and 1.5 px stick out.
    expect(textOverflow([box(0, 9.5, 280, 1.5)], frame)).toBeNull();
    expect(textOverflow([box(0, 9.5, 280, 2)], frame)).toEqual({ axis: "vertical", overflowPx: 1.5 });
  });

  test("the strongest line wins and a tie keeps the first", () => {
    const frame = { left: 0, right: 300, top: 0, bottom: 22 };
    const lines = [box(0, 24, 100, 20), box(0, 30, 100, 20), box(0, 28, 100, 20)];
    expect(textOverflow(lines, frame)).toEqual({ axis: "vertical", overflowPx: 28 });
  });

  test("text the author truncated, and a missing line list, are never failures", () => {
    expect(textOverflow([box(0, 0, 400, 20)], BOX_300x20, "hidden", "hidden", true)).toBeNull();
    expect(textOverflow([], BOX_300x20)).toBeNull();
  });

  test("a line with no size, or with a non-finite edge, is ignored", () => {
    expect(textOverflow([box(400, 0, 0, 20)], BOX_300x20)).toBeNull();
    expect(textOverflow([box(Number.NaN, 0, 100, 20)], BOX_300x20)).toBeNull();
  });
});

describe("classifyMaterialRectEscape", () => {
  const viewport = { left: 0, right: 390, top: 0, bottom: 844 };

  test("names the side that was left and how far", () => {
    expect(
      classifyMaterialRectEscape({ rect: box(-30, 0, 100, 40), boundary: viewport, axes: ["horizontal"] }),
    ).toEqual({ axis: "horizontal", side: "start", overflowPx: 30 });
    expect(
      classifyMaterialRectEscape({ rect: box(350, 0, 80, 40), boundary: viewport, axes: ["horizontal"] }),
    ).toEqual({ axis: "horizontal", side: "end", overflowPx: 40 });
  });

  test("an escape of 3 px is tolerated, 4 px is a failure (center inside, share over 20%)", () => {
    // 20 px wide: 3 px is 15%, 4 px is 20%, so the pixel floor and the share agree here.
    expect(classifyMaterialRectEscape({ rect: box(373, 0, 20, 20), boundary: viewport })).toBeNull();
    expect(classifyMaterialRectEscape({ rect: box(374, 0, 20, 20), boundary: viewport })).toEqual({
      axis: "horizontal",
      side: "end",
      overflowPx: 4,
    });
  });

  test("a big rect escaping by 19% is tolerated, by 20% is a failure, though both exceed 4 px", () => {
    // 200 px wide, so 38 px out is 19% and 40 px out is 20%.
    expect(classifyMaterialRectEscape({ rect: box(228, 0, 200, 20), boundary: viewport })).toBeNull();
    expect(classifyMaterialRectEscape({ rect: box(230, 0, 200, 20), boundary: viewport })).toEqual({
      axis: "horizontal",
      side: "end",
      overflowPx: 40,
    });
  });

  test("a rect that is mostly outside counts, however small", () => {
    // 10 px wide, all of it out: its center (x 395) is past the edge.
    expect(
      classifyMaterialRectEscape({ rect: box(390, 0, 10, 10), boundary: viewport, axes: ["horizontal"] }),
    ).toEqual({ axis: "horizontal", side: "end", overflowPx: 10 });
  });

  test("a minimum other than 4 px replaces the floor, and the larger axis wins a tie to the first", () => {
    const rect = box(380, 830, 20, 28); // 10 px out on the right, 14 px out below
    expect(classifyMaterialRectEscape({ rect, boundary: viewport, minOutsidePx: 11 })).toEqual({
      axis: "vertical",
      side: "end",
      overflowPx: 14,
    });
    const diagonal = box(380, 834, 20, 20); // 10 px out on both axes
    expect(classifyMaterialRectEscape({ rect: diagonal, boundary: viewport })?.axis).toBe("horizontal");
  });

  test("equal overflow on both sides reads as the start", () => {
    // 200 px out on each side of a 790 px wide rect: 51% outside, center inside.
    const spanning = box(-200, 0, 790, 40);
    expect(
      classifyMaterialRectEscape({ rect: spanning, boundary: viewport, axes: ["horizontal"] }),
    ).toEqual({ axis: "horizontal", side: "start", overflowPx: 200 });
  });

  test("only the axes asked for are judged, from the edges given", () => {
    const below = box(0, 900, 100, 40);
    expect(classifyMaterialRectEscape({ rect: below, boundary: viewport, axes: ["horizontal"] })).toBeNull();
    // A page-height rect has no left or right, and a boundary of two edges is enough.
    expect(
      classifyMaterialRectEscape({
        rect: { top: 1000, bottom: 1040, height: 40 },
        boundary: { top: 0, bottom: 990 },
        axes: ["vertical"],
      }),
    ).toEqual({ axis: "vertical", side: "end", overflowPx: 50 });
  });

  test("a rect with no size or a missing edge cannot be judged", () => {
    expect(classifyMaterialRectEscape({ rect: box(400, 0, 0, 0), boundary: viewport })).toBeNull();
    expect(classifyMaterialRectEscape({ rect: { top: 0, bottom: 10 }, boundary: viewport, axes: ["horizontal"] })).toBeNull();
  });
});

describe("page overflow", () => {
  test("at 390 px the floor is 24 px: 23 px is cosmetic, 24 px is material", () => {
    expect(materialViewportPx(390)).toBe(24);
    expect(isMaterialPageOverflow({ overflowPx: 23, viewportWidth: 390, hasEscapedContent: true })).toBe(false);
    expect(isMaterialPageOverflow({ overflowPx: 24, viewportWidth: 390, hasEscapedContent: true })).toBe(true);
  });

  test("on a wide viewport the floor is 5% of its width", () => {
    expect(materialViewportPx(1440)).toBe(72);
    expect(isMaterialPageOverflow({ overflowPx: 71, viewportWidth: 1440, hasEscapedContent: true })).toBe(false);
    expect(isMaterialPageOverflow({ overflowPx: 72, viewportWidth: 1440, hasEscapedContent: true })).toBe(true);
  });

  test("a scroll width alone, with no content past the edge, is never a failure", () => {
    expect(isMaterialPageOverflow({ overflowPx: 252, viewportWidth: 390, hasEscapedContent: false })).toBe(false);
  });
});

describe("findStableLayoutFindings", () => {
  const finding = (
    rule: LayoutAuditPageFinding["rule"],
    selector: string,
    axis: LayoutAuditPageFinding["axis"],
    overflowPx = 10,
  ): LayoutAuditPageFinding => ({ rule, selector, axis, overflowPx });

  test("keeps the findings of the second sample that the first also holds", () => {
    const stable = finding("page-horizontal-overflow", "html", "horizontal");
    const first = [stable, finding("clipped-text", ".moving", "horizontal")];
    const second = [stable, finding("clipped-text", ".late", "vertical")];
    expect(findStableLayoutFindings(first, second)).toEqual([stable]);
  });

  test("the rule, the selector and the axis each make a different finding; the size does not", () => {
    const first = [finding("clipped-text", "p", "horizontal", 12)];
    expect(findStableLayoutFindings(first, [finding("clipped-text", "p", "horizontal", 40)])).toHaveLength(1);
    expect(findStableLayoutFindings(first, [finding("clipped-control", "p", "horizontal")])).toEqual([]);
    expect(findStableLayoutFindings(first, [finding("clipped-text", "div", "horizontal")])).toEqual([]);
    expect(findStableLayoutFindings(first, [finding("clipped-text", "p", "vertical")])).toEqual([]);
  });

  test("returns the second sample's own findings, in its order", () => {
    const a = finding("clipped-text", "a", "horizontal", 1);
    const b = finding("clipped-text", "b", "horizontal", 2);
    expect(findStableLayoutFindings([a, b], [{ ...b, overflowPx: 9 }, { ...a, overflowPx: 8 }])).toEqual([
      { ...b, overflowPx: 9 },
      { ...a, overflowPx: 8 },
    ]);
  });
});

describe("isNearTotalOcclusion", () => {
  test("needs 90% of the samples: 8 of 9 is not enough, 9 of 9 is", () => {
    expect(isNearTotalOcclusion({ occludedSamples: 8, totalSamples: 9 })).toBe(false);
    expect(isNearTotalOcclusion({ occludedSamples: 9, totalSamples: 9 })).toBe(true);
    expect(isNearTotalOcclusion({ occludedSamples: 9, totalSamples: 10 })).toBe(true);
  });

  test("needs at least 5 samples: 4 of 4 is too few, 5 of 5 is enough", () => {
    expect(isNearTotalOcclusion({ occludedSamples: 4, totalSamples: 4 })).toBe(false);
    expect(isNearTotalOcclusion({ occludedSamples: 5, totalSamples: 5 })).toBe(true);
  });
});

describe("strongest", () => {
  test("takes the larger overflow, keeps the first on a tie, and skips a null candidate", () => {
    const a = { overflowPx: 5, name: "a" };
    const b = { overflowPx: 5, name: "b" };
    const c = { overflowPx: 6, name: "c" };
    expect(strongest(null, a)).toBe(a);
    expect(strongest(a, b)).toBe(a);
    expect(strongest(a, c)).toBe(c);
    expect(strongest(c, null)).toBe(c);
    expect(strongest<typeof a>(null, null)).toBeNull();
  });
});
