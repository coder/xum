import { describe, expect, test } from "bun:test";
import {
  diagramPixelSize,
  NARROW_DIAGRAM_WIDTH,
  type DiagramBox,
  type DiagramFrame,
} from "./mermaidDiagramBox";

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
  // The room a 390 x 844 phone and a 1280 x 720 laptop window leave for the drawing.
  const PHONE_ROOM = { width: 231, height: 639 };
  const LAPTOP_ROOM = { width: 1032, height: 528 };
  const STATE_CHART = { width: 2089, height: 1372 };

  function dialog(room: DiagramBox): DiagramFrame {
    return { kind: "dialog", room };
  }

  test.each([
    { name: "a wide chart on a phone", measured: STATE_CHART, room: PHONE_ROOM },
    { name: "a wide chart on a laptop", measured: STATE_CHART, room: LAPTOP_ROOM },
    { name: "a tall chart on a phone", measured: { width: 300, height: 3000 }, room: PHONE_ROOM },
    { name: "a tall chart on a laptop", measured: { width: 300, height: 3000 }, room: LAPTOP_ROOM },
    { name: "a very wide chart", measured: { width: 9000, height: 400 }, room: LAPTOP_ROOM },
  ])("shows the whole of $name", ({ measured, room }) => {
    const box = diagramPixelSize(measured, dialog(room));
    expect(box.width).toBeLessThanOrEqual(room.width);
    expect(box.height).toBeLessThanOrEqual(room.height);
    // One scale gives both sides, up to the rounding of each side to a pixel.
    const lowestScale = Math.max(
      (box.width - 0.5) / measured.width,
      (box.height - 0.5) / measured.height
    );
    const highestScale = Math.min(
      (box.width + 0.5) / measured.width,
      (box.height + 0.5) / measured.height
    );
    expect(lowestScale).toBeLessThanOrEqual(highestScale);
  });

  test("a very wide, short diagram keeps at least one pixel on its short side", () => {
    expect(diagramPixelSize({ width: 100000, height: 100 }, dialog(PHONE_ROOM))).toEqual({
      width: 231,
      height: 1,
    });
  });

  test("the tighter axis decides the scale", () => {
    expect(diagramPixelSize(STATE_CHART, dialog(PHONE_ROOM))).toEqual({ width: 231, height: 152 });
    expect(diagramPixelSize({ width: 300, height: 3000 }, dialog(PHONE_ROOM))).toEqual({
      width: 64,
      height: 639,
    });
  });

  test("a diagram that fits the room keeps its measured size", () => {
    expect(diagramPixelSize({ width: 1032, height: 528 }, dialog(LAPTOP_ROOM))).toEqual({
      width: 1032,
      height: 528,
    });
    expect(diagramPixelSize({ width: 200, height: 100 }, dialog(LAPTOP_ROOM))).toEqual({
      width: 200,
      height: 100,
    });
  });

  test("a diagram one pixel too large for the room shrinks", () => {
    expect(diagramPixelSize({ width: 1033, height: 528 }, dialog(LAPTOP_ROOM)).width).toBe(1032);
    expect(diagramPixelSize({ width: 1032, height: 529 }, dialog(LAPTOP_ROOM)).height).toBe(528);
  });

  test("a room that is not measured yet leaves the natural size", () => {
    expect(diagramPixelSize(STATE_CHART, dialog({ width: 0, height: 0 }))).toEqual(STATE_CHART);
  });

  test("a side that is not measured yet does not limit the diagram", () => {
    expect(diagramPixelSize(STATE_CHART, dialog({ width: 0, height: 686 }))).toEqual({
      width: 1045,
      height: 686,
    });
    expect(diagramPixelSize(STATE_CHART, dialog({ width: 1044, height: 0 }))).toEqual({
      width: 1044,
      height: 686,
    });
  });

  test("a room one pixel wide or high still limits the diagram", () => {
    expect(diagramPixelSize(STATE_CHART, dialog({ width: 1, height: 1000 }))).toEqual({
      width: 1,
      height: 1,
    });
    expect(diagramPixelSize(STATE_CHART, dialog({ width: 1000, height: 1 }))).toEqual({
      width: 2,
      height: 1,
    });
  });

  test.each([
    { width: -1, height: 800 },
    { width: 390, height: -1 },
    { width: Number.NaN, height: 800 },
    { width: 390, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 800 },
    { width: 390, height: Number.POSITIVE_INFINITY },
  ])("refuses the room $width x $height", (room) => {
    expect(() => diagramPixelSize(STATE_CHART, dialog(room))).toThrow(
      "The expand dialog needs a finite, non-negative room"
    );
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
