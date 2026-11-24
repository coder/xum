import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";

import { getAppProxyBasePathFromPathname, getBrowserBackendBaseUrl } from "./backendBaseUrl";

describe("backendBaseUrl", () => {
  test("getAppProxyBasePathFromPathname() returns null outside /apps/<slug>", () => {
    expect(getAppProxyBasePathFromPathname("/")).toBeNull();
    expect(getAppProxyBasePathFromPathname("/settings")).toBeNull();
    expect(getAppProxyBasePathFromPathname("/@u/ws/app/mux")).toBeNull();
  });

  test("getAppProxyBasePathFromPathname() returns the /.../apps/<slug> prefix", () => {
    expect(getAppProxyBasePathFromPathname("/@u/ws/apps/mux/")).toBe("/@u/ws/apps/mux");
    expect(getAppProxyBasePathFromPathname("/@u/ws/apps/mux")).toBe("/@u/ws/apps/mux");
    expect(getAppProxyBasePathFromPathname("/@u/ws/apps/mux/settings")).toBe("/@u/ws/apps/mux");
  });

  test("getAppProxyBasePathFromPathname() matches the first /apps/<slug> when multiple exist", () => {
    expect(getAppProxyBasePathFromPathname("/@u/ws/apps/mux/projects/apps/other")).toBe(
      "/@u/ws/apps/mux"
    );
  });

  describe("getBrowserBackendBaseUrl()", () => {
    beforeEach(() => {
      saveDomGlobals();
      globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
      globalThis.document = globalThis.window.document;
    });

    afterEach(() => {
      restoreDomGlobals();
    });

    test("returns origin when hosted at root", () => {
      window.location.href = "https://coder.example.com/";
      expect(getBrowserBackendBaseUrl()).toBe("https://coder.example.com");
    });

    test("returns origin + app proxy prefix when hosted under /.../apps/<slug>/", () => {
      window.location.href = "https://coder.example.com/@u/ws/apps/mux/";
      expect(getBrowserBackendBaseUrl()).toBe("https://coder.example.com/@u/ws/apps/mux");
    });

    test("ignores deeper routes under the app proxy prefix", () => {
      window.location.href = "https://coder.example.com/@u/ws/apps/mux/projects/123?x=1";
      expect(getBrowserBackendBaseUrl()).toBe("https://coder.example.com/@u/ws/apps/mux");
    });

    test("does not get confused by nested /apps/ segments in routes", () => {
      window.location.href = "https://coder.example.com/@u/ws/apps/mux/projects/apps/other";
      expect(getBrowserBackendBaseUrl()).toBe("https://coder.example.com/@u/ws/apps/mux");
    });
  });
});
