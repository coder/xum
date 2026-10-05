import { describe, expect, test } from "bun:test";

import {
  COMPUTER_USE_MAX_LONG_EDGE,
  COMPUTER_USE_MAX_PIXELS,
} from "@/common/constants/computerUse";

import {
  computeDeclaredSize,
  imagePointToInput,
  inputPointToImage,
  pickPrimaryScreenSource,
  screenshotFitsDisplay,
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
  const display = {
    id: 7,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    scaleFactor: 2,
    nativeOrigin: { x: 0, y: 0 },
  };
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

  test("Linux input starts at the display's pixel origin, not its scaled DIP origin", () => {
    // A scale-2 display right of a 1920-pixel scale-1 monitor starts at DIP and pixel x 1920.
    const mixedDpi: CaptureGeometry = {
      ...linux,
      display: {
        ...display,
        bounds: { ...display.bounds, x: 1920 },
        nativeOrigin: { x: 1920, y: 0 },
      },
    };
    expect(imagePointToInput({ x: 360, y: 225 }, mixedDpi)).toEqual({ x: 3360, y: 900 });
    expect(inputPointToImage({ x: 3360, y: 900 }, mixedDpi)).toEqual({ x: 360, y: 225 });
  });

  test.each([[{ x: 720, y: 0 }], [{ x: 0, y: 450 }], [{ x: -1, y: 0 }], [{ x: 1.5, y: 2 }]])(
    "rejects %o outside the 720x450 screenshot or non-integer",
    (point) => {
      expect(() => imagePointToInput(point, darwin)).toThrow(/720x450|integers/);
    }
  );
});

describe("pickPrimaryScreenSource", () => {
  const named = [{ display_id: "7" }, { display_id: "1" }];
  const unnamed = { display_id: "" };

  test.each([
    ["the source matching the primary display", named, 2, "linux", named[1]],
    ["a lone unnamed source on a single display", [unnamed], 1, "linux", unnamed],
    ["a lone unnamed source spanning several displays", [unnamed], 2, "linux", undefined],
    [
      "one of several unnamed sources on a single display",
      [unnamed, { display_id: "" }],
      1,
      "darwin",
      undefined,
    ],
    ["a lone source naming another display", [{ display_id: "7" }], 1, "linux", undefined],
    ["a match among more Linux screens than displays", named, 1, "linux", undefined],
    ["a match among more macOS screens than displays", named, 1, "darwin", named[1]],
  ] as const)("picks %s", (_name, sources, displayCount, platform, expected) => {
    expect(pickPrimaryScreenSource(sources, 1, displayCount, platform)).toBe(expected);
  });
});

describe("screenshotFitsDisplay", () => {
  const display = (width: number, height: number) => ({
    id: 1,
    bounds: { x: 0, y: 0, width, height },
    scaleFactor: 2,
    nativeOrigin: { x: 0, y: 0 },
  });

  test.each([
    ["a uniform resize", 1356, 848, display(2560, 1600), true],
    ["a resize rounded by a pixel", 1330, 864, display(1512, 982), true],
    ["a portrait display", 848, 1356, display(1600, 2560), true],
    ["one monitor of a screen split in two", 678, 848, display(2560, 1600), false],
  ] as const)("%s", (_name, width, height, target, fits) => {
    expect(screenshotFitsDisplay(width, height, target)).toBe(fits);
  });
});
