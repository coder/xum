import "../dom";

import { act, fireEvent, waitFor } from "@testing-library/react";

// App-level UI tests render the loader shell first, so stub Lottie before importing the
// harness to keep happy-dom from tripping over lottie-web's canvas bootstrap.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { mockScrollMetrics } from "../scrollMetrics";

// #6773: while the reader is scrolled up, a row whose top is above the view grows (KaTeX, a
// Mermaid diagram or an image arriving late). Chrome anchors to the row's visible part, so growth
// below that anchor pushed every row below it down by the growth. happy-dom has no layout and no
// native anchoring: a small layout model stands in for both, and the test delivers the
// ResizeObserver signal that the growth produces in a browser. The pixel proof is in the PR.

const PAD_TOP = 15;
const VIEW_HEIGHT = 400;
const ROW_HEIGHT = 300;
const GROWTH = 397;

const observers = new Set<{ callback: ResizeObserverCallback; targets: Element[] }>();
class CapturingResizeObserver {
  private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: [] };
    observers.add(this.entry);
  }
  observe(target: Element): void {
    this.entry.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    observers.delete(this.entry);
  }
}

function rect(top: number, height: number): DOMRect {
  const r = { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top };
  return { ...r, toJSON: () => r };
}

describe("Growth inside a partly visible top row while scrolled up (#6773)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test.each([
    ["the partly visible top row", 0, { heldTop: 44, scrollTop: 271 + GROWTH }],
    ["the first row that starts in view", 1, { heldTop: 44, scrollTop: 271 }],
  ] as const)(
    "growth of %s",
    async (_label, grownRow, expected) => {
      const originalResizeObserver = window.ResizeObserver;
      const app = await createAppHarness({ branchPrefix: "partial-top-row-growth" });
      try {
        await app.chat.send("First message for the top-row growth test");
        await app.chat.expectStreamComplete();
        await app.chat.send("Second message for the top-row growth test");
        await app.chat.expectStreamComplete();

        const messageWindow = app.view.container.querySelector<HTMLDivElement>(
          '[data-testid="message-window"]'
        );
        if (!messageWindow) throw new Error("Message window not found");
        const content = messageWindow.firstElementChild as HTMLElement;
        const rows = Array.from(messageWindow.querySelectorAll<HTMLElement>("[data-message-id]"));
        expect(rows.length).toBeGreaterThanOrEqual(3);

        // Layout model: rows stacked in document order under the scrollport's top padding.
        const heights = rows.map(() => ROW_HEIGHT);
        const totalHeight = () => PAD_TOP + heights.reduce((sum, h) => sum + h, 0);
        const port = mockScrollMetrics(messageWindow, {
          scrollHeight: totalHeight(),
          clientHeight: VIEW_HEIGHT,
        });
        messageWindow.getBoundingClientRect = () => rect(0, VIEW_HEIGHT);
        rows.forEach((row, index) => {
          row.getBoundingClientRect = () => {
            const above = heights.slice(0, index).reduce((sum, h) => sum + h, 0);
            return rect(PAD_TOP + above - port.getScrollTop(), heights[index]);
          };
        });

        window.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
        globalThis.ResizeObserver = window.ResizeObserver;

        // Scroll up (a real wheel delta, then the scroll): only row 0's bottom 44 px stay in view.
        fireEvent.wheel(messageWindow, { deltaY: -120 });
        port.setScrollTop(271);
        fireEvent.scroll(messageWindow);
        await waitFor(() => expect(content.style.overflowAnchor).toBe(""));
        expect(rows[0].getBoundingClientRect().bottom).toBe(44);
        expect(rows[1].getBoundingClientRect().top).toBe(44);

        // The row grows; the browser delivers the transcript content's resize before paint.
        heights[grownRow] += GROWTH;
        port.setScrollHeight(totalHeight());
        act(() => {
          for (const observer of [...observers]) {
            if (observer.targets.includes(content)) observer.callback([], {} as ResizeObserver);
          }
        });

        // Growth above the first row in view is held; growth inside it is normal top-down flow.
        expect(rows[1].getBoundingClientRect().top).toBe(expected.heldTop);
        expect(port.getScrollTop()).toBe(expected.scrollTop);
      } finally {
        window.ResizeObserver = originalResizeObserver;
        globalThis.ResizeObserver = originalResizeObserver;
        await app.dispose();
      }
    },
    120_000
  );
});
