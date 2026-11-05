import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import * as LazyFeatureModule from "@/browser/components/LazyFeature/LazyFeature";
import { StreamingContext } from "./StreamingContext";
import { Mermaid, sanitizeMermaidSvg } from "./Mermaid";
import { DESKTOP_TITLEBAR_HEIGHT_PX } from "@/browser/hooks/useDesktopTitlebar";
import { dialogDiagramRoom } from "./mermaidDiagramBox";
import { getTranscriptContextMenuMarkdown } from "@/browser/utils/messages/transcriptContextMenu";
import MarkdownIt from "markdown-it";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as PeleModule from "pele";
import { chromiumMathSerializer } from "../../../../tests/ui/chromiumMathSerializer";

const INVALID_CHART = "graph TD\nA-->";

/** The size Pele measured: the diagram's viewBox. */
function viewBoxOf(container: Element | null) {
  const viewBox = container?.querySelector("svg.pele")?.getAttribute("viewBox") ?? "0 0 0 0";
  const [, , width, height] = viewBox.split(" ").map(Number);
  return { width, height };
}

/** The pixel box the stylesheet gives the diagram's <svg>. */
function boxOf(container: Element | null) {
  const style = (container as HTMLElement | null)?.style;
  return {
    width: style?.getPropertyValue("--diagram-width"),
    height: style?.getPropertyValue("--diagram-height"),
  };
}

function pixels(size: { width: number; height: number }) {
  return { width: `${size.width}px`, height: `${size.height}px` };
}

// A top-to-bottom chain: taller than the inline height cap in every container width.
const TALL_CHART = "graph TD\n" + "ABCDEFGHIJKL".split("").join("-->");

function renderMermaid(props: { chart?: string; isStreaming?: boolean } = {}) {
  return render(
    <StreamingContext.Provider value={{ isStreaming: props.isStreaming ?? false }}>
      <Mermaid chart={props.chart ?? "graph TD\nA-->B"} />
    </StreamingContext.Provider>
  );
}

describe("Mermaid layout stability", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalDOMParser: typeof globalThis.DOMParser;
  let originalHTMLElement: typeof globalThis.HTMLElement;
  let originalXMLSerializer: typeof globalThis.XMLSerializer;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalDOMParser = globalThis.DOMParser;
    originalHTMLElement = globalThis.HTMLElement;
    originalXMLSerializer = globalThis.XMLSerializer;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.DOMParser = domWindow.DOMParser;
    globalThis.HTMLElement = domWindow.HTMLElement;
    globalThis.XMLSerializer = chromiumMathSerializer(domWindow.XMLSerializer);
    // happy-dom has no layout: the root element's client size follows the window's, as in a
    // browser without pinch zoom, until a test sets it apart.
    for (const side of ["Width", "Height"] as const) {
      Object.defineProperty(domWindow.document.documentElement, `client${side}`, {
        configurable: true,
        get: () => domWindow[`inner${side}`],
      });
    }
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.DOMParser = originalDOMParser;
    globalThis.HTMLElement = originalHTMLElement;
    globalThis.XMLSerializer = originalXMLSerializer;
  });

  test("markdown's diagram fallback keeps the loaded diagram's frame", async () => {
    // React.lazy caches the Mermaid chunk for the whole process, so whether this render shows the
    // fallback depends on which test files ran first. The spy captures the fallback that
    // MarkdownComponents hands its LazyFeature boundary, and the test renders it on its own.
    const lazyFeature = spyOn(LazyFeatureModule, "LazyFeature");
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <MarkdownRenderer content={"```mermaid\ngraph TD\nA-->B\n```"} />
      </ThemeProvider>
    );
    // Fallback or Mermaid's own pending state: the first frame has the diagram's height.
    expect(view.container.querySelector<HTMLElement>(".mermaid-container")?.style.minHeight).toBe(
      "300px"
    );
    const boundary = lazyFeature.mock.calls.find(([props]) => props.name === "Diagram");
    lazyFeature.mockRestore();
    expect(boundary).toBeDefined();
    const fallbackView = render(
      <ThemeProvider forcedTheme="dark">{boundary?.[0].fallback}</ThemeProvider>
    );

    // The chunk has not loaded yet: no zoom controls, but the same box Mermaid reserves.
    const pending = fallbackView.container.querySelector<HTMLElement>(".mermaid-container");
    expect(within(fallbackView.container).queryAllByRole("button")).toHaveLength(0);
    expect(pending?.style.minHeight).toBe("300px");
    expect(pending?.textContent).toBe("Rendering diagram...");

    expect(await view.findByRole("button", { name: "⤢" })).toBeTruthy();
    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg")).not.toBeNull()
    );
    // Same outer frame before and after the chunk loads, so nothing shifts.
    const loaded = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(loaded?.parentElement?.style.cssText).toBe(pending?.parentElement?.style.cssText);
    expect(loaded?.style.minHeight).toBe("300px");
  });

  test("copies a selected diagram as its source and excludes diagram controls", async () => {
    const chart = "graph TD\nA-->B";
    const view = render(
      <div data-transcript-message>
        <div data-transcript-quote-root>
          <p>Before</p>
          <Mermaid chart={chart} />
          <p>After</p>
        </div>
      </div>
    );
    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg")).not.toBeNull()
    );
    const diagram = view.container.querySelector(".mermaid-container")!;
    const range = document.createRange();
    range.selectNodeContents(diagram);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const options = {
      transcriptRoot: view.container,
      selection,
      target: diagram.querySelector("rect"),
    };
    const copied = getTranscriptContextMenuMarkdown(options)!;
    const parsed = document.createElement("div");
    parsed.innerHTML = new MarkdownIt().render(copied.text);
    expect(parsed.querySelector("code.language-mermaid")?.textContent?.trim()).toBe(chart);
    expect(copied.html).not.toContain("svg");
    expect(
      getTranscriptContextMenuMarkdown({
        ...options,
        target: view.container.querySelector("button"),
      })
    ).toBeNull();

    const first = view.container.querySelector("p")!;
    range.setStart(first.firstChild!, 0);
    range.setEndBefore(diagram.parentElement!);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(getTranscriptContextMenuMarkdown({ ...options, target: first })?.text).toBe("Before");

    range.setEndAfter(diagram.parentElement!);
    selection.removeAllRanges();
    selection.addRange(range);
    const mixed = getTranscriptContextMenuMarkdown({ ...options, target: first })!;
    parsed.innerHTML = new MarkdownIt().render(mixed.text);
    expect(parsed.querySelector("p")?.textContent).toBe("Before");
    expect(parsed.querySelector("code.language-mermaid")?.textContent?.trim()).toBe(chart);
    expect(parsed.textContent).not.toContain("After");
  });

  test("copies the displayed chart during pending and invalid streaming updates", async () => {
    const first = "graph TD\nA-->B";
    const next = INVALID_CHART;
    const renderContent = (chart: string) => (
      <ThemeProvider forcedTheme="dark">
        <StreamingContext.Provider value={{ isStreaming: true }}>
          <div data-transcript-message>
            <div data-transcript-quote-root>
              <MarkdownRenderer content={"```mermaid\n" + chart + "\n```"} />
            </div>
          </div>
        </StreamingContext.Provider>
      </ThemeProvider>
    );
    const view = render(renderContent(first));
    const copySource = () => {
      const diagram = view.container.querySelector(".mermaid-container")!;
      const range = document.createRange();
      range.selectNodeContents(diagram);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const copied = getTranscriptContextMenuMarkdown({
        transcriptRoot: view.container,
        selection,
        target: diagram,
      })!;
      const parsed = document.createElement("div");
      parsed.innerHTML = new MarkdownIt().render(copied.text);
      return parsed.querySelector("code.language-mermaid")?.textContent?.trim();
    };
    await waitFor(() => expect(view.container.querySelector("svg")).not.toBeNull());
    expect(copySource()).toBe(first);
    const peleRender = spyOn(PeleModule, "render");
    // Before the debounce fires the new chart is pending; after it, the chart fails to parse.
    view.rerender(renderContent(next));
    expect(copySource()).toBe(first);
    await waitFor(() => expect(peleRender).toHaveBeenCalledWith(next + "\n", expect.anything()));
    peleRender.mockRestore();
    expect(copySource()).toBe(first);
    // The last valid diagram stays on screen while the stream is mid-chart.
    expect(view.container.querySelector(".mermaid-container svg.pele")).not.toBeNull();

    const third = "graph TD\nC-->D";
    view.rerender(renderContent(third));
    await waitFor(() => expect(copySource()).toBe(third));
    const pasted = render(renderContent(copySource()!));
    await waitFor(() =>
      expect(pasted.container.querySelector(".mermaid-container svg")).not.toBeNull()
    );
  });

  describe("the Close button of the expand dialog", () => {
    const topPx = (button: HTMLElement) => Number(/calc\((\d+)px/.exec(button.style.top)?.[1]);

    test("starts below the desktop title bar, which holds the native window controls", async () => {
      Object.assign(window, { api: { getIsRosetta: () => Promise.resolve(false) } });
      const view = renderMermaid();
      fireEvent.click(await view.findByRole("button", { name: "⤢" }));
      const close = await view.findByRole("button", { name: "Close" });
      // An 8 px gutter below the bar.
      expect(topPx(close)).toBe(DESKTOP_TITLEBAR_HEIGHT_PX + 8);
      expect(close.classList.contains("titlebar-no-drag")).toBe(true);
    });

    test("keeps an 8 px gutter from the top in a browser", async () => {
      const view = renderMermaid();
      fireEvent.click(await view.findByRole("button", { name: "⤢" }));
      const close = await view.findByRole("button", { name: "Close" });
      expect(topPx(close)).toBe(8);
      expect(close.classList.contains("titlebar-no-drag")).toBe(false);
    });
  });

  test("guest Escape cannot close an expanded host diagram", async () => {
    const view = renderMermaid();
    fireEvent.click(await view.findByRole("button", { name: "⤢" }));
    const close = await view.findByRole("button", { name: "Close" });
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    view.container.appendChild(viewport);
    const event = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(canvas, event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.getByRole("button", { name: "Close" })).toBe(close);

    fireEvent.keyDown(close, { key: "Escape" });
    expect(view.queryByRole("button", { name: "Close" })).toBeNull();
  });

  test("reserves diagram height until fonts load, then renders", async () => {
    // Pele measures labels when it renders, so it waits for web fonts first.
    const fonts = Promise.withResolvers<void>();
    Object.defineProperty(document, "fonts", {
      value: { ready: fonts.promise, load: () => Promise.resolve([]) },
    });

    const view = renderMermaid({ isStreaming: true });

    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    expect(container?.style.minHeight).toBe("300px");
    expect(container?.textContent).toBe("Rendering diagram...");

    await act(async () => {
      fonts.resolve();
      await fonts.promise;
    });
    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg.pele")).not.toBeNull()
    );
  });

  test("waits for the diagram font to load, and still renders when it fails", async () => {
    // fonts.ready alone resolves before a face that nothing on the page uses yet has loaded.
    document.documentElement.style.setProperty("--font-primary", "Geist");
    const fontLoad = Promise.withResolvers<FontFace[]>();
    const requested: string[] = [];
    Object.defineProperty(document, "fonts", {
      value: {
        ready: Promise.resolve(),
        load: (font: string) => {
          requested.push(font);
          return fontLoad.promise;
        },
      },
    });

    const view = renderMermaid();
    // A macrotask drains every promise chain that does not wait on the font.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    // The theme sets no --font-monospace here, so only the primary font loads.
    expect(requested).toEqual(["14px Geist"]);
    expect(view.container.querySelector(".mermaid-container svg")).toBeNull();
    expect(view.container.querySelector(".mermaid-container")?.textContent).toBe(
      "Rendering diagram..."
    );

    act(() => fontLoad.reject(new Error("font failed to load")));
    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg.pele")).not.toBeNull()
    );
  });

  test("keeps the stable diagram frame for streaming parse errors", async () => {
    const peleRender = spyOn(PeleModule, "render");
    const view = renderMermaid({ chart: INVALID_CHART, isStreaming: true });

    await waitFor(() => expect(peleRender).toHaveBeenCalled());
    peleRender.mockRestore();
    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    expect(container?.style.minHeight).toBe("300px");
    expect(view.container.textContent).toContain("Rendering diagram...");
    expect(view.container.textContent).not.toContain("Mermaid Error");
  });

  test("shows parse errors after streaming settles", async () => {
    const view = renderMermaid({ chart: INVALID_CHART, isStreaming: false });

    await waitFor(() => expect(view.container.textContent).toContain("Mermaid Error: "));
    expect(view.container.querySelector(".mermaid-container")).toBeNull();
  });

  describe("sanitizeMermaidSvg", () => {
    test("removes foreignObject and its contents", () => {
      const withForeignObject =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/>' +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>label</p><script>alert(1)</script></div></foreignObject></svg>';
      const out = sanitizeMermaidSvg(withForeignObject, "mermaid-r1");
      expect(out).toContain("<rect");
      expect(out).not.toContain("foreignObject");
      expect(out).not.toContain("label");
      expect(out).not.toContain("<script");
    });

    test("still strips on* handlers and javascript: hrefs", () => {
      const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
        <a href="javascript:alert(1)" onclick="alert(2)"><rect width="10" height="10"/></a>
      </svg>`;
      const out = sanitizeMermaidSvg(malicious, "mermaid-r1");
      expect(out).not.toBeNull();
      expect(out).not.toContain("javascript:");
      expect(out).not.toContain("onclick");
    });

    test("rejects input that contains no <svg> root", () => {
      expect(sanitizeMermaidSvg("<div>not an svg</div>", "mermaid-r1")).toBeNull();
      expect(sanitizeMermaidSvg("", "mermaid-r1")).toBeNull();
    });

    test("rejects malformed SVG instead of repairing it", () => {
      expect(sanitizeMermaidSvg("<svg><g></svg>", "mermaid-r1")).toBeNull();
      expect(sanitizeMermaidSvg("<svg><rect></svg>", "mermaid-r1")).toBeNull();
      // HTML void elements inside foreignObject are not well-formed XML either.
      const htmlLabel =
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>a<br>b</p></foreignObject></svg>';
      expect(sanitizeMermaidSvg(htmlLabel, "mermaid-r1")).toBeNull();
    });
  });

  test("zoom controls resize the diagram's pixel box", async () => {
    const view = renderMermaid();

    await waitFor(() => {
      expect(view.container.querySelector(".mermaid-container svg")).not.toBeNull();
    });

    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    const natural = viewBoxOf(container);
    // A small diagram sits at the size Pele measured.
    expect(natural.height).toBeLessThan(300);
    expect(boxOf(container)).toEqual(pixels(natural));

    const buttons = Array.from(view.container.querySelectorAll("button"));
    const zoomOutButton = buttons.find((button) => button.textContent === "−");
    const zoomInButton = buttons.find((button) => button.textContent === "+");
    if (!zoomOutButton || !zoomInButton) {
      throw new Error("Expected Mermaid zoom controls to render");
    }

    fireEvent.click(zoomInButton);

    await waitFor(() => {
      expect(boxOf(container)).toEqual(
        pixels({ width: Math.round(natural.width * 1.1), height: Math.round(natural.height * 1.1) })
      );
    });
    expect(window.localStorage.getItem("mermaid-diagram-zoom")).toBe("1.1");

    fireEvent.click(zoomOutButton);

    await waitFor(() => {
      expect(boxOf(container)).toEqual(pixels(natural));
    });
  });

  test("the zoom buttons stop at 50% and 300%", async () => {
    const view = renderMermaid();
    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg")).not.toBeNull()
    );
    const zoomOut = view.getByRole("button", { name: "−" });
    const zoomIn = view.getByRole("button", { name: "+" });
    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    const natural = viewBoxOf(container);

    for (let step = 0; step < 5; step++) fireEvent.click(zoomOut);
    await waitFor(() =>
      expect(boxOf(container).width).toBe(`${Math.round(natural.width * 0.5)}px`)
    );
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true);
    expect((zoomIn as HTMLButtonElement).disabled).toBe(false);

    for (let step = 0; step < 25; step++) fireEvent.click(zoomIn);
    await waitFor(() => expect(boxOf(container).width).toBe(`${natural.width * 3}px`));
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true);
    expect((zoomOut as HTMLButtonElement).disabled).toBe(false);
  });

  test("the diagram's svg carries no inline size of its own", async () => {
    const view = renderMermaid();
    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg.pele")).not.toBeNull()
    );
    // An inline max-width or height would beat the stylesheet's pixel box and hand the box back
    // to each engine's intrinsic sizing.
    const style = view.container.querySelector("svg.pele")?.getAttribute("style") ?? "";
    expect(style).not.toMatch(
      /(^|;)\s*(max-width|min-width|width|max-height|min-height|height)\s*:/
    );
  });

  test.each([{ width: 0 }, { height: 0 }, { width: Number.NaN }, { height: Infinity }])(
    "shows a render error when Pele reports the size %o",
    async (badSize) => {
      const real = PeleModule.render;
      const peleRender = spyOn(PeleModule, "render").mockImplementation((chart, options) => ({
        ...real(chart, options),
        ...badSize,
      }));
      try {
        const view = renderMermaid();
        await waitFor(() =>
          expect(view.container.textContent).toContain(
            "Mermaid Error: Diagram renderer returned an invalid size"
          )
        );
        expect(view.container.querySelector("svg")).toBeNull();
      } finally {
        peleRender.mockRestore();
      }
    }
  );

  test("draws a diagram that Pele measures at one pixel", async () => {
    const real = PeleModule.render;
    const peleRender = spyOn(PeleModule, "render").mockImplementation((chart, options) => ({
      ...real(chart, options),
      width: 1,
      height: 1,
    }));
    try {
      const view = renderMermaid();
      await waitFor(() => expect(view.container.querySelector("svg.pele")).not.toBeNull());
      expect(boxOf(view.container.querySelector(".mermaid-container"))).toEqual({
        width: "1px",
        height: "1px",
      });
    } finally {
      peleRender.mockRestore();
    }
  });

  describe("layout width", () => {
    const WIDE_CHART =
      "flowchart LR\nA[Request]-->B[Parse]-->C[Plan]-->D[Build]-->E[Test]-->F[Ship]";
    let observers: Array<{ callback: ResizeObserverCallback; element: Element | null }>;
    let measuredWidth: number;
    let dialogWidth: number;
    let originalResizeObserver: typeof globalThis.ResizeObserver;
    let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
    let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
    let measure: { mockRestore(): void };
    let originalViewport: { width: number; height: number };

    beforeEach(() => {
      originalViewport = { width: window.innerWidth, height: window.innerHeight };
      observers = [];
      measuredWidth = 0;
      dialogWidth = 0;
      originalResizeObserver = globalThis.ResizeObserver;
      originalRequestAnimationFrame = globalThis.requestAnimationFrame;
      originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
      globalThis.requestAnimationFrame = (callback) =>
        setTimeout(() => callback(0), 0) as unknown as number;
      globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
      globalThis.ResizeObserver = class {
        private readonly entry: { callback: ResizeObserverCallback; element: Element | null };
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, element: null };
          observers.push(this.entry);
        }
        observe(element: Element) {
          this.entry.element = element;
        }
        unobserve() {
          return undefined;
        }
        disconnect() {
          this.entry.element = null;
        }
      } as unknown as typeof ResizeObserver;
      // happy-dom element classes are shared by every window, so this spy outlives the test
      // unless afterEach restores it.
      measure = spyOn(window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        function (this: HTMLElement) {
          const width = this.classList.contains("mermaid-modal")
            ? dialogWidth
            : this.classList.contains("mermaid-container")
              ? measuredWidth
              : 0;
          return new window.DOMRect(0, 0, width, 300);
        }
      );
    });

    afterEach(() => {
      globalThis.ResizeObserver = originalResizeObserver;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      measure.mockRestore();
      Object.defineProperty(window, "innerWidth", {
        value: originalViewport.width,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: originalViewport.height,
        configurable: true,
      });
    });

    function resizeContainer(width: number) {
      measuredWidth = width;
      for (const { callback, element } of observers) {
        if (!element) continue;
        const entry = { target: element, contentRect: { width, height: 300 } };
        callback([entry as unknown as ResizeObserverEntry], {} as ResizeObserver);
      }
    }

    test("Pele lays the diagram out at the container's measured width, if it has one", async () => {
      const peleRender = spyOn(PeleModule, "render");
      try {
        const view = renderMermaid({ chart: WIDE_CHART });
        const container = view.container.querySelector<HTMLElement>(".mermaid-container");
        await waitFor(() => expect(viewBoxOf(container).width).toBeGreaterThan(0));
        const maxWidthOfLastRender = () => peleRender.mock.calls.at(-1)?.[1]?.maxWidth;
        expect(maxWidthOfLastRender()).toBeUndefined();

        act(() => resizeContainer(1));
        await waitFor(() => expect(maxWidthOfLastRender()).toBe(1));
        act(() => resizeContainer(326));
        await waitFor(() => expect(maxWidthOfLastRender()).toBe(326));
      } finally {
        peleRender.mockRestore();
      }
    });

    test("an unmeasured container renders the diagram's natural layout", async () => {
      const view = renderMermaid({ chart: WIDE_CHART });
      const container = view.container.querySelector<HTMLElement>(".mermaid-container");

      await waitFor(() => expect(viewBoxOf(container).width).toBeGreaterThan(0));
      const natural = viewBoxOf(container);
      expect(natural.width).toBeGreaterThan(400);
      expect(natural.width).toBeGreaterThan(natural.height);
      expect(boxOf(container)).toEqual(pixels(natural));
    });

    test("a narrow container gets a vertical layout and reflows when it widens", async () => {
      measuredWidth = 326;
      const view = renderMermaid({ chart: WIDE_CHART });
      const container = view.container.querySelector<HTMLElement>(".mermaid-container");

      await waitFor(() => expect(viewBoxOf(container).width).toBeGreaterThan(0));
      const narrow = viewBoxOf(container);
      expect(narrow.width).toBeLessThanOrEqual(326);
      expect(narrow.height).toBeGreaterThan(narrow.width);
      expect(boxOf(container)).toEqual(pixels(narrow));

      act(() => resizeContainer(1200));
      await waitFor(() => {
        const wide = viewBoxOf(container);
        expect(wide.width).toBeGreaterThan(wide.height);
      });
      expect(boxOf(container)).toEqual(pixels(viewBoxOf(container)));
    });

    test("only a container wider than the narrow breakpoint caps a tall diagram's height", async () => {
      measuredWidth = 326;
      const view = renderMermaid({ chart: TALL_CHART });
      const container = view.container.querySelector<HTMLElement>(".mermaid-container");

      await waitFor(() => expect(viewBoxOf(container).height).toBeGreaterThan(0));
      const narrow = viewBoxOf(container);
      expect(narrow.height).toBeGreaterThan(300);
      expect(boxOf(container)).toEqual(pixels(narrow));

      act(() => resizeContainer(1200));
      await waitFor(() => expect(boxOf(container).height).toBe("300px"));
      const tall = viewBoxOf(container);
      expect(boxOf(container).width).toBe(`${Math.round((tall.width * 300) / tall.height)}px`);
    });

    test("the expand dialog fits a tall diagram into the room its viewport leaves", async () => {
      const setViewportHeight = (height: number) => {
        Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
        act(() => {
          window.dispatchEvent(new window.Event("resize"));
        });
      };
      setViewportHeight(500);
      const view = renderMermaid({ chart: TALL_CHART });
      await waitFor(() => expect(view.container.querySelector("svg.pele")).not.toBeNull());

      fireEvent.click(view.getByRole("button", { name: "⤢" }));
      const dialog = () => view.container.querySelector<HTMLElement>(".mermaid-modal");
      await waitFor(() => expect(viewBoxOf(dialog()).height).toBeGreaterThan(0));
      const natural = viewBoxOf(dialog());
      expect(natural.height).toBeGreaterThan(800);
      const room = dialogDiagramRoom({ width: window.innerWidth, height: 500 });
      expect(boxOf(dialog()).height).toBe(`${room.height}px`);
      expect(boxOf(dialog()).width).toBe(
        `${Math.round((natural.width * room.height) / natural.height)}px`
      );

      setViewportHeight(2000);
      await waitFor(() => expect(boxOf(dialog())).toEqual(pixels(natural)));
    });

    test("the expand dialog fits a wide diagram into the room its viewport leaves", async () => {
      Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
      const view = renderMermaid({ chart: WIDE_CHART });
      await waitFor(() => expect(view.container.querySelector("svg.pele")).not.toBeNull());

      fireEvent.click(view.getByRole("button", { name: "⤢" }));
      const dialog = () => view.container.querySelector<HTMLElement>(".mermaid-modal");
      await waitFor(() => expect(viewBoxOf(dialog()).width).toBeGreaterThan(0));
      const natural = viewBoxOf(dialog());
      const room = dialogDiagramRoom({ width: 390, height: 844 });
      expect(natural.width).toBeGreaterThan(room.width);
      expect(boxOf(dialog()).width).toBe(`${room.width}px`);
    });

    test("the expand dialog takes its room from the layout viewport, not the visual one", async () => {
      // A pinch-zoomed page has a smaller window.innerWidth than the fixed overlay it shows.
      Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
      Object.defineProperty(document.documentElement, "clientWidth", {
        value: 1024,
        configurable: true,
      });
      Object.defineProperty(document.documentElement, "clientHeight", {
        value: 768,
        configurable: true,
      });
      const view = renderMermaid({ chart: WIDE_CHART });
      await waitFor(() => expect(view.container.querySelector("svg.pele")).not.toBeNull());

      fireEvent.click(view.getByRole("button", { name: "⤢" }));
      const dialog = () => view.container.querySelector<HTMLElement>(".mermaid-modal");
      await waitFor(() => expect(viewBoxOf(dialog()).width).toBeGreaterThan(0));
      const natural = viewBoxOf(dialog());
      expect(natural.width).toBeGreaterThan(dialogDiagramRoom({ width: 390, height: 844 }).width);
      expect(natural.width).toBeLessThanOrEqual(
        dialogDiagramRoom({ width: 1024, height: 768 }).width
      );
      expect(boxOf(dialog())).toEqual(pixels(natural));
    });

    test("the expand dialog follows a resize of the layout viewport", async () => {
      Object.defineProperty(document.documentElement, "clientWidth", {
        value: 1024,
        configurable: true,
      });
      const view = renderMermaid({ chart: WIDE_CHART });
      await waitFor(() => expect(view.container.querySelector("svg.pele")).not.toBeNull());
      fireEvent.click(view.getByRole("button", { name: "⤢" }));
      const dialog = () => view.container.querySelector<HTMLElement>(".mermaid-modal");
      await waitFor(() => expect(viewBoxOf(dialog()).width).toBeGreaterThan(0));
      const natural = viewBoxOf(dialog());
      expect(boxOf(dialog())).toEqual(pixels(natural));

      Object.defineProperty(document.documentElement, "clientWidth", {
        value: 390,
        configurable: true,
      });
      act(() => {
        window.dispatchEvent(new window.Event("resize"));
      });
      await waitFor(() =>
        expect(boxOf(dialog()).width).toBe(
          `${dialogDiagramRoom({ width: 390, height: window.innerHeight }).width}px`
        )
      );
    });

    test("the expand dialog lays the diagram out for its own width", async () => {
      measuredWidth = 326;
      dialogWidth = 1200;
      const view = renderMermaid({ chart: WIDE_CHART });
      const inline = view.container.querySelector<HTMLElement>(".mermaid-container");
      await waitFor(() => expect(viewBoxOf(inline).width).toBeGreaterThan(0));

      fireEvent.click(view.getByRole("button", { name: "⤢" }));
      await waitFor(() => {
        const dialog = viewBoxOf(view.container.querySelector(".mermaid-modal"));
        expect(dialog.width).toBeGreaterThan(dialog.height);
      });
      const narrow = viewBoxOf(inline);
      expect(narrow.height).toBeGreaterThan(narrow.width);
    });
  });

  test("renders chart text as text, without links or images", async () => {
    const chart = [
      "flowchart TD",
      'A["<script>alert(1)</script>"]-->B',
      'C@{ img: "https://example.com/beacon.png", label: "pic" }',
      'click B "https://example.com"',
    ].join("\n");
    const view = renderMermaid({ chart });

    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg.pele")).not.toBeNull()
    );
    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container?.style.minHeight).toBe("300px");
    expect(container?.textContent).toContain("alert(1)");
    expect(view.container.querySelector("script")).toBeNull();
    expect(container?.querySelector("a, [href], image")).toBeNull();
  });

  test("typesets $$...$$ labels as MathML", async () => {
    // happy-dom has no layout, and Pele shows the TeX source for a 0x0 expression. happy-dom
    // parses <math> as an HTMLUnknownElement.
    const measure = spyOn(window.HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new window.DOMRect(0, 0, 24, 18)
    );
    try {
      const view = renderMermaid({ chart: 'flowchart TD\nA["$$x^2$$"]-->B' });

      await waitFor(() =>
        expect(view.container.querySelector(".mermaid-container svg.pele")).not.toBeNull()
      );
      const label = view.container.querySelector(".mermaid-container foreignObject.pele-math");
      expect(label).not.toBeNull();
      expect(label?.querySelector("math msup")).not.toBeNull();
      expect(view.container.querySelector(".mermaid-container")?.textContent).not.toContain("$$");
    } finally {
      measure.mockRestore();
    }
  });

  test("shows invalid TeX as its source", async () => {
    const view = renderMermaid({ chart: 'flowchart TD\nA["$$\\frac{$$"]-->B' });

    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg.pele")).not.toBeNull()
    );
    const container = view.container.querySelector(".mermaid-container");
    expect(container?.querySelector("foreignObject")).toBeNull();
    expect(container?.textContent).toContain("\\frac{");
  });
});
