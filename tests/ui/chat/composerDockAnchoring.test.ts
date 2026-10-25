import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";

// App-level UI tests render the loader shell first, so stub Lottie before importing the
// harness to keep happy-dom from tripping over lottie-web's canvas bootstrap.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { mockScrollMetrics as mockScrollportMetrics } from "../scrollMetrics";

function getMessageWindow(container: HTMLElement): HTMLDivElement {
  const element = container.querySelector('[data-testid="message-window"]');
  if (element?.tagName !== "DIV") {
    throw new Error("Message window not found");
  }
  return element as HTMLDivElement;
}

// These tests encode the structural contract behind the "send flash" + "hydration
// tear" fixes:
//   1. The composer dock is IN-FLOW scroll content stuck (position: sticky) to the
//      scrollport bottom, so transcript clearance is reserved by flow layout in the
//      same layout pass as any dock height change (no measured --composer-h channel
//      that can lag a frame and tear), while the scrollport's clientHeight never
//      changes when the composer resizes.
//   2. A 0-height bottom sentinel sits between the transcript content and the dock
//      and is the sole `overflow-anchor: auto` element while locked, so native CSS
//      scroll anchoring pins the bottom on append without a JS settle loop. The
//      dock itself must never be an anchor candidate.
//   3. Releasing the lock (scrolling up) restores row anchoring so the reading
//      position is preserved.
// happy-dom cannot exercise real native anchoring, so these assert the DOM/style
// contract the browser relies on; the pixel behavior is covered by the e2e suite.
describe("Sticky composer dock + bottom anchoring", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("keeps the dock in-flow below the sentinel and the sentinel as the sole bottom anchor", async () => {
    const app = await createAppHarness({ branchPrefix: "floating-composer-anchor" });

    try {
      await app.chat.send("Seed transcript before asserting the anchoring contract");
      await app.chat.expectStreamComplete();

      const messageWindow = getMessageWindow(app.view.container);

      // (1) The composer dock is in-flow scroll content: the last child of the
      // scrollport, stuck to its bottom, and opted out of scroll anchoring so the
      // browser can never anchor to the sticky dock.
      const dock = app.view.container.querySelector('[data-testid="chat-composer-dock"]');
      if (!dock) throw new Error("Composer dock not found");
      expect(messageWindow.contains(dock)).toBe(true);
      expect(dock.parentElement).toBe(messageWindow);
      expect(messageWindow.lastElementChild).toBe(dock);
      expect(dock.classList.contains("sticky")).toBe(true);
      expect((dock as HTMLElement).style.overflowAnchor).toBe("none");

      // (2) The sentinel sits immediately above the dock: appends grow content
      // ABOVE it (native anchoring pins the bottom) while dock growth happens
      // BELOW it (covered by the scrollport-children ResizeObserver).
      const sentinel = messageWindow.querySelector('[data-testid="transcript-bottom-sentinel"]');
      if (!sentinel) throw new Error("Bottom sentinel not found");
      expect(sentinel.nextElementSibling).toBe(dock);
      expect((sentinel as HTMLElement).style.overflowAnchor).toBe("auto");

      // (2) While locked (at the bottom after a send) the transcript content opts OUT
      // of anchoring so the sentinel is the only candidate the browser can pick.
      const content = messageWindow.firstElementChild as HTMLElement;
      expect(content.style.overflowAnchor).toBe("none");

      // (3) Scrolling up releases the lock and restores default row anchoring so the
      // browser preserves the reading position when content above the fold settles.
      const port = mockScrollportMetrics(messageWindow, {
        scrollHeight: 2000,
        clientHeight: 500,
        scrollTop: 1500,
      });
      // A real wheel delta opens the user-scroll-intent window (delta-0 events are
      // filtered); the off-bottom scroll that follows then releases the lock.
      fireEvent.wheel(messageWindow, { deltaY: -120 });
      port.setScrollTop(200);
      fireEvent.scroll(messageWindow);

      await waitFor(() => {
        expect((messageWindow.firstElementChild as HTMLElement).style.overflowAnchor).toBe("");
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
