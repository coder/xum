/**
 * UI integration test: analytics dashboard header respects titlebar-safe inset classes.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

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

async function openAnalyticsAndGetHeader(container: HTMLElement) {
  const analyticsButton = container.querySelector(
    '[data-testid="analytics-button"]'
  )!;
  expect(analyticsButton).not.toBeNull();
  fireEvent.click(analyticsButton);

  let header: HTMLElement | null = null;
  await waitFor(
    () => {
      header = container.querySelector('[data-testid="analytics-header"]')!;
      if (!header) {
        throw new Error("Analytics header not found");
      }
    },
    { timeout: 10_000 }
  );

  return header!;
}

describe("Analytics header titlebar contract", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("browser mode: header keeps titlebar-safe insets and mobile wrapping classes", async () => {
    const app = await createAppHarness({ branchPrefix: "analytics-hdr-browser" });

    try {
      const header = await openAnalyticsAndGetHeader(app.view.container);
      expect(header.classList.contains("titlebar-safe-right")).toBe(true);
      expect(header.classList.contains("titlebar-safe-right-gutter-3")).toBe(true);
      expect(header.classList.contains("flex-wrap")).toBe(true);
      expect(header.classList.contains("py-2")).toBe(true);
      expect(header.classList.contains("md:h-8")).toBe(true);
      expect(header.classList.contains("md:flex-nowrap")).toBe(true);
      expect(header.classList.contains("titlebar-drag")).toBe(false);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("narrow browser mode can reopen the off-canvas left sidebar", async () => {
    const app = await createAppHarness({ branchPrefix: "analytics-sidebar-mobile" });

    try {
      const header = await openAnalyticsAndGetHeader(app.view.container);
      const collapseSidebarButton = app.view.container.querySelector(
        'button[aria-label="Collapse sidebar"]'
      );
      expect(collapseSidebarButton).not.toBeNull();
      fireEvent.click(collapseSidebarButton!);

      const openSidebarButton = await waitFor(() => {
        const button = header.querySelector(
          'button[aria-label="Open sidebar"]'
        );
        if (!button) {
          throw new Error("Analytics sidebar opener not found");
        }
        return button;
      });
      expect(openSidebarButton.classList.contains("mobile-menu-btn")).toBe(true);

      fireEvent.click(openSidebarButton);

      await waitFor(() => {
        expect(document.documentElement.dataset.leftSidebarCollapsed).toBe("false");
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("desktop linux mode: header has h-9, titlebar-drag, and titlebar-safe-right", async () => {
    const app = await createAppHarness({
      branchPrefix: "analytics-hdr-linux",
      beforeRender: () => enableDesktopApi("linux"),
    });

    try {
      const header = await openAnalyticsAndGetHeader(app.view.container);
      expect(header.classList.contains("titlebar-safe-right")).toBe(true);
      expect(header.classList.contains("titlebar-safe-right-gutter-3")).toBe(true);
      expect(header.classList.contains("h-9")).toBe(true);
      expect(header.classList.contains("flex-nowrap")).toBe(true);
      expect(header.classList.contains("titlebar-drag")).toBe(true);
    } finally {
      clearDesktopApi();
      await app.dispose();
    }
  }, 60_000);

  test("desktop darwin mode: header has titlebar-safe-right (no-op on mac, 0px right inset)", async () => {
    const app = await createAppHarness({
      branchPrefix: "analytics-hdr-darwin",
      beforeRender: () => enableDesktopApi("darwin"),
    });

    try {
      const header = await openAnalyticsAndGetHeader(app.view.container);
      expect(header.classList.contains("titlebar-safe-right")).toBe(true);
      expect(header.classList.contains("titlebar-safe-right-gutter-3")).toBe(true);
      expect(header.classList.contains("h-9")).toBe(true);
      expect(header.classList.contains("flex-nowrap")).toBe(true);
      expect(header.classList.contains("titlebar-drag")).toBe(true);
    } finally {
      clearDesktopApi();
      await app.dispose();
    }
  }, 60_000);
});
