import { isIosStandaloneWebApp } from "@/browser/utils/env";

/**
 * Takes back the status column of the folded iPhone Duo's cover display for home-screen web apps.
 *
 * That display is 466pt wide, and iOS keeps the right 84pt for its clock and status. iOS 27.2 hides
 * the column from web content: it lays the page out 382pt wide and reports no
 * `env(safe-area-inset-right)` (27.1 reported the column as that inset, which globals.css handles),
 * so the page could not paint there and the whole page lost a fifth of the width. Mike asked for the
 * full width, keeping only the area around the time and status.
 *
 * A numeric viewport width equal to the screen's does lay the page out across all 466pt (with the
 * height pinned too, see `CoverColumnViewport`), but iOS still treats the column as obscured, which
 * breaks four things this module puts back (measured on the iOS 27.2 Duo simulator, from the
 * installed web clip):
 * - WebKit hit-tests nothing past 382pt: a touch there reaches the page with the root as its target,
 *   and no click follows. The column touch bridge finds the element under the finger and replays
 *   the touch's pointer, touch and mouse events and its click on it.
 * - Nothing scrolls for a drag that starts in the column. The bridge scrolls the element under the
 *   finger itself, and keeps a flick gliding.
 * - The page can pan sideways by the column's width (a swipe, a double tap, a tap on the status bar)
 *   and iOS then holds that offset: `scrollTo(0, 0)` is undone within milliseconds. The pan guard
 *   cancels sideways drags that nothing would scroll, and whatever still pans is undone by laying the
 *   page out once at device width.
 * - iOS takes the touches on its clock and status glyphs itself. globals.css keeps that band
 *   (`--ios-cover-column`) clear of controls.
 */

/** Set on <html> while the column is taken back; globals.css reserves the status band from it. */
export const IOS_COVER_COLUMN_PROPERTY = "--ios-cover-column";

// iPad multitasking also lays a page out narrower than the screen, so this is limited to phone
// screens and to a column no wider than a status column.
const MAX_PHONE_SCREEN_WIDTH_PX = 600;
const MAX_STATUS_COLUMN_WIDTH_PX = 120;
/** A touch that moves further than this is a drag, not a tap. */
const TAP_SLOP_PX = 10;
const VIEWPORT_WIDTH = /\bwidth=[^,]*/;
const VIEWPORT_HEIGHT = /,\s*height=[^,]*/;

export interface CoverColumnGeometry {
  /** `screen.width`: the whole display. */
  screenWidth: number;
  /** `clientWidth` at `width=device-width`: the width iOS lays the page out on. */
  layoutWidth: number;
  layoutHeight: number;
  /** `env(safe-area-inset-right)`. */
  reportedRightInset: number;
}

/** The width iOS leaves out of the page's layout, or 0 when there is none to take back. */
export function getCoverColumnWidth(geometry: CoverColumnGeometry): number {
  const column = geometry.screenWidth - geometry.layoutWidth;
  const isPhonePortrait =
    geometry.screenWidth <= MAX_PHONE_SCREEN_WIDTH_PX &&
    geometry.layoutHeight > geometry.layoutWidth;
  const isStatusColumn = column > 0 && column <= MAX_STATUS_COLUMN_WIDTH_PX;
  // A reported inset is the 27.1 model: the page already spans the display.
  return isPhonePortrait && isStatusColumn && geometry.reportedRightInset === 0 ? column : 0;
}

interface ViewportSize {
  width: number;
  height: number;
}

/** Lays the page out at device width, or at a fixed size. */
function setViewportSize(meta: HTMLMetaElement, size: ViewportSize | null): void {
  const width = size ? `width=${size.width}, height=${size.height}` : "width=device-width";
  meta.content = meta.content.replace(VIEWPORT_HEIGHT, "").replace(VIEWPORT_WIDTH, width);
}

function readReportedRightInset(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;height:0;width:env(safe-area-inset-right,0px);visibility:hidden;pointer-events:none";
  document.documentElement.appendChild(probe);
  const inset = probe.getBoundingClientRect().width;
  probe.remove();
  return inset;
}

/** The element under a point in the column, which WebKit's own hit testing never returns. */
function hitTestColumn(x: number, y: number, column: number): Element | null {
  // Shift the page left by the column for one synchronous hit test: nothing paints in between.
  const root = document.documentElement;
  const transform = root.style.getPropertyValue("transform");
  root.style.setProperty("transform", `translateX(-${column}px)`);
  try {
    return document.elementFromPoint(x - column, y);
  } finally {
    if (transform) root.style.setProperty("transform", transform);
    else root.style.removeProperty("transform");
  }
}

function hasScrollRoom(element: Element, horizontal: boolean, delta: number): boolean {
  const style = window.getComputedStyle(element);
  const overflow = horizontal ? style.overflowX : style.overflowY;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  const range = horizontal
    ? element.scrollWidth - element.clientWidth
    : element.scrollHeight - element.clientHeight;
  const position = horizontal ? element.scrollLeft : element.scrollTop;
  // A finger moving left or up scrolls toward the end.
  return range > 1 && (delta < 0 ? position < range - 1 : position > 0);
}

/** The innermost element that a drag along this axis would scroll, from the touched one out. */
function findScroller(
  from: EventTarget | null,
  horizontal: boolean,
  delta: number
): Element | null {
  for (
    let element = from instanceof Element ? from : null;
    element != null && element !== document.documentElement;
    element = element.parentElement
  ) {
    if (hasScrollRoom(element, horizontal, delta)) return element;
  }
  return null;
}

// A flick keeps scrolling and slows down about as fast as UIScrollView's normal rate.
const DECELERATION_PER_MS = 0.998;
const MIN_GLIDE_SPEED_PX_PER_MS = 0.02;
const VELOCITY_WINDOW_MS = 100;

interface ColumnScroll {
  element: Element;
  horizontal: boolean;
  /** The element's scroll position and the finger's position when the scroll began. */
  origin: number;
  start: number;
  samples: Array<{ time: number; finger: number }>;
}

function getScrollPosition(scroll: ColumnScroll): number {
  return scroll.horizontal ? scroll.element.scrollLeft : scroll.element.scrollTop;
}

function setScrollPosition(scroll: ColumnScroll, position: number): void {
  if (scroll.horizontal) scroll.element.scrollLeft = position;
  else scroll.element.scrollTop = position;
}

/** The finger's speed over the last moments of the drag, in px per ms. */
function getReleaseVelocity(scroll: ColumnScroll, now: number): number {
  const recent = scroll.samples.filter((sample) => now - sample.time <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (first == null || last == null || last.time === first.time) return 0;
  return (last.finger - first.finger) / (last.time - first.time);
}

/** Keeps a released scroll moving and slowing down; returns a function that stops it. */
function glide(scroll: ColumnScroll, velocity: number): () => void {
  let speed = velocity;
  let last = performance.now();
  let frame = 0;
  const step = (now: number) => {
    const elapsed = now - last;
    last = now;
    speed *= DECELERATION_PER_MS ** elapsed;
    const before = getScrollPosition(scroll);
    setScrollPosition(scroll, before - speed * elapsed);
    // Stop when it has slowed down or hit an end.
    if (Math.abs(speed) >= MIN_GLIDE_SPEED_PX_PER_MS && getScrollPosition(scroll) !== before) {
      frame = window.requestAnimationFrame(step);
    }
  };
  if (Math.abs(speed) >= MIN_GLIDE_SPEED_PX_PER_MS) frame = window.requestAnimationFrame(step);
  return () => window.cancelAnimationFrame(frame);
}

const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

interface ColumnGesture {
  target: Element;
  x: number;
  y: number;
  pointerId: number;
  /** The last pointer event replayed, the source of the pointercancel a scroll sends. */
  pointer: PointerEvent;
  /** Not a tap any more: it moved past the tap slop, or the page or the browser cancelled it. */
  ended: boolean;
  /** Set once the drag scrolls something; its pointer events then stop. */
  scroll: ColumnScroll | null;
}

interface PanState {
  x: number;
  y: number;
  /** Decided on the first move: whether this drag would pan the page and nothing else. */
  block: boolean | null;
}

function retargetTouches(list: TouchList, target: Element): Touch[] {
  return Array.from(
    list,
    (touch) =>
      new window.Touch({
        identifier: touch.identifier,
        target,
        clientX: touch.clientX,
        clientY: touch.clientY,
        screenX: touch.screenX,
        screenY: touch.screenY,
        pageX: touch.pageX,
        pageY: touch.pageY,
        radiusX: touch.radiusX,
        radiusY: touch.radiusY,
        rotationAngle: touch.rotationAngle,
        force: touch.force,
      })
  );
}

function isColumnTouch(event: PointerEvent, column: number): boolean {
  return (
    column > 0 &&
    event.isPrimary &&
    event.pointerType === "touch" &&
    event.clientX >= window.innerWidth
  );
}

/** The innermost element a drag by (dx, dy) would scroll, and whether along the x axis. */
function findDragScroller(
  from: EventTarget | null,
  dx: number,
  dy: number
): { element: Element; horizontal: boolean } | null {
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const element = findScroller(from, horizontal, horizontal ? dx : dy);
  return element == null ? null : { element, horizontal };
}

/** Moves a column scroll with the finger, which iOS does not. */
function dragColumnScroll(scroll: ColumnScroll, touch: Touch, time: number): void {
  const finger = scroll.horizontal ? touch.clientX : touch.clientY;
  setScrollPosition(scroll, scroll.origin - (finger - scroll.start));
  scroll.samples.push({ time, finger });
}

function listen<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions
): () => void {
  window.addEventListener(type, listener, options);
  return () => window.removeEventListener(type, listener, options);
}

const CAPTURE = { capture: true } as const;
const ACTIVE_CAPTURE = { capture: true, passive: false } as const;

/**
 * Replays touches that start in the column on the element under them, which WebKit does not find
 * (see the module comment), and blocks sideways pans of the page everywhere.
 */
class ColumnTouchBridge {
  private readonly getColumn: () => number;
  private readonly replayed = new WeakSet<Event>();
  private gesture: ColumnGesture | null = null;
  private pan: PanState | null = null;
  private stopGlide: () => void = () => undefined;

  constructor(getColumn: () => number) {
    this.getColumn = getColumn;
  }

  install(): () => void {
    const removers = [
      listen("pointerdown", (event) => this.onPointerDown(event), CAPTURE),
      ...(["pointermove", "pointerup", "pointercancel"] as const).map((type) =>
        listen(type, (event) => this.onPointerFollowUp(event), CAPTURE)
      ),
      listen("touchstart", (event) => this.onTouchStart(event), CAPTURE),
      listen("touchmove", (event) => this.onTouchMove(event), ACTIVE_CAPTURE),
      listen("touchend", (event) => this.onTouchEnd(event), ACTIVE_CAPTURE),
      listen("touchcancel", (event) => this.onTouchEnd(event), ACTIVE_CAPTURE),
    ];
    return () => {
      this.stopGlide();
      for (const remove of removers) remove();
    };
  }

  /** Dispatches a copy on the gesture's element; false when the page cancelled the copy. */
  private dispatchCopy(copy: Event, target: Element): boolean {
    this.replayed.add(copy);
    return target.dispatchEvent(copy);
  }

  private replayPointer(type: string, source: PointerEvent, target: Element): void {
    const copy = new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      pointerId: source.pointerId,
      pointerType: source.pointerType,
      isPrimary: source.isPrimary,
      clientX: source.clientX,
      clientY: source.clientY,
      screenX: source.screenX,
      screenY: source.screenY,
      width: source.width,
      height: source.height,
      pressure: source.pressure,
      button: source.button,
      buttons: source.buttons,
    });
    this.dispatchCopy(copy, target);
  }

  private replayTouch(event: TouchEvent, gesture: ColumnGesture): void {
    // The page must not see the original either: its target is the root.
    event.stopImmediatePropagation();
    const copy = new window.TouchEvent(event.type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      touches: retargetTouches(event.touches, gesture.target),
      targetTouches: retargetTouches(event.targetTouches, gesture.target),
      changedTouches: retargetTouches(event.changedTouches, gesture.target),
    });
    if (!this.dispatchCopy(copy, gesture.target)) gesture.ended = true;
  }

  private dispatchMouse(type: string, gesture: ColumnGesture): boolean {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: gesture.x,
      clientY: gesture.y,
      button: 0,
      buttons: type === "mousedown" ? 1 : 0,
      detail: 1,
    });
    return this.dispatchCopy(event, gesture.target);
  }

  private onPointerDown(event: PointerEvent): void {
    const column = this.getColumn();
    if (this.replayed.has(event) || !isColumnTouch(event, column)) return;
    const target = hitTestColumn(event.clientX, event.clientY, column);
    if (target == null) return;
    this.stopGlide();
    this.gesture = {
      target,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      pointer: event,
      ended: false,
      scroll: null,
    };
    // Radix reads a root-targeted pointerdown as a press outside every open layer and closes it.
    event.stopImmediatePropagation();
    this.replayPointer(event.type, event, target);
  }

  private onPointerFollowUp(event: PointerEvent): void {
    const gesture = this.gesture;
    if (this.replayed.has(event) || gesture?.pointerId !== event.pointerId) return;
    event.stopImmediatePropagation();
    if (gesture.scroll != null) return;
    if (event.type === "pointercancel") gesture.ended = true;
    gesture.pointer = event;
    this.replayPointer(event.type, event, gesture.target);
  }

  /** Starts scrolling a column drag, which iOS does not scroll; null when nothing would. */
  private startColumnScroll(gesture: ColumnGesture, touch: Touch): ColumnScroll | null {
    const scroller = findDragScroller(
      gesture.target,
      touch.clientX - gesture.x,
      touch.clientY - gesture.y
    );
    if (scroller == null) return null;
    // A native scroll cancels the touch's pointer, so the press does not turn into a drag.
    this.replayPointer("pointercancel", gesture.pointer, gesture.target);
    const start = scroller.horizontal ? touch.clientX : touch.clientY;
    const scroll: ColumnScroll = { ...scroller, origin: 0, start, samples: [] };
    scroll.origin = getScrollPosition(scroll);
    return scroll;
  }

  private moveColumnGesture(gesture: ColumnGesture, touch: Touch, event: TouchEvent): void {
    // iOS neither scrolls nor clicks for a touch in the column, and would only pan the page.
    if (event.cancelable) event.preventDefault();
    if (Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) > TAP_SLOP_PX) {
      gesture.ended = true;
    }
    if (gesture.ended && gesture.scroll == null) {
      gesture.scroll = this.startColumnScroll(gesture, touch);
    }
    if (gesture.scroll != null) dragColumnScroll(gesture.scroll, touch, event.timeStamp);
  }

  private onTouchStart(event: TouchEvent): void {
    if (this.replayed.has(event)) return;
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    this.pan = touch ? { x: touch.clientX, y: touch.clientY, block: null } : null;
    if (this.gesture != null) this.replayTouch(event, this.gesture);
  }

  private blockPagePan(touch: Touch, event: TouchEvent): void {
    const pan = this.pan;
    if (pan == null) return;
    if (pan.block === null) {
      const dx = touch.clientX - pan.x;
      const dy = touch.clientY - pan.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      pan.block = findDragScroller(event.target, dx, dy) == null;
    }
    if (pan.block && event.cancelable) event.preventDefault();
  }

  private onTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (this.replayed.has(event) || touch == null || this.getColumn() === 0) return;
    if (this.gesture == null) {
      this.blockPagePan(touch, event);
      return;
    }
    this.moveColumnGesture(this.gesture, touch, event);
    this.replayTouch(event, this.gesture);
  }

  private finishColumnGesture(gesture: ColumnGesture, event: TouchEvent): void {
    if (gesture.scroll != null) {
      this.stopGlide = glide(gesture.scroll, getReleaseVelocity(gesture.scroll, event.timeStamp));
      return;
    }
    if (gesture.ended || event.type === "touchcancel") return;
    // Focus follows an unprevented mousedown, as it does for a native tap. It runs inside the
    // touchend, so iOS still opens the keyboard for it.
    const field = gesture.target.closest<HTMLElement>(TEXT_ENTRY);
    if (this.dispatchMouse("mousedown", gesture)) field?.focus();
    this.dispatchMouse("mouseup", gesture);
    this.dispatchMouse("click", gesture);
  }

  private onTouchEnd(event: TouchEvent): void {
    if (this.replayed.has(event) || event.touches.length > 0) return;
    const gesture = this.gesture;
    this.gesture = null;
    this.pan = null;
    if (gesture == null) return;
    // WebKit's own click for a column tap lands on an element left of the column, or nowhere.
    if (event.cancelable) event.preventDefault();
    this.replayTouch(event, gesture);
    this.finishColumnGesture(gesture, event);
  }
}

// The software keyboard changes innerHeight and the layout height, so the key leaves them out.
function readGeometryKey(): string {
  return `${window.screen.width}:${window.innerWidth}:${window.matchMedia("(orientation: portrait)").matches}`;
}

function isPagePannedSideways(): boolean {
  const zoomed = (window.visualViewport?.scale ?? 1) > 1;
  return window.scrollX !== 0 && !zoomed;
}

/** The viewport size that lays the page out across the column, kept in step with the display. */
class CoverColumnViewport {
  /** The column's width while the page is laid out across it, else 0. */
  column = 0;
  private readonly meta: HTMLMetaElement;
  // A numeric width alone keeps the device's aspect ratio (466x827 here) and leaves the page room
  // to scroll down, so the height is pinned to the device-width layout's height too.
  private size: ViewportSize | null = null;
  private geometryKey = "";
  private healing = false;

  constructor(meta: HTMLMetaElement) {
    this.meta = meta;
  }

  sync(): void {
    const root = document.documentElement;
    setViewportSize(this.meta, null);
    this.column = getCoverColumnWidth({
      screenWidth: window.screen.width,
      layoutWidth: root.clientWidth,
      layoutHeight: root.clientHeight,
      reportedRightInset: readReportedRightInset(),
    });
    this.size = this.column > 0 ? { width: window.screen.width, height: root.clientHeight } : null;
    setViewportSize(this.meta, this.size);
    if (this.size) root.style.setProperty(IOS_COVER_COLUMN_PROPERTY, `${this.column}px`);
    else root.style.removeProperty(IOS_COVER_COLUMN_PROPERTY);
    this.geometryKey = readGeometryKey();
  }

  // Re-laying the page out fires resize too, so only a change of display or orientation syncs.
  onResize(): void {
    if (readGeometryKey() !== this.geometryKey) this.sync();
  }

  // iOS holds a sideways pan against scrollTo; laying the page out at device width clamps the pan
  // back to 0. iOS applies that only from the next frame it draws, so the size returns two frames
  // later (about 50ms on the simulator): in the same task the layout never reaches iOS.
  healPan(): void {
    if (this.size == null || this.healing || !isPagePannedSideways()) return;
    this.healing = true;
    setViewportSize(this.meta, null);
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        this.healing = false;
        setViewportSize(this.meta, this.size);
      })
    );
  }

  dispose(): void {
    setViewportSize(this.meta, null);
    document.documentElement.style.removeProperty(IOS_COVER_COLUMN_PROPERTY);
  }
}

/**
 * Lays the page out across the cover display's status column when iOS leaves the column out (see
 * the module comment). Everywhere else it changes nothing.
 */
export function installIosCoverColumn(): () => void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!isIosStandaloneWebApp() || meta == null) return () => undefined;
  const viewport = new CoverColumnViewport(meta);
  viewport.sync();
  const removers = [
    new ColumnTouchBridge(() => viewport.column).install(),
    listen("resize", () => viewport.onResize()),
    listen("scroll", () => viewport.healPan()),
  ];
  return () => {
    for (const remove of removers) remove();
    viewport.dispose();
  };
}
