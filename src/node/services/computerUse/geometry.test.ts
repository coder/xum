import { describe, expect, test } from "bun:test";

import {
  COMPUTER_USE_MAX_LONG_EDGE,
  COMPUTER_USE_MAX_PIXELS,
} from "@/common/constants/computerUse";

import {
  computeDeclaredSize,
  imagePointToInput,
  inputPointToImage,
  type CaptureGeometry,
} from "./geometry";

describe("computeDeclaredSize", () => {
  test.each([
    [1440, 900],
    [3840, 2160],
    [5120, 1440],
    [900, 1600],
  ])("%ix%i fits the screenshot budget and keeps its aspect ratio", (width, height) => {
    const size = computeDeclaredSize(width, height);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(COMPUTER_USE_MAX_LONG_EDGE);
    expect(size.width * size.height).toBeLessThanOrEqual(COMPUTER_USE_MAX_PIXELS * 1.01);
    expect(size.width / size.height).toBeCloseTo(width / height, 2);
  });

  test("small displays are not upscaled", () => {
    expect(computeDeclaredSize(1024, 768)).toEqual({ width: 1024, height: 768 });
  });
});

describe("screenshot <-> input coordinates", () => {
  const display = { id: 7, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 };
  const darwin: CaptureGeometry = {
    platform: "darwin",
    imageWidth: 720,
    imageHeight: 450,
    display,
  };
  const linux: CaptureGeometry = { ...darwin, platform: "linux" };

  test("macOS input uses display points; Linux input uses physical pixels", () => {
    expect(imagePointToInput({ x: 360, y: 225 }, darwin)).toEqual({ x: 720, y: 450 });
    expect(imagePointToInput({ x: 360, y: 225 }, linux)).toEqual({ x: 1440, y: 900 });
    expect(inputPointToImage({ x: 720, y: 450 }, darwin)).toEqual({ x: 360, y: 225 });
    expect(inputPointToImage({ x: 1440, y: 900 }, linux)).toEqual({ x: 360, y: 225 });
  });

  test("display offsets shift input coordinates", () => {
    const offset = { ...darwin, display: { ...display, bounds: { ...display.bounds, x: -1440 } } };
    expect(imagePointToInput({ x: 0, y: 0 }, offset)).toEqual({ x: -1440, y: 0 });
    expect(inputPointToImage({ x: 0, y: 0 }, offset)).toBeNull();
  });

  test.each([[{ x: 720, y: 0 }], [{ x: 0, y: 450 }], [{ x: -1, y: 0 }], [{ x: 1.5, y: 2 }]])(
    "rejects %o outside the 720x450 screenshot or non-integer",
    (point) => {
      expect(() => imagePointToInput(point, darwin)).toThrow(/720x450|integers/);
    }
  );
});
