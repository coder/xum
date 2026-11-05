import { describe, expect, test } from "bun:test";
import { diagramPixelSize, NARROW_DIAGRAM_WIDTH, type DiagramFrame } from "./mermaidDiagramBox";

function inline(containerWidth: number, userZoom = 1): DiagramFrame {
  return { kind: "inline", containerWidth, userZoom };
}

describe("diagramPixelSize inline", () => {
  test("keeps a small diagram at its measured size", () => {
    expect(diagramPixelSize({ width: 400, height: 200 }, inline(900))).toEqual({
      width: 400,
      height: 200,
    });
  });

  test("caps the height at 300 px and keeps the proportions", () => {
    expect(diagramPixelSize({ width: 600, height: 600 }, inline(900))).toEqual({
      width: 300,
      height: 300,
    });
  });

  test("fits a wide diagram to the container width", () => {
    expect(diagramPixelSize({ width: 1400, height: 200 }, inline(700))).toEqual({
      width: 700,
      height: 100,
    });
  });

  test("takes the smaller of the height cap and the width fit", () => {
    // The width fit alone is 0.5, the height cap alone 0.25.
    expect(diagramPixelSize({ width: 1400, height: 1200 }, inline(700))).toEqual({
      width: 350,
      height: 300,
    });
    // The width fit alone is 0.25, the height cap alone 0.5.
    expect(diagramPixelSize({ width: 2800, height: 600 }, inline(700))).toEqual({
      width: 700,
      height: 150,
    });
  });

  test("an unmeasured container applies the height cap only", () => {
    expect(diagramPixelSize({ width: 2048, height: 1374 }, inline(0))).toEqual({
      width: 447,
      height: 300,
    });
  });

  test("a narrow container keeps the measured size, however large", () => {
    expect(
      diagramPixelSize({ width: 2048, height: 1374 }, inline(NARROW_DIAGRAM_WIDTH - 1))
    ).toEqual({
      width: 2048,
      height: 1374,
    });
  });

  test("a container of one pixel is narrow", () => {
    expect(diagramPixelSize({ width: 2048, height: 1374 }, inline(1))).toEqual({
      width: 2048,
      height: 1374,
    });
  });

  test("a container at the narrow breakpoint is not narrow", () => {
    expect(diagramPixelSize({ width: 2048, height: 1374 }, inline(NARROW_DIAGRAM_WIDTH))).toEqual({
      width: 447,
      height: 300,
    });
  });

  test("zoom multiplies the size the frame allows", () => {
    expect(diagramPixelSize({ width: 600, height: 600 }, inline(900, 2))).toEqual({
      width: 600,
      height: 600,
    });
    expect(diagramPixelSize({ width: 2048, height: 1374 }, inline(326, 0.5))).toEqual({
      width: 1024,
      height: 687,
    });
    expect(diagramPixelSize({ width: 400, height: 200 }, inline(900, 1.1))).toEqual({
      width: 440,
      height: 220,
    });
  });
});

describe("diagramPixelSize dialog", () => {
  test("keeps a diagram that fits 80% of the viewport height at its measured size", () => {
    expect(
      diagramPixelSize({ width: 900, height: 640 }, { kind: "dialog", viewportHeight: 800 })
    ).toEqual({ width: 900, height: 640 });
  });

  test("scales a taller diagram to 80% of the viewport height", () => {
    expect(
      diagramPixelSize({ width: 2048, height: 1374 }, { kind: "dialog", viewportHeight: 800 })
    ).toEqual({ width: 954, height: 640 });
  });

  test("ignores the inline width fit", () => {
    expect(
      diagramPixelSize({ width: 3000, height: 500 }, { kind: "dialog", viewportHeight: 800 })
    ).toEqual({ width: 3000, height: 500 });
  });
});

describe("diagramPixelSize input", () => {
  test("accepts the smallest whole-pixel measured size", () => {
    expect(diagramPixelSize({ width: 1, height: 1 }, inline(900))).toEqual({ width: 1, height: 1 });
  });

  test.each([
    { width: 0, height: 100 },
    { width: 100, height: 0 },
    { width: -1, height: 100 },
    { width: 100, height: -1 },
    { width: Number.NaN, height: 100 },
    { width: 100, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 100 },
    { width: 100, height: Number.POSITIVE_INFINITY },
  ])("refuses the measured size $width x $height", (measured) => {
    expect(() => diagramPixelSize(measured, inline(900))).toThrow(
      "A diagram needs a finite, positive measured size"
    );
  });
});
