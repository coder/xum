import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { LazyHexColorPicker } from "./LazyHexColorPicker";

describe("LazyHexColorPicker", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("loads the real picker and forwards its color changes", async () => {
    const onChange = mock((_color: string) => undefined);
    const view = render(<LazyHexColorPicker color="#ff0000" onChange={onChange} />);

    const hue = await view.findByRole("slider", { name: "Hue" });
    fireEvent.keyDown(hue, { key: "ArrowRight", keyCode: 39, which: 39 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(onChange.mock.calls[0][0]).not.toBe("#ff0000");
  });
});
