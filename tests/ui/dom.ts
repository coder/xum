import { GlobalWindow } from "happy-dom";
import * as React from "react";

/**
 * Rebind Radix's layout-effect hook to the genuine React hook once a document exists.
 *
 * `@radix-ui/react-use-layout-effect` decides at module evaluation time whether to export
 * `React.useLayoutEffect` or a noop, based on `globalThis.document`. In the shared Bun test
 * process a document-less suite (hooks/contexts tests importing API → AuthTokenModal → Radix)
 * can evaluate that module first and pin the noop for every later UI suite, so Popover and
 * Tooltip content never mounts. `mock.module` updates the live binding seen by consumers that
 * already imported the noop and pre-registers the export when Radix has not loaded yet, so
 * this is order-independent. Scoped to that single module; only DOM-installing suites reach
 * here, and no test renders through react-dom/server, so the noop is never the correct value.
 *
 * This harness is shared with the Jest integration suites (tests/ui/**), where `bun:test` does
 * not exist. Jest gives each test file its own module registry, so an earlier file cannot pin
 * the noop there; load `bun:test` only under Bun instead of importing it statically.
 */
let radixLayoutEffectRebound = false;
function rebindRadixLayoutEffect(): void {
  if (radixLayoutEffectRebound || process.versions.bun == null) return;
  radixLayoutEffectRebound = true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mock } = require("bun:test") as typeof import("bun:test");
  mock.module("@radix-ui/react-use-layout-effect", () => ({
    useLayoutEffect: React.useLayoutEffect,
  }));
}

interface DomGlobalsSnapshot {
  window: typeof globalThis.window;
  document: typeof globalThis.document;
  navigator: typeof globalThis.navigator;
  localStorage: typeof globalThis.localStorage;
  CustomEvent: typeof globalThis.CustomEvent;
  DocumentFragment: unknown;
  Element: unknown;
  HTMLInputElement: unknown;
  HTMLElement: unknown;
  NodeFilter: unknown;
  Node: unknown;
  Image: unknown;
  requestAnimationFrame: typeof globalThis.requestAnimationFrame;
  cancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  getComputedStyle: typeof globalThis.getComputedStyle;
  ResizeObserver: unknown;
  IntersectionObserver: unknown;
  MutationObserver: unknown;
}

// NOTE: installDom intentionally mutates globalThis.* (window/document/etc) to give UI
// tests a DOM environment.
//
// Some Radix internals decide at module-eval time whether to enable useLayoutEffect based
// on `globalThis.document`. See the bootstrap at the bottom of this module.

export function installDom(): () => void {
  const previous: DomGlobalsSnapshot = {
    window: globalThis.window,
    document: globalThis.document,
    Element: (globalThis as unknown as { Element?: unknown }).Element,
    DocumentFragment: (globalThis as unknown as { DocumentFragment?: unknown }).DocumentFragment,
    navigator: globalThis.navigator,
    HTMLInputElement: (globalThis as unknown as { HTMLInputElement?: unknown }).HTMLInputElement,
    localStorage: globalThis.localStorage,
    CustomEvent: globalThis.CustomEvent,
    NodeFilter: (globalThis as unknown as { NodeFilter?: unknown }).NodeFilter,
    HTMLElement: (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement,
    Node: (globalThis as unknown as { Node?: unknown }).Node,
    Image: (globalThis as unknown as { Image?: unknown }).Image,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver,
    MutationObserver: (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver,
    IntersectionObserver: (globalThis as unknown as { IntersectionObserver?: unknown })
      .IntersectionObserver,
  };

  const domWindow = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
    typeof globalThis;

  globalThis.window = domWindow;
  globalThis.document = domWindow.document;
  // The document now exists: repair any Radix noop binding pinned by an earlier suite.
  rebindRadixLayoutEffect();
  globalThis.navigator = domWindow.navigator;
  globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
  globalThis.localStorage = domWindow.localStorage;
  globalThis.CustomEvent = domWindow.CustomEvent as typeof globalThis.CustomEvent;
  (globalThis as unknown as { Element: unknown }).Element = domWindow.Element;
  (globalThis as unknown as { DocumentFragment: unknown }).DocumentFragment =
    domWindow.DocumentFragment;
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement =
    domWindow.HTMLInputElement;
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
    domWindow.MutationObserver;
  (globalThis as unknown as { NodeFilter: unknown }).NodeFilter = domWindow.NodeFilter;
  (globalThis as unknown as { Node: unknown }).Node = domWindow.Node;
  // Image is used by react-dnd-html5-backend for drag preview
  (globalThis as unknown as { Image: unknown }).Image = domWindow.Image ?? class MockImage {};
  // DataTransfer is used by drag-drop tests
  if (!(globalThis as unknown as { DataTransfer?: unknown }).DataTransfer) {
    (globalThis as unknown as { DataTransfer: unknown }).DataTransfer =
      domWindow.DataTransfer ?? class MockDataTransfer {};
  }

  // happy-dom returns null from canvas.getContext("2d") by default. Libraries like
  // lottie-web expect a writable 2D context during module initialization.
  const canvasPrototype = domWindow.HTMLCanvasElement?.prototype as
    | {
        getContext?: (contextId: string, options?: unknown) => unknown;
      }
    | undefined;

  if (canvasPrototype?.getContext) {
    const originalGetContext = canvasPrototype.getContext;
    canvasPrototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown
    ): unknown {
      const context = originalGetContext.call(this, contextId, options);
      if (context || contextId !== "2d") {
        return context;
      }

      return {
        fillStyle: "rgba(0,0,0,0)",
        fillRect: () => undefined,
        clearRect: () => undefined,
        drawImage: () => undefined,
        save: () => undefined,
        restore: () => undefined,
        beginPath: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        closePath: () => undefined,
        stroke: () => undefined,
        translate: () => undefined,
        scale: () => undefined,
        rotate: () => undefined,
        arc: () => undefined,
        fill: () => undefined,
        transform: () => undefined,
        rect: () => undefined,
        clip: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        putImageData: () => undefined,
        measureText: () => ({ width: 0 }),
      };
    };
  }

  // happy-dom doesn't always define these on globalThis in node env.
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      return window.setTimeout(() => cb(Date.now()), 0);
    };
  }

  if (!globalThis.cancelAnimationFrame) {
    globalThis.cancelAnimationFrame = (id: number) => {
      window.clearTimeout(id);
    };
  }

  // Some UI code paths rely on ResizeObserver for layout/scroll stabilization.
  if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
    class ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe(_target: Element): void {}
      unobserve(_target: Element): void {}
      disconnect(): void {}
    }

    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserver;
  }

  // Used by ReviewPanel/HunkViewer for lazy visibility tracking.
  if (!(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver) {
    class IntersectionObserver {
      constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
      observe(_target: Element): void {}
      unobserve(_target: Element): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      IntersectionObserver;
  }

  // React DOM's getCurrentEventPriority reads window.event to determine update priority.
  // In happy-dom, this may be undefined, causing errors. Polyfill with undefined-safe getter.
  if (!("event" in domWindow)) {
    Object.defineProperty(domWindow, "event", {
      get: () => undefined,
      configurable: true,
    });
  }

  // matchMedia is used by some components and by Radix.
  if (!domWindow.matchMedia) {
    domWindow.matchMedia = ((_query: string) => {
      return {
        matches: false,
        media: _query,
        onchange: null,
        addListener: () => {
          // deprecated
        },
        removeListener: () => {
          // deprecated
        },
        addEventListener: () => {
          // noop
        },
        removeEventListener: () => {
          // noop
        },
        dispatchEvent: () => false,
      };
    }) as unknown as typeof window.matchMedia;
  }

  return () => {
    domWindow.close();

    (globalThis as unknown as { Element?: unknown }).Element = previous.Element;
    globalThis.window = previous.window;
    (globalThis as unknown as { DocumentFragment?: unknown }).DocumentFragment =
      previous.DocumentFragment;
    globalThis.document = previous.document;
    globalThis.navigator = previous.navigator;
    (globalThis as unknown as { HTMLInputElement?: unknown }).HTMLInputElement =
      previous.HTMLInputElement;
    globalThis.localStorage = previous.localStorage;
    globalThis.CustomEvent = previous.CustomEvent;
    (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = previous.HTMLElement;
    (globalThis as unknown as { NodeFilter?: unknown }).NodeFilter = previous.NodeFilter;
    (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver =
      previous.MutationObserver;
    (globalThis as unknown as { Node?: unknown }).Node = previous.Node;
    (globalThis as unknown as { Image?: unknown }).Image = previous.Image;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver =
      previous.IntersectionObserver;
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      previous.ResizeObserver;

    // Self-heal: snapshots taken after a `document = undefined` teardown would
    // restore that poisoned state here, breaking modules that detect DOM
    // support at eval time (e.g. @react-dnd/asap). Keep a baseline DOM alive.
    if (typeof globalThis.document === "undefined" || typeof globalThis.window === "undefined") {
      installDom();
    }
  };
}

/**
 * Bootstrap a baseline Happy DOM document early.
 *
 * Radix's @radix-ui/react-use-layout-effect decides at module evaluation time whether
 * to use React.useLayoutEffect based on `globalThis.document`. In Jest's node
 * environment, `document` starts undefined, which makes Radix fall back to a noop and
 * breaks Portals (Dialogs/Tooltips/etc).
 *
 * We install a baseline DOM once on module import so downstream UI modules see a truthy
 * `document` during evaluation. Individual tests still call installDom() to get an
 * isolated Window per test.
 */
if (typeof globalThis.document === "undefined") {
  installDom();
} else {
  // A document from an earlier suite does not prove Radix bound the real hook: a
  // document-less suite may have evaluated Radix before that DOM was installed.
  rebindRadixLayoutEffect();
}

// Require (not statically import) react-dnd after the DOM bootstrap because
// @react-dnd/asap reads `document` while constructing its scheduler during
// module evaluation.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("react-dnd");
