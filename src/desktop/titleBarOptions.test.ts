import { describe, it, expect } from "bun:test";
import { getTitleBarOptions } from "./titleBarOptions";
import { DEFAULT_CHROME_COLOR, TITLEBAR_SYMBOL_COLOR } from "@/common/constants/chromeColors";

describe("getTitleBarOptions", () => {
  it("returns hiddenInset for macOS", () => {
    const options = getTitleBarOptions("darwin");
    expect(options.titleBarStyle).toBe("hiddenInset");
    expect(options.titleBarOverlay).toBeUndefined();
  });

  it("returns hidden + titleBarOverlay for Windows", () => {
    const options = getTitleBarOptions("win32");
    expect(options.titleBarStyle).toBe("hidden");
    expect(options.titleBarOverlay).toEqual({
      color: DEFAULT_CHROME_COLOR,
      symbolColor: TITLEBAR_SYMBOL_COLOR,
      height: 32,
    });
  });

  it("returns hidden + titleBarOverlay for Linux", () => {
    const options = getTitleBarOptions("linux");
    expect(options.titleBarStyle).toBe("hidden");
    expect(options.titleBarOverlay).toEqual({
      color: DEFAULT_CHROME_COLOR,
      symbolColor: TITLEBAR_SYMBOL_COLOR,
      height: 32,
    });
  });
});
