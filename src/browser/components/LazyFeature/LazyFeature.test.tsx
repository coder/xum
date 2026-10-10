import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import React from "react";
import { installDom } from "../../../../tests/ui/dom";
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
  return { Component: React.lazy(() => chunk), settle };
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
});
