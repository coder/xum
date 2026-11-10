import "../../../../tests/ui/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { pinOverWorkspace } from "./pinnedView";

let cleanupDom: (() => void) | null = null;
let originalResizeObserver: typeof ResizeObserver;
/** Callbacks of the shell observers that are still connected; the tests resize by hand. */
let resizeCallbacks: Set<() => void>;

beforeEach(() => {
  cleanupDom = installDom();
  resizeCallbacks = new Set();
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private readonly notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {
      resizeCallbacks.add(this.notify);
    }
    unobserve() {
      resizeCallbacks.delete(this.notify);
    }
    disconnect() {
      resizeCallbacks.delete(this.notify);
    }
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  cleanupDom?.();
  cleanupDom = null;
});

// <body> > [left, shell > [chat, panel]]
function buildPage() {
  const left = document.createElement("div");
  const shell = document.createElement("div");
  shell.setAttribute("data-workspace-shell", "");
  const chat = document.createElement("div");
  const panel = document.createElement("div");
  shell.append(chat, panel);
  document.body.append(left, shell);
  let box = { top: 0, left: 240, width: 800, height: 600 };
  // happy-dom has no layout (and no DOMRect global): report the box the shell would have.
  shell.getBoundingClientRect = () => {
    const rect: DOMRect = {
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    };
    return rect;
  };
  const resizeShell = (next: typeof box) => {
    box = next;
    for (const notify of [...resizeCallbacks]) notify();
  };
  return { left, chat, panel, resizeShell };
}

const boxOf = (panel: HTMLElement) =>
  [panel.style.top, panel.style.left, panel.style.width, panel.style.height].join(" ");

test("covers the shell box, follows it, and the undo clears it", () => {
  const page = buildPage();
  const unpin = pinOverWorkspace(page.panel);
  expect(boxOf(page.panel)).toBe("0px 240px 800px 600px");
  expect([page.left.inert, page.chat.inert]).toEqual([false, true]);

  // The left sidebar collapsed: the shell starts at the window edge and grows.
  page.resizeShell({ top: 0, left: 0, width: 1040, height: 600 });
  expect(boxOf(page.panel)).toBe("0px 0px 1040px 600px");

  unpin();
  expect(boxOf(page.panel)).toBe("   ");
  expect(page.chat.inert).toBe(false);
  expect(resizeCallbacks.size).toBe(0);
});

test("throws outside a workspace shell", () => {
  const panel = document.createElement("div");
  document.body.append(panel);
  expect(() => pinOverWorkspace(panel)).toThrow("not inside a workspace shell");
});
