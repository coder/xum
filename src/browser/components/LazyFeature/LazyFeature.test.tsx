import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import React from "react";
import { installDom } from "../../../../tests/ui/dom";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import { LazyFeature } from "./LazyFeature";

/** A lazy component whose chunk import the test settles by hand. */
function deferredLazy() {
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const chunk = new Promise<{ default: React.FC }>((resolve, reject) => {
    settle = {
      resolve: () => resolve({ default: () => <div data-testid="lazy-content" /> }),
      reject,
    };
  });
  const loads = { count: 0 };
  const Component = React.lazy(() => {
    loads.count += 1;
    return chunk;
  });
  return { Component, settle, loads };
}

describe("LazyFeature", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows the fallback while the chunk loads, then the feature", async () => {
    const lazy = deferredLazy();
    const view = render(
      <LazyFeature name="Feature" fallback={<div data-testid="pending" />}>
        <lazy.Component />
      </LazyFeature>
    );

    expect(view.getByTestId("pending")).toBeTruthy();
    expect(view.queryByTestId("lazy-content")).toBeNull();

    lazy.settle.resolve();

    expect(await view.findByTestId("lazy-content")).toBeTruthy();
    expect(view.queryByTestId("pending")).toBeNull();
  });

  // A stale tab asks for a chunk the upgraded server no longer has; only a reload recovers.
  test("offers a page reload when the chunk fails to load", async () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => undefined);
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const lazy = deferredLazy();
      const view = render(
        <LazyFeature name="Feature">
          <lazy.Component />
        </LazyFeature>
      );

      lazy.settle.reject(new Error("Failed to fetch dynamic module"));

      fireEvent.click(await view.findByRole("button", { name: "Reload" }));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(view.queryByTestId("lazy-content")).toBeNull();
    } finally {
      reload.mockRestore();
      consoleError.mockRestore();
    }
  });

  // A page-level boundary: the loaded page holds the `main` landmark, so its other states must too.
  test("frame wraps both the loading and the failure state", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const lazy = deferredLazy();
      const view = render(
        <LazyFeature name="Page" fallback="Opening" frame={(state) => <main>{state}</main>}>
          <lazy.Component />
        </LazyFeature>
      );
      expect(view.getByRole("main").textContent).toBe("Opening");

      lazy.settle.reject(new Error("Failed to fetch dynamic module"));

      const reload = await view.findByRole("button", { name: "Reload" });
      expect(view.getAllByRole("main")).toHaveLength(1);
      expect(view.getByRole("main").contains(reload)).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  // #6380: a chunk import started while offline fails, and React.lazy and the browser both keep
  // that failure, so the feature stayed "failed to load" after the reconnect.
  describe.each([...GAP_MODES])("while Xum reconnects (%s)", (mode) => {
    test("a feature opened offline waits for the connection before it loads", async () => {
      const harness = createConnectionHarness(mode, () => ({}));
      await harness.drop();
      const lazy = deferredLazy();
      const view = render(
        <LazyFeature name="Feature" fallback={<div data-testid="pending" />}>
          <lazy.Component />
        </LazyFeature>,
        { wrapper: harness.Wrapper }
      );
      expect(view.getByTestId("pending")).toBeTruthy();
      expect(lazy.loads.count).toBe(0);

      harness.reconnect();
      expect(lazy.loads.count).toBe(1);
      await act(async () => {
        lazy.settle.resolve();
        await Promise.resolve();
      });
      expect(await view.findByTestId("lazy-content")).toBeTruthy();
    });

    // A loaded chunk needs no server: keep showing an open feature, and open a loaded one again.
    test("a loaded feature stays open and opens again while offline", async () => {
      const harness = createConnectionHarness(mode, () => ({}));
      const lazy = deferredLazy();
      const feature = (
        <LazyFeature name="Feature" fallback={<div data-testid="pending" />}>
          <lazy.Component />
        </LazyFeature>
      );
      const first = render(feature, { wrapper: harness.Wrapper });
      await act(async () => {
        lazy.settle.resolve();
        await Promise.resolve();
      });
      await first.findByTestId("lazy-content");

      await harness.drop();
      expect(first.queryByTestId("lazy-content")).not.toBeNull();
      first.unmount();

      const again = render(feature, { wrapper: harness.Wrapper });
      expect(again.queryByTestId("lazy-content")).not.toBeNull();
      expect(again.queryByTestId("pending")).toBeNull();
    });
  });
});
