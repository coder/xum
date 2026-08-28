import "../../../tests/ui/dom";

import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { createCustomEvent, CUSTOM_EVENTS } from "@/common/constants/events";
import { requestMainRegionFocus, useFocusMainRegion } from "./useFocusMainRegion";

let cleanupDom: (() => void) | null = null;

function FocusTarget(props: { inert?: boolean }) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useFocusMainRegion(targetRef);

  return (
    <div {...(props.inert ? { inert: "" } : {})}>
      <div ref={targetRef} tabIndex={-1} data-testid="main-region" />
    </div>
  );
}

describe("useFocusMainRegion", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("focuses the registered target when the main-region focus event fires", () => {
    const view = render(<FocusTarget />);
    const mainRegion = view.getByTestId("main-region");

    expect(document.activeElement).not.toBe(mainRegion);

    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.FOCUS_MAIN_REGION));

    expect(document.activeElement).toBe(mainRegion);
  });

  it("does not focus a target inside an inert region", () => {
    const view = render(<FocusTarget inert />);
    const mainRegion = view.getByTestId("main-region");

    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.FOCUS_MAIN_REGION));

    expect(document.activeElement).not.toBe(mainRegion);
  });

  it("defers focus requests until after layout updates", () => {
    let requestedFrame = false;
    let focusRequests = 0;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      requestedFrame = true;
      callback(0);
      return 0;
    };
    window.addEventListener(CUSTOM_EVENTS.FOCUS_MAIN_REGION, () => {
      focusRequests += 1;
    });

    requestMainRegionFocus();

    expect(requestedFrame).toBe(true);
    expect(focusRequests).toBe(1);
  });
});
