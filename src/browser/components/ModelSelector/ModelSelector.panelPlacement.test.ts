import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { getPanelPlacement } from "./ModelSelector";

/**
 * A box with fixed geometry; happy-dom does no layout, and it computes unset overflow as "" rather
 * than "visible", so boxes that must not clip say so.
 */
function box(
  left: number,
  top: number,
  width: number,
  style = "overflow-x: visible"
): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("style", style);
  el.getBoundingClientRect = () => new window.DOMRect(left, top, width, 40);
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  return el;
}

describe("model picker panel placement", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
    document.documentElement.style.overflowX = "visible";
    document.body.style.overflowX = "visible";
  });
  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  // The phone layout: a 382px scrollport (16px padding) below an 88px header, the pill inside.
  function pillIn(scrollerStyle: string, pillLeft: number, pillTop = 560): HTMLElement {
    const scroller = box(0, 88, 382, scrollerStyle);
    const wrapper = box(16, pillTop, 350);
    const pill = box(pillLeft, pillTop, 98);
    wrapper.appendChild(pill);
    scroller.appendChild(wrapper);
    document.body.appendChild(scroller);
    return pill;
  }

  test("moves a panel that would overflow the clipping ancestor back inside it", () => {
    const pill = pillIn("overflow-x: auto; padding: 0 16px", 81);
    // Ends 8px before the scroller's padded right edge: 382 - 16 - 8 = 358.
    expect(81 + 328 + getPanelPlacement(pill, 328).left).toBe(358);
  });

  test("keeps the panel's left edge inside when it cannot fit", () => {
    const pill = pillIn("overflow-x: hidden; padding: 0 16px", 40);
    expect(40 + getPanelPlacement(pill, 400).left).toBe(16);
  });

  test("leaves a panel that fits where it is", () => {
    const pill = pillIn("overflow-x: auto; padding: 0 16px", 20);
    expect(getPanelPlacement(pill, 328).left).toBe(0);
  });

  test("keeps the top below the clipping ancestor's top when the keyboard leaves little room", () => {
    // Keyboard up: the pill moved up to y=179, 91px under the scrollport's top.
    const pill = pillIn("overflow-x: hidden", 20, 179);
    expect(179 - getPanelPlacement(pill, 328).maxHeight).toBe(88 + 8);
  });

  test("outside a clipping ancestor a short window still gets a usable panel", () => {
    const pill = box(20, 170, 98);
    document.body.appendChild(pill);
    expect(getPanelPlacement(pill, 328).maxHeight).toBe(150);
  });
});
