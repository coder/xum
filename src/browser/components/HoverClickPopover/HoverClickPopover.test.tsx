import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { HoverClickPopover } from "./HoverClickPopover";

describe("HoverClickPopover hover preview", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("opens when the pointer moves over the trigger, not when the trigger moves under it", () => {
    const view = render(
      <HoverClickPopover content={<p>Preview</p>}>
        <button type="button">Skills</button>
      </HoverClickPopover>
    );
    const trigger = view.getByRole("button", { name: "Skills" });
    // A layout change that slides the trigger under a resting pointer (the header widening as
    // the right sidebar collapses) fires only the boundary events: no pointermove.
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  test("a preview dismissed under the pointer stays closed until the pointer comes back", () => {
    const view = render(
      <HoverClickPopover content={<p>Preview</p>}>
        <button type="button">Skills</button>
      </HoverClickPopover>
    );
    const trigger = view.getByRole("button", { name: "Skills" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    // The first click pins the preview, the second closes it.
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
