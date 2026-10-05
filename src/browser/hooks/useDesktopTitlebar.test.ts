import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import {
  MAC_TRAFFIC_LIGHTS_INSET,
  getDesktopPlatform,
  getTitlebarLeftInset,
  initTitlebarInsets,
  isDesktopMode,
} from "./useDesktopTitlebar";

function enableDesktopApi(platform: NodeJS.Platform) {
  window.api = {
    platform,
    versions: {},
    getIsRosetta: () => Promise.resolve(false),
  };
}

function clearDesktopApi() {
  delete (window as Window & { api?: unknown }).api;
}

beforeEach(() => {
  saveDomGlobals();
  globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
  globalThis.document = globalThis.window.document;
});

afterEach(() => {
  clearDesktopApi();
  restoreDomGlobals();
});

describe("isDesktopMode", () => {
  test("returns false when window.api is undefined", () => {
    clearDesktopApi();

    expect(isDesktopMode()).toBe(false);
  });

  test("returns false when window.api exists but getIsRosetta is missing", () => {
    window.api = {
      platform: "darwin",
      versions: {},
    };

    expect(isDesktopMode()).toBe(false);
  });

  test("returns true when window.api.getIsRosetta is a function", () => {
    enableDesktopApi("darwin");

    expect(isDesktopMode()).toBe(true);
  });
});

describe("getDesktopPlatform", () => {
  test("returns undefined when window.api is absent", () => {
    clearDesktopApi();

    expect(getDesktopPlatform()).toBeUndefined();
  });

  test("returns the platform string when window.api exists", () => {
    window.api = {
      platform: "linux",
      versions: {},
    };

    expect(getDesktopPlatform()).toBe("linux");
  });
});

describe("getTitlebarLeftInset", () => {
  test("returns 0 in browser mode (no window.api)", () => {
    clearDesktopApi();

    expect(getTitlebarLeftInset()).toBe(0);
  });

  test("returns 80 on darwin in desktop mode", () => {
    enableDesktopApi("darwin");

    expect(getTitlebarLeftInset()).toBe(MAC_TRAFFIC_LIGHTS_INSET);
  });

  test("returns 0 on linux in desktop mode", () => {
    enableDesktopApi("linux");

    expect(getTitlebarLeftInset()).toBe(0);
  });

  test("returns 0 on win32 in desktop mode", () => {
    enableDesktopApi("win32");

    expect(getTitlebarLeftInset()).toBe(0);
  });
});

describe("initTitlebarInsets", () => {
  function insets() {
    const style = document.documentElement.style;
    return {
      left: style.getPropertyValue("--titlebar-left-inset"),
      right: style.getPropertyValue("--titlebar-right-inset"),
    };
  }

  test("reserves the traffic lights on darwin", () => {
    enableDesktopApi("darwin");
    initTitlebarInsets();
    expect(insets()).toEqual({ left: "80px", right: "0px" });
  });

  test("reserves nothing in browser mode", () => {
    clearDesktopApi();
    initTitlebarInsets();
    expect(insets()).toEqual({ left: "0px", right: "0px" });
  });

  for (const platform of ["linux", "win32"] as const) {
    test(`follows the window controls overlay on ${platform}`, () => {
      enableDesktopApi(platform);
      initTitlebarInsets();
      const { left, right } = insets();
      expect(left).toContain("env(titlebar-area-x");
      expect(right).toContain("env(titlebar-area-width");
    });
  }
});
