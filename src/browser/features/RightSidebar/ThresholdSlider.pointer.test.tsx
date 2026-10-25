import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThresholdSlider } from "@/browser/features/RightSidebar/ThresholdSlider";
import { installDom } from "../../../../tests/ui/dom";

describe("ThresholdSlider dragging", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("pressing a clamped handle keeps the stored threshold until the drag moves a step", () => {
    const setThreshold = mock((_value: number) => undefined);
    const view = render(
      <TooltipProvider>
        <ThresholdSlider
          config={{
            threshold: 90,
            setThreshold,
            rolloverEnabled: true,
            modelContextLimit: 128_000,
          }}
        />
      </TooltipProvider>
    );
    const container = view.container.firstElementChild as HTMLElement;
    container.getBoundingClientRect = () => new window.DOMRect(0, 0, 1000, 10);
    const handle = container.firstElementChild as HTMLElement;
    const move = (clientX: number) =>
      document.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX }));

    // The handle renders near 85.6%; pressing and jittering inside that snap step saves nothing.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 856 });
    move(858);
    expect(setThreshold).not.toHaveBeenCalled();

    move(800);
    expect(setThreshold).toHaveBeenLastCalledWith(80);
    document.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1 }));
  });
});
