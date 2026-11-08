import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { IOS_STATUS_BAND_HEIGHT_PX } from "@/constants/layout";
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

const frames = async (count: number) => {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
};

/** A vertical scroller with 500px of room, around `child`. */
function wrapInScroller(child: Element, scrollTop: number): HTMLDivElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  scroller.appendChild(child);
  document.body.appendChild(scroller);
  scroller.scrollTop = scrollTop;
  return scroller;
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

/** A touch event at a point, stamped with the point's time (ms) when it has one. */
function touchAt(type: string, point: { x: number; y: number; time?: number }): TouchEvent {
  const event = touch(type, point.x, point.y);
  if (point.time != null) Object.defineProperty(event, "timeStamp", { value: point.time });
  return event;
}

/** A touch as WebKit delivers one in the column: targeted at the root, pointer events first. */
function touchInColumn(path: Array<{ x: number; y: number; time?: number }>) {
  const root = document.documentElement;
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) throw new Error("a touch needs a point");
  const events = [pointer("pointerdown", first.x, first.y), touchAt("touchstart", first)];
  for (const point of path.slice(1)) {
    events.push(pointer("pointermove", point.x, point.y), touchAt("touchmove", point));
  }
  events.push(pointer("pointerup", last.x, last.y), touchAt("touchend", last));
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

  test("gives the column back when the unfold reaches the page after its window resize", () => {
    setStandalone(true);
    const visualViewport = new window.EventTarget();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
    uninstall = installIosCoverColumn();

    window.dispatchEvent(new window.Event("resize"));
    display.current = INNER;
    visualViewport.dispatchEvent(new window.Event("resize"));

    expect(meta.content).toBe(DEVICE_WIDTH_META);
    expect(document.documentElement.style.getPropertyValue(IOS_COVER_COLUMN_PROPERTY)).toBe("");
  });

  describe("a sideways scroll of the page", () => {
    const panPage = () => {
      Object.defineProperty(window, "scrollX", { configurable: true, value: 84 });
      window.dispatchEvent(new window.Event("scroll"));
    };
    const layoutLog: string[] = [];
    let observer: MutationObserver;

    beforeEach(() => {
      setStandalone(true);
      uninstall = installIosCoverColumn();
      layoutLog.length = 0;
      observer = new window.MutationObserver(() => layoutLog.push(meta.content));
      observer.observe(meta, { attributes: true });
    });

    afterEach(() => observer.disconnect());

    // WebKit reveals the caret this way on every keystroke once typing passes the column's edge.
    test("is scrolled back without laying the page out again when the page made it", async () => {
      window.scrollTo = ((x: number) => {
        Object.defineProperty(window, "scrollX", { configurable: true, value: x });
      }) as typeof window.scrollTo;

      for (let keystroke = 0; keystroke < 3; keystroke++) {
        panPage();
        expect(window.scrollX).toBe(0);
        await frames(3);
      }

      await Promise.resolve();
      expect(layoutLog).toEqual([]);
    });

    test("is healed by laying the page out at device width when iOS holds it", async () => {
      window.scrollTo = (() => undefined) as typeof window.scrollTo;

      panPage();
      await frames(2);
      expect(meta.content).toBe(DEVICE_WIDTH_META);

      Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
      await frames(3);
      expect(meta.content).toStartWith("width=466, height=678,");
    });

    test("is scrolled back without a relayout when key repeat reveals the caret every frame", async () => {
      window.scrollTo = ((x: number) => {
        Object.defineProperty(window, "scrollX", { configurable: true, value: x });
      }) as typeof window.scrollTo;

      for (let keystroke = 0; keystroke < 6; keystroke++) {
        panPage();
        await frames(1);
      }
      await frames(3);

      await Promise.resolve();
      expect(layoutLog).toEqual([]);
    });

    test("is healed on time when iOS keeps panning the page back inside the undo window", async () => {
      window.scrollTo = (() => undefined) as typeof window.scrollTo;

      panPage();
      await frames(1);
      panPage();
      await frames(1);
      expect(meta.content).toBe(DEVICE_WIDTH_META);
    });
  });

  test("leaves the pan of a pinch zoom alone", () => {
    setStandalone(true);
    uninstall = installIosCoverColumn();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: { scale: 2 } });

    Object.defineProperty(window, "scrollX", { configurable: true, value: 84 });
    window.dispatchEvent(new window.Event("scroll"));

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
      // Where React listens: the replayed events must bubble up to it.
      for (const type of ["pointerdown", "touchstart", "pointerup", "touchend", "click"]) {
        document.addEventListener(type, (event) => {
          seen.push(`${type} on ${event.target === button ? "button" : "something else"}`);
        });
      }

      const events = touchInColumn([{ x: 430, y: 600 }]);

      expect(hitTests).toContainEqual({ x: 346, y: 600 });
      expect(seen).toEqual([
        "pointerdown on button",
        "touchstart on button",
        "pointerup on button",
        "touchend on button",
        "click on button",
      ]);
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

    test("does not click what the status band hides", () => {
      let clicks = 0;
      button.addEventListener("click", () => clicks++);
      document.elementFromPoint = () => button;

      const events = touchInColumn([{ x: 430, y: IOS_STATUS_BAND_HEIGHT_PX - 1 }]);

      expect(clicks).toBe(0);
      expect(events.some((event) => event.defaultPrevented)).toBe(false);
    });

    test("still clicks a tap that wobbles a little, as fingers do", () => {
      let clicks = 0;
      button.addEventListener("click", () => clicks++);

      touchInColumn([
        { x: 430, y: 600 },
        { x: 433, y: 604 },
      ]);

      expect(clicks).toBe(1);
    });

    test("does not click a press the browser cancelled", () => {
      let clicks = 0;
      button.addEventListener("click", () => clicks++);
      const root = document.documentElement;

      root.dispatchEvent(pointer("pointerdown", 430, 600));
      root.dispatchEvent(touch("touchstart", 430, 600));
      root.dispatchEvent(pointer("pointercancel", 430, 600));
      root.dispatchEvent(touch("touchend", 430, 600));

      expect(clicks).toBe(0);
    });

    test("scrolls what is under the finger, which iOS does not, and cancels the press", () => {
      const scroller = wrapInScroller(button, 300);
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

    test("keeps a flick gliding after the finger lifts, but not a slow drag", async () => {
      const scroller = wrapInScroller(button, 300);

      touchInColumn([
        { x: 430, y: 600, time: 0 },
        { x: 430, y: 630, time: 30 },
        { x: 430, y: 660, time: 60 },
      ]);
      const flickReleasedAt = scroller.scrollTop;
      await frames(3);
      expect(scroller.scrollTop).toBeLessThan(flickReleasedAt);

      touchInColumn([
        { x: 430, y: 600, time: 1000 },
        { x: 430, y: 630, time: 2000 },
        { x: 430, y: 660, time: 3000 },
      ]);
      const dragReleasedAt = scroller.scrollTop;
      await frames(3);
      expect(scroller.scrollTop).toBe(dragReleasedAt);
    });

    test("scrolls the scroller around one that is already at its end", () => {
      const inner = wrapInScroller(button, 0);
      const outer = wrapInScroller(inner, 300);

      touchInColumn([
        { x: 430, y: 600 },
        { x: 430, y: 640 },
        { x: 430, y: 660 },
      ]);

      expect(inner.scrollTop).toBe(0);
      expect(outer.scrollTop).toBeLessThan(300);
    });

    test("stops a glide when a new touch lands left of the column", async () => {
      const scroller = wrapInScroller(button, 300);
      touchInColumn([
        { x: 430, y: 600, time: 0 },
        { x: 430, y: 630, time: 30 },
        { x: 430, y: 660, time: 60 },
      ]);
      await frames(1);

      const root = document.documentElement;
      root.dispatchEvent(pointer("pointerdown", 300, 600));
      root.dispatchEvent(touch("touchstart", 300, 600));
      const stoppedAt = scroller.scrollTop;
      await frames(3);

      expect(scroller.scrollTop).toBe(stoppedAt);
    });

    test("does not click when a second finger joins, as in a pinch", () => {
      let clicks = 0;
      button.addEventListener("click", () => clicks++);
      const root = document.documentElement;
      const column = new window.Touch({ identifier: 7, target: root, clientX: 430, clientY: 600 });
      const other = new window.Touch({ identifier: 8, target: root, clientX: 200, clientY: 300 });
      const send = (type: string, touches: Touch[], changed: Touch) =>
        root.dispatchEvent(
          new window.TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches,
            targetTouches: touches,
            changedTouches: [changed],
          })
        );

      root.dispatchEvent(pointer("pointerdown", 430, 600));
      send("touchstart", [column], column);
      send("touchstart", [column, other], other);
      root.dispatchEvent(pointer("pointerup", 430, 600));
      send("touchend", [other], column);
      send("touchend", [], other);

      expect(clicks).toBe(0);
    });

    test("cancels the press it replayed when a second finger joins", () => {
      const seen: string[] = [];
      for (const type of ["touchstart", "touchcancel", "touchend"]) {
        button.addEventListener(type, (event) => {
          seen.push(`${type}:${(event as TouchEvent).touches.length}`);
        });
      }
      const root = document.documentElement;
      const column = new window.Touch({ identifier: 7, target: root, clientX: 430, clientY: 600 });
      const other = new window.Touch({ identifier: 8, target: root, clientX: 200, clientY: 300 });
      root.dispatchEvent(pointer("pointerdown", 430, 600));
      root.dispatchEvent(
        new window.TouchEvent("touchstart", {
          bubbles: true,
          touches: [column],
          targetTouches: [column],
          changedTouches: [column],
        })
      );
      root.dispatchEvent(
        new window.TouchEvent("touchstart", {
          bubbles: true,
          touches: [column, other],
          targetTouches: [column, other],
          changedTouches: [other],
        })
      );

      // A long-press timer that starts on touchstart stops on the touchcancel.
      expect(seen).toEqual(["touchstart:1", "touchcancel:0"]);
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

  describe("a drag left of the column", () => {
    let target: HTMLDivElement;

    beforeEach(() => {
      setStandalone(true);
      target = document.createElement("div");
      document.body.appendChild(target);
    });

    /** Drags from (200, 300) by (dx, dy); returns whether the move was prevented. */
    function drag(dx: number, dy: number): boolean {
      const start = new window.Touch({ identifier: 1, target, clientX: 200, clientY: 300 });
      const moved = new window.Touch({
        identifier: 1,
        target,
        clientX: 200 + dx,
        clientY: 300 + dy,
      });
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
      return move.defaultPrevented;
    }

    test("is blocked when it would only pan the page sideways", () => {
      uninstall = installIosCoverColumn();

      expect(drag(-80, 4)).toBe(true);
    });

    test("is left to iOS when it scrolls something", () => {
      wrapInScroller(target, 300);
      uninstall = installIosCoverColumn();

      expect(drag(4, -80)).toBe(false);
    });

    test("is left to iOS when a vertical scroll starts with a sideways wobble", () => {
      wrapInScroller(target, 300);
      uninstall = installIosCoverColumn();
      const at = (x: number, y: number) =>
        new window.Touch({ identifier: 1, target, clientX: x, clientY: y });
      const send = (type: string, point: Touch) => {
        const event = new window.TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: [point],
          targetTouches: [point],
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };

      send("touchstart", at(200, 300));
      send("touchmove", at(202, 299));

      expect(send("touchmove", at(203, 260))).toBe(false);
    });

    test("is left to iOS when a vertical drag at a scroller's top turns back up", () => {
      wrapInScroller(target, 0);
      uninstall = installIosCoverColumn();
      const at = (x: number, y: number) =>
        new window.Touch({ identifier: 1, target, clientX: x, clientY: y });
      const send = (type: string, point: Touch) => {
        const event = new window.TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: [point],
          targetTouches: [point],
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };

      send("touchstart", at(200, 300));
      send("touchmove", at(200, 310));

      expect(send("touchmove", at(200, 250))).toBe(false);
    });

    test("is left to iOS on the inner display, which has no column", () => {
      uninstall = installIosCoverColumn();
      display.current = INNER;
      window.dispatchEvent(new window.Event("resize"));

      expect(drag(-80, 4)).toBe(false);
    });
  });
});
