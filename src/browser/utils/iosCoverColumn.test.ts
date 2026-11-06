import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import {
  getCoverColumnWidth,
  installIosCoverColumn,
  IOS_COVER_COLUMN_PROPERTY,
} from "./iosCoverColumn";

const DEVICE_WIDTH_META =
  "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content";

// The folded iPhone Duo's cover display on iOS 27.2, measured on the simulator's web clip.
const DUO_COVER = { screenWidth: 466, layoutWidth: 382, layoutHeight: 678, reportedRightInset: 0 };

describe("getCoverColumnWidth", () => {
  test("takes back the Duo cover display's status column", () => {
    expect(getCoverColumnWidth(DUO_COVER)).toBe(84);
  });

  test("leaves every layout alone that already spans its screen", () => {
    expect(getCoverColumnWidth({ ...DUO_COVER, screenWidth: 390, layoutWidth: 390 })).toBe(0);
  });

  test("leaves iOS 27.1 alone, which reports the column as an inset", () => {
    expect(getCoverColumnWidth({ ...DUO_COVER, reportedRightInset: 84 })).toBe(0);
  });

  test("leaves iPad multitasking alone, which also lays a page out narrower than the screen", () => {
    expect(getCoverColumnWidth({ ...DUO_COVER, screenWidth: 744, layoutWidth: 660 })).toBe(0);
    expect(getCoverColumnWidth({ ...DUO_COVER, screenWidth: 500, layoutWidth: 320 })).toBe(0);
  });

  test("leaves landscape alone, where a side column is a full-height notch", () => {
    // The Duo's inner display, unfolded: iOS reports the cover display's screen width there.
    expect(
      getCoverColumnWidth({ ...DUO_COVER, layoutWidth: 400, layoutHeight: 380, screenWidth: 466 })
    ).toBe(0);
  });
});

// The Duo's displays as iOS 27.2 lays a web clip out on them at device width. iOS reports the cover
// display's screen width on both, and innerWidth keeps the visible width, which leaves the column
// out.
const COVER = { width: 382, height: 678 };
const INNER = { width: 867, height: 669 };

/** Stands in for iOS: lays the page out at device width or at the viewport meta's size. */
function emulateDuo(meta: HTMLMetaElement) {
  const display = { current: COVER };
  const size = () => {
    const width = /\bwidth=(\d+)/.exec(meta.content);
    const height = /\bheight=(\d+)/.exec(meta.content);
    return {
      width: width ? Number(width[1]) : display.current.width,
      height: height ? Number(height[1]) : display.current.height,
    };
  };
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => size().width });
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => size().height });
  Object.defineProperty(window.screen, "width", {
    configurable: true,
    get: () => DUO_COVER.screenWidth,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    get: () => display.current.width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    get: () => display.current.height,
  });
  window.matchMedia = ((query: string) => ({
    matches: query === "(orientation: portrait)" && display.current.height > display.current.width,
  })) as unknown as typeof window.matchMedia;
  return display;
}

function setStandalone(value: boolean | undefined) {
  Object.defineProperty(window.navigator, "standalone", { configurable: true, get: () => value });
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
}

function touch(type: string, x: number, y: number): TouchEvent {
  const point = new window.Touch({
    identifier: 7,
    target: document.documentElement,
    clientX: x,
    clientY: y,
  });
  const active = type === "touchend" ? [] : [point];
  return new window.TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: active,
    targetTouches: active,
    changedTouches: [point],
  });
}

/** A touch as WebKit delivers one in the column: targeted at the root, pointer events first. */
function touchInColumn(path: Array<{ x: number; y: number }>) {
  const root = document.documentElement;
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) throw new Error("a touch needs a point");
  const events = [pointer("pointerdown", first.x, first.y), touch("touchstart", first.x, first.y)];
  for (const point of path.slice(1)) {
    events.push(pointer("pointermove", point.x, point.y), touch("touchmove", point.x, point.y));
  }
  events.push(pointer("pointerup", last.x, last.y), touch("touchend", last.x, last.y));
  return events.map((event) => {
    root.dispatchEvent(event);
    return event;
  });
}

describe("installIosCoverColumn", () => {
  let cleanupDom: (() => void) | null = null;
  let uninstall: (() => void) | null = null;
  let meta: HTMLMetaElement;
  let display: { current: typeof COVER };

  beforeEach(() => {
    cleanupDom = installDom();
    meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = DEVICE_WIDTH_META;
    document.head.appendChild(meta);
    display = emulateDuo(meta);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    cleanupDom?.();
    cleanupDom = null;
  });

  test("changes nothing outside a home-screen web app", () => {
    setStandalone(undefined);
    uninstall = installIosCoverColumn();

    expect(meta.content).toBe(DEVICE_WIDTH_META);
    expect(document.documentElement.style.getPropertyValue(IOS_COVER_COLUMN_PROPERTY)).toBe("");
  });

  test("lays the page out across the whole cover display and restores it on cleanup", () => {
    setStandalone(true);
    uninstall = installIosCoverColumn();

    // The height too: a width alone keeps the screen's aspect ratio and leaves room to scroll.
    expect(meta.content).toBe(
      "width=466, height=678, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"
    );
    expect(document.documentElement.style.getPropertyValue(IOS_COVER_COLUMN_PROPERTY)).toBe("84px");

    uninstall();
    uninstall = null;
    expect(meta.content).toBe(DEVICE_WIDTH_META);
    expect(document.documentElement.style.getPropertyValue(IOS_COVER_COLUMN_PROPERTY)).toBe("");
  });

  test("gives the column back on the inner display and takes it again on the cover display", () => {
    setStandalone(true);
    uninstall = installIosCoverColumn();
    const column = () => document.documentElement.style.getPropertyValue(IOS_COVER_COLUMN_PROPERTY);

    display.current = INNER;
    window.dispatchEvent(new window.Event("resize"));
    expect(meta.content).toBe(DEVICE_WIDTH_META);
    expect(column()).toBe("");

    display.current = COVER;
    window.dispatchEvent(new window.Event("resize"));
    expect(meta.content).toStartWith("width=466, height=678,");
    expect(column()).toBe("84px");
  });

  test("undoes a sideways pan by laying the page out at device width for two frames", async () => {
    setStandalone(true);
    uninstall = installIosCoverColumn();
    const frame = () => new Promise((resolve) => window.requestAnimationFrame(resolve));

    Object.defineProperty(window, "scrollX", { configurable: true, value: 84 });
    window.dispatchEvent(new window.Event("scroll"));
    expect(meta.content).toBe(DEVICE_WIDTH_META);

    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    await frame();
    await frame();
    await frame();
    expect(meta.content).toStartWith("width=466, height=678,");
  });

  describe("a touch in the column", () => {
    let button: HTMLButtonElement;
    let field: HTMLTextAreaElement;
    let hitTests: Array<{ x: number; y: number }>;

    beforeEach(() => {
      setStandalone(true);
      button = document.createElement("button");
      field = document.createElement("textarea");
      document.body.append(button, field);
      hitTests = [];
      // WebKit finds nothing past the visible width; the bridge hit-tests with the page shifted
      // left by the column, so the element under the finger sits 84px further left.
      document.elementFromPoint = (x: number, y: number) => {
        hitTests.push({ x, y });
        if (x !== 430 - 84) return null;
        return y < 300 ? field : button;
      };
      uninstall = installIosCoverColumn();
    });

    test("clicks the element under the finger, and the page never sees the root as the target", () => {
      const seen: string[] = [];
      button.addEventListener("pointerdown", () => seen.push("button pointerdown"));
      button.addEventListener("click", () => seen.push("button click"));
      document.addEventListener("pointerdown", (event) => {
        if (event.target === document.documentElement) seen.push("root pointerdown");
      });

      const events = touchInColumn([{ x: 430, y: 600 }]);

      expect(hitTests).toContainEqual({ x: 346, y: 600 });
      expect(seen).toEqual(["button pointerdown", "button click"]);
      // WebKit's own click for the tap would land somewhere else.
      expect(events.find((event) => event.type === "touchend")?.defaultPrevented).toBe(true);
    });

    test("focuses a text field it taps", () => {
      touchInColumn([{ x: 430, y: 200 }]);

      expect(document.activeElement).toBe(field);
    });

    test("does not click when the finger moves away", () => {
      let clicks = 0;
      button.addEventListener("click", () => clicks++);

      touchInColumn([
        { x: 430, y: 600 },
        { x: 430, y: 640 },
      ]);

      expect(clicks).toBe(0);
    });

    test("scrolls what is under the finger, which iOS does not, and cancels the press", () => {
      const scroller = document.createElement("div");
      scroller.style.overflowY = "auto";
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
      scroller.appendChild(button);
      document.body.appendChild(scroller);
      scroller.scrollTop = 300;
      const seen: string[] = [];
      for (const type of ["pointercancel", "click"]) {
        button.addEventListener(type, () => seen.push(type));
      }

      // Moving the finger down scrolls up, from the point where the touch became a drag.
      touchInColumn([
        { x: 430, y: 600 },
        { x: 430, y: 615 },
        { x: 430, y: 640 },
        { x: 430, y: 660 },
      ]);

      expect(scroller.scrollTop).toBeLessThanOrEqual(300 - 45);
      expect(seen).toEqual(["pointercancel"]);
    });

    test("leaves touches left of the column to WebKit", () => {
      let clicks = 0;
      button.addEventListener("click", () => clicks++);

      const events = touchInColumn([{ x: 300, y: 600 }]);

      expect(hitTests).toEqual([]);
      expect(clicks).toBe(0);
      expect(events.some((event) => event.defaultPrevented)).toBe(false);
    });
  });

  test("blocks a sideways drag that would only pan the page", () => {
    setStandalone(true);
    uninstall = installIosCoverColumn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const start = new window.Touch({ identifier: 1, target, clientX: 200, clientY: 300 });
    const moved = new window.Touch({ identifier: 1, target, clientX: 120, clientY: 304 });

    target.dispatchEvent(
      new window.TouchEvent("touchstart", {
        bubbles: true,
        touches: [start],
        targetTouches: [start],
      })
    );
    const move = new window.TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [moved],
      targetTouches: [moved],
    });
    target.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);
  });
});
