import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import {
  MAC_TRAFFIC_LIGHTS_INSET,
  WIN_LINUX_OVERLAY_INSET,
  getDesktopPlatform,
  getTitlebarLeftInset,
  getTitlebarRightInset,
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

describe("getTitlebarRightInset", () => {
  test("returns 0 in browser mode (no window.api)", () => {
    clearDesktopApi();

    expect(getTitlebarRightInset()).toBe(0);
  });

  test("returns 0 on darwin in desktop mode", () => {
    enableDesktopApi("darwin");

    expect(getTitlebarRightInset()).toBe(0);
  });

  test("returns 138 on linux in desktop mode", () => {
    enableDesktopApi("linux");

    expect(getTitlebarRightInset()).toBe(WIN_LINUX_OVERLAY_INSET);
  });

  test("returns 138 on win32 in desktop mode", () => {
    enableDesktopApi("win32");

    expect(getTitlebarRightInset()).toBe(WIN_LINUX_OVERLAY_INSET);
  });
});

describe("initTitlebarInsets", () => {
  test("sets CSS custom properties on document.documentElement", () => {
    enableDesktopApi("darwin");

    initTitlebarInsets();

    expect(document.documentElement.style.getPropertyValue("--titlebar-left-inset")).toBe("80px");
    expect(document.documentElement.style.getPropertyValue("--titlebar-right-inset")).toBe("0px");
  });

  test("values match getTitlebarLeftInset/getTitlebarRightInset for current mock", () => {
    enableDesktopApi("linux");

    initTitlebarInsets();

    expect(document.documentElement.style.getPropertyValue("--titlebar-left-inset")).toBe(
      `${getTitlebarLeftInset()}px`
    );
    expect(document.documentElement.style.getPropertyValue("--titlebar-right-inset")).toBe(
      `${getTitlebarRightInset()}px`
    );
  });
});
