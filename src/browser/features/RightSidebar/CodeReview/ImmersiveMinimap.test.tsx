import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

import * as immersiveMinimapMath from "./immersiveMinimapMath";
import { ImmersiveMinimap } from "./ImmersiveMinimap";

interface ScrollContainerFixture {
  element: HTMLDivElement;
  getScrollTop: () => number;
}

function createScrollContainerFixture(
  scrollHeight = 1000,
  clientHeight = 250
): ScrollContainerFixture {
  const element = document.createElement("div");
  let scrollTop = 0;

  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (nextValue: number) => {
      scrollTop = nextValue;
    },
  });

  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });

  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });

  return {
    element,
    getScrollTop: () => scrollTop,
  };
}

describe("ImmersiveMinimap", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalGetComputedStyle: typeof globalThis.getComputedStyle;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalGetComputedStyle = globalThis.getComputedStyle;

    const dom = new GlobalWindow({ url: "http://localhost" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.getComputedStyle = globalThis.window.getComputedStyle.bind(globalThis.window);

    const mockContext = {
      clearRect: mock(() => undefined),
      fillRect: mock(() => undefined),
      strokeRect: mock(() => undefined),
      setTransform: mock(() => undefined),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;

    spyOn(globalThis.window.HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (() => mockContext) as unknown as HTMLCanvasElement["getContext"]
    );
    spyOn(
      globalThis.window.HTMLCanvasElement.prototype,
      "getBoundingClientRect"
    ).mockImplementation(() => new globalThis.window.DOMRect(0, 0, 48, 120));
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
  });

  test("renders without crashing when content has diff lines", () => {
    const scrollFixture = createScrollContainerFixture();
    const onSelectLineIndex = mock(() => undefined);

    const view = render(
      <ImmersiveMinimap
        content={"+added line\n-context line\n unchanged line"}
        scrollContainerRef={{ current: scrollFixture.element }}
        activeLineIndex={null}
        onSelectLineIndex={onSelectLineIndex}
        commentLineIndices={new Set<number>()}
      />
    );

    expect(view.getByTestId("immersive-minimap").className).toContain("h-full");
    // Synchronous render — no waitFor needed since parseDiffLines runs during render
    expect(view.getByTestId("immersive-minimap-canvas")).toBeTruthy();
  });

  test("calls parseDiffLines when content changes", () => {
    const parseSpy = spyOn(immersiveMinimapMath, "parseDiffLines");
    const scrollFixture = createScrollContainerFixture();
    const onSelectLineIndex = mock(() => undefined);
    const initialContent = "+line a\n-line b";
    const updatedContent = "+line a\n-line b\n context";

    const view = render(
      <ImmersiveMinimap
        content={initialContent}
        scrollContainerRef={{ current: scrollFixture.element }}
        activeLineIndex={null}
        onSelectLineIndex={onSelectLineIndex}
        commentLineIndices={new Set<number>()}
      />
    );

    expect(parseSpy).toHaveBeenCalledWith(initialContent);

    view.rerender(
      <ImmersiveMinimap
        content={updatedContent}
        scrollContainerRef={{ current: scrollFixture.element }}
        activeLineIndex={null}
        onSelectLineIndex={onSelectLineIndex}
        commentLineIndices={new Set<number>()}
      />
    );

    expect(parseSpy).toHaveBeenCalledWith(updatedContent);
  });

  test("redraws from the latest scroll position when parent bumps redraw nonce", () => {
    const stableLineCategories: immersiveMinimapMath.LineCategory[] = ["add", "remove", "context"];
    spyOn(immersiveMinimapMath, "parseDiffLines").mockImplementation(() => stableLineCategories);
    const getThumbMetricsSpy = spyOn(immersiveMinimapMath, "getThumbMetrics");
    const scrollFixture = createScrollContainerFixture();
    const scrollContainerRef = { current: scrollFixture.element };
    const commentLineIndices = new Set<number>();
    const onSelectLineIndex = mock(() => undefined);

    const renderMinimap = (redrawNonce: number) => (
      <ImmersiveMinimap
        content="+line a\n-line b\n context"
        scrollContainerRef={scrollContainerRef}
        activeLineIndex={null}
        redrawNonce={redrawNonce}
        onSelectLineIndex={onSelectLineIndex}
        commentLineIndices={commentLineIndices}
      />
    );

    const view = render(renderMinimap(0));
    const canvas = view.getByTestId("immersive-minimap-canvas") as HTMLCanvasElement;
    Object.defineProperty(canvas, "clientWidth", { configurable: true, get: () => 48 });
    Object.defineProperty(canvas, "clientHeight", { configurable: true, get: () => 120 });
    getThumbMetricsSpy.mockClear();

    scrollFixture.element.scrollTop = 375;
    view.rerender(renderMinimap(1));

    // Parent reveal scroll happens outside the minimap. The nonce is the contract
    // that forces a hidden pre-reveal canvas redraw using the new scrollTop even
    // when React Compiler keeps parsed line categories stable across renders.
    expect(getThumbMetricsSpy).toHaveBeenCalledWith(375, 1000, 250, 120);
  });

  test("clicking minimap dispatches the mapped line index", () => {
    const scrollFixture = createScrollContainerFixture();
    const onSelectLineIndex = mock(() => undefined);
    const content = [
      "@@ -1,4 +1,4 @@",
      " context one",
      "-old line",
      "+new line",
      " context two",
    ].join("\n");

    const expectedLineCount = immersiveMinimapMath.parseDiffLines(content).length;
    const clickY = 90;
    const expectedLineIndex = immersiveMinimapMath.pointerYToLineIndex(
      clickY,
      120,
      expectedLineCount
    );

    const view = render(
      <ImmersiveMinimap
        content={content}
        scrollContainerRef={{ current: scrollFixture.element }}
        activeLineIndex={null}
        onSelectLineIndex={onSelectLineIndex}
        commentLineIndices={new Set<number>()}
      />
    );

    const canvas = view.getByTestId("immersive-minimap-canvas") as HTMLCanvasElement;

    fireEvent.mouseDown(canvas, {
      clientY: clickY,
      button: 0,
    });

    expect(onSelectLineIndex).toHaveBeenCalledWith(expectedLineIndex);

    const expectedScrollTop = immersiveMinimapMath.scrollTopForLine(
      expectedLineIndex,
      expectedLineCount,
      1000,
      250
    );
    expect(scrollFixture.getScrollTop()).toBe(expectedScrollTop);
  });

  test("returns null for empty content", () => {
    const scrollFixture = createScrollContainerFixture();
    const onSelectLineIndex = mock(() => undefined);

    const view = render(
      <ImmersiveMinimap
        content=""
        scrollContainerRef={{ current: scrollFixture.element }}
        activeLineIndex={null}
        onSelectLineIndex={onSelectLineIndex}
        commentLineIndices={new Set<number>()}
      />
    );

    expect(view.queryByTestId("immersive-minimap")).toBeNull();
  });
});
