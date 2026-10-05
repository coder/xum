import {
  COMPUTER_USE_MAX_LONG_EDGE,
  COMPUTER_USE_MAX_PIXELS,
} from "@/common/constants/computerUse";

export type ComputerUsePlatform = "darwin" | "linux";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Primary display as Electron reports it: bounds in DIP (macOS points), plus the scale factor. */
export interface DisplayInfo {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

/** What a screenshot looked like when it was taken; later coordinates map through it. */
export interface CaptureGeometry {
  platform: ComputerUsePlatform;
  imageWidth: number;
  imageHeight: number;
  display: DisplayInfo;
}

export interface Point {
  x: number;
  y: number;
}

/** Screenshot size for a display of the given logical size, keeping its aspect ratio. */
export function computeDeclaredSize(
  width: number,
  height: number
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  const scale = Math.min(
    1,
    COMPUTER_USE_MAX_LONG_EDGE / longEdge,
    Math.sqrt(COMPUTER_USE_MAX_PIXELS / (width * height))
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Input coordinates are what the OS injection API expects: CGEvent global points on macOS,
 * physical root-window pixels for XTest on Linux.
 */
function inputScale(capture: CaptureGeometry): number {
  return capture.platform === "linux" ? capture.display.scaleFactor : 1;
}

export function imagePointToInput(point: Point, capture: CaptureGeometry): Point {
  const { imageWidth, imageHeight } = capture;
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
    throw new Error(`Coordinates must be integers, got (${point.x}, ${point.y}).`);
  }
  if (point.x < 0 || point.x >= imageWidth || point.y < 0 || point.y >= imageHeight) {
    throw new Error(
      `Coordinates (${point.x}, ${point.y}) are outside the ${imageWidth}x${imageHeight} screenshot. ` +
        `Use 0 <= x < ${imageWidth} and 0 <= y < ${imageHeight}.`
    );
  }
  const { bounds } = capture.display;
  const scale = inputScale(capture);
  return {
    x: Math.round((bounds.x + (point.x * bounds.width) / imageWidth) * scale),
    y: Math.round((bounds.y + (point.y * bounds.height) / imageHeight) * scale),
  };
}

/** Inverse of imagePointToInput; null when the point is not on the captured display. */
export function inputPointToImage(point: Point, capture: CaptureGeometry): Point | null {
  const { bounds } = capture.display;
  const scale = inputScale(capture);
  const x = Math.floor(((point.x / scale - bounds.x) * capture.imageWidth) / bounds.width);
  const y = Math.floor(((point.y / scale - bounds.y) * capture.imageHeight) / bounds.height);
  if (x < 0 || x >= capture.imageWidth || y < 0 || y >= capture.imageHeight) {
    return null;
  }
  return { x, y };
}

/**
 * Whether a screenshot can show exactly this display. Resizing keeps the aspect ratio up to a
 * pixel of rounding per edge; a capture of only part of the screen (one monitor of a screen split
 * into several) does not, and mapping it onto the whole display would put clicks in the wrong place.
 */
export function screenshotFitsDisplay(
  imageWidth: number,
  imageHeight: number,
  display: DisplayInfo
): boolean {
  const { width, height } = display.bounds;
  return Math.abs(imageWidth * height - imageHeight * width) <= width + height;
}

export function isSameDisplay(a: DisplayInfo, b: DisplayInfo): boolean {
  return (
    a.id === b.id &&
    a.scaleFactor === b.scaleFactor &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  );
}

/**
 * The desktopCapturer source showing the primary display. Some Linux setups report no
 * display_id; a lone unnamed source then shows the only display, and anything else is ambiguous.
 */
export function pickPrimaryScreenSource<T extends { display_id: string }>(
  sources: readonly T[],
  primaryDisplayId: number,
  displayCount: number
): T | undefined {
  const match = sources.find((source) => source.display_id === String(primaryDisplayId));
  if (match != null) {
    return match;
  }
  const only = sources.length === 1 ? sources[0] : undefined;
  return displayCount === 1 && only?.display_id === "" ? only : undefined;
}
