import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { installInactiveAnimationPause } from "./inactiveAnimations";

describe("installInactiveAnimationPause", () => {
  let cleanupDom: (() => void) | null = null;
  let cleanupPause: (() => void) | null = null;
  let focused = true;
  let hidden = false;

  beforeEach(() => {
    cleanupDom = installDom();
    focused = true;
    hidden = false;
    spyOn(document, "hasFocus").mockImplementation(() => focused);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
  });

  afterEach(() => {
    cleanupPause?.();
    cleanupPause = null;
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("tracks focus and visibility on the document root", () => {
    cleanupPause = installInactiveAnimationPause();
    expect(document.documentElement.hasAttribute("data-renderer-inactive")).toBe(false);

    focused = false;
    window.dispatchEvent(new window.Event("blur"));
    expect(document.documentElement.hasAttribute("data-renderer-inactive")).toBe(true);

    focused = true;
    window.dispatchEvent(new window.Event("focus"));
    expect(document.documentElement.hasAttribute("data-renderer-inactive")).toBe(false);

    hidden = true;
    document.dispatchEvent(new window.Event("visibilitychange"));
    expect(document.documentElement.hasAttribute("data-renderer-inactive")).toBe(true);
  });
});
