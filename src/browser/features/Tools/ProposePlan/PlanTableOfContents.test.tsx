import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { PlanTableOfContents } from "./PlanTableOfContents";
import type { PlanHeading } from "./extractPlanHeadings";

/**
 * Stub a heading's `getBoundingClientRect` to simulate the user having
 * scrolled to a particular position. The active-heading effect reads
 * `boundingClientRect.top` on every recompute, so overriding this method per
 * heading is enough to drive the trigger logic in tests without needing real
 * layout from happy-dom.
 */
function stubHeadingTop(el: HTMLElement, top: number): void {
  const rect: DOMRect = {
    top,
    bottom: top + 20,
    left: 0,
    right: 100,
    width: 100,
    height: 20,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
  el.getBoundingClientRect = () => rect;
}

/**
 * Disable the rAF coalescing in the active-heading effect so a synchronous
 * scroll event triggers an immediate recompute. The effect feature-detects
 * `requestAnimationFrame`; replacing the global with `undefined` exercises the
 * sync fallback path.
 */
function withSyncAnimationFrame<T>(run: () => T): T {
  const previous = (globalThis as unknown as { requestAnimationFrame?: unknown })
    .requestAnimationFrame;
  // eslint-disable-next-line local/no-clear-dom-global -- restored in the finally below
  (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
  try {
    return run();
  } finally {
    (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = previous;
  }
}

/**
 * Renders the PlanTableOfContents against a hand-rolled DOM that contains real
 * <h1>/<h2>/<h3> elements. We test the click → scrollIntoView wiring here
 * (instead of inside ProposePlanToolCall.test.tsx) because sibling test files
 * mock MarkdownCore at file scope; those mocks make Streamdown render plain text
 * without heading tags, which would break index-based DOM lookups.
 */
function HarnessRenderer({ entries, title }: { entries: PlanHeading[]; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <PlanTableOfContents entries={entries} contentRef={ref} title={title} />
      <div ref={ref} data-testid="plan-body">
        <h1>Intro</h1>
        <p>...</p>
        <h2>First section</h2>
        <p>...</p>
        <h2>Second section</h2>
        <p>...</p>
        <h3>Nested</h3>
      </div>
    </div>
  );
}

describe("PlanTableOfContents", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("returns null when there are fewer than two visible (h2-h4) entries", () => {
    // A lone h1 produces zero list entries (h1 is reserved for the heading)
    // and would leave a TOC with only a title — useless for navigation.
    const view = render(<HarnessRenderer entries={[{ renderIndex: 0, level: 1, text: "Only" }]} />);
    expect(view.queryByTestId("plan-toc")).toBeNull();
  });

  test("ignores deeply nested headings (h5/h6) for display", () => {
    const view = render(
      <HarnessRenderer
        entries={[
          { renderIndex: 0, level: 5, text: "Too deep one" },
          { renderIndex: 1, level: 6, text: "Too deep two" },
        ]}
      />
    );
    // Both entries are filtered out as too-deep, leaving 0 visible — TOC hidden.
    expect(view.queryByTestId("plan-toc")).toBeNull();
  });

  test("filters h1 entries out of the navigation list (they live in the heading)", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 1, text: "Intro" },
      { renderIndex: 1, level: 2, text: "First section" },
      { renderIndex: 2, level: 2, text: "Second section" },
    ];

    const view = render(<HarnessRenderer entries={entries} title="My Plan" />);

    // h2 entries remain as navigable buttons; h1 does not.
    expect(view.getByRole("button", { name: "First section" })).toBeDefined();
    expect(view.getByRole("button", { name: "Second section" })).toBeDefined();
    expect(view.queryByRole("button", { name: "Intro" })).toBeNull();
  });

  test("renders the supplied title as the TOC heading", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 2, text: "A" },
      { renderIndex: 1, level: 2, text: "B" },
    ];

    const view = render(<HarnessRenderer entries={entries} title="My Plan Title" />);
    const toc = view.getByTestId("plan-toc");
    expect(toc.textContent).toContain("My Plan Title");
    // Without any h1 in entries, the heading should NOT be a clickable button.
    expect(view.queryByRole("button", { name: "My Plan Title" })).toBeNull();
  });

  test("clicking the TOC heading scrolls to the plan's h1 when one exists", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 1, text: "Plan Title From Markdown" },
      { renderIndex: 1, level: 2, text: "First section" },
      { renderIndex: 2, level: 2, text: "Second section" },
    ];

    const view = render(<HarnessRenderer entries={entries} title="Plan Title From Markdown" />);

    const headings = Array.from(view.container.querySelectorAll<HTMLElement>("h1, h2, h3"));
    const scrollCalls: Array<{ target: HTMLElement; options: ScrollIntoViewOptions }> = [];
    for (const heading of headings) {
      heading.scrollIntoView = ((options: ScrollIntoViewOptions) => {
        scrollCalls.push({ target: heading, options });
      }) as HTMLElement["scrollIntoView"];
    }

    fireEvent.click(view.getByRole("button", { name: "Plan Title From Markdown" }));
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].target).toBe(headings[0]); // the h1
  });

  test("scrolls the correct rendered heading into view when an entry is clicked", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 1, text: "Intro" },
      { renderIndex: 1, level: 2, text: "First section" },
      { renderIndex: 2, level: 2, text: "Second section" },
      { renderIndex: 3, level: 3, text: "Nested" },
    ];

    const view = render(<HarnessRenderer entries={entries} />);

    const headings = Array.from(view.container.querySelectorAll<HTMLElement>("h1, h2, h3"));
    expect(headings).toHaveLength(4);

    const scrollCalls: Array<{ target: HTMLElement; options: ScrollIntoViewOptions }> = [];
    for (const heading of headings) {
      heading.scrollIntoView = ((options: ScrollIntoViewOptions) => {
        scrollCalls.push({ target: heading, options });
      }) as HTMLElement["scrollIntoView"];
    }

    fireEvent.click(view.getByRole("button", { name: "Second section" }));

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].target).toBe(headings[2]);
    // Top alignment ensures the heading lands just below the scrollport edge.
    expect(scrollCalls[0].options.block).toBe("start");
  });

  test("active indicator follows the last heading that has crossed the trigger as the user scrolls", () => {
    withSyncAnimationFrame(() => {
      const entries: PlanHeading[] = [
        { renderIndex: 0, level: 1, text: "Intro" },
        { renderIndex: 1, level: 2, text: "First section" },
        { renderIndex: 2, level: 2, text: "Second section" },
      ];

      const view = render(<HarnessRenderer entries={entries} title="Intro" />);
      const headings = Array.from(
        view.container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      );

      // Simulate the reader having scrolled so the first h2's top edge has
      // crossed the 16px trigger (top=-100) but the second h2 is still below
      // (top=400). The active entry must be "First section".
      stubHeadingTop(headings[0], -200); // h1: well above trigger
      stubHeadingTop(headings[1], -100); // first h2: above trigger
      stubHeadingTop(headings[2], 400); // second h2: below trigger

      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });

      let activeBtn = view.container.querySelector<HTMLElement>('[aria-current="location"]');
      expect(activeBtn?.textContent).toBe("First section");

      // Reader continues scrolling: second h2 also crosses above the trigger.
      // Active must advance to "Second section" — this is the case Codex
      // flagged where an IO-based implementation would miss the mid-scroll
      // transition because both headings are still inside the root.
      stubHeadingTop(headings[2], 10); // second h2: just above trigger now

      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });

      activeBtn = view.container.querySelector<HTMLElement>('[aria-current="location"]');
      expect(activeBtn?.textContent).toBe("Second section");

      // The active <li> also carries data-active="true" for CSS styling.
      const activeItem = view.container.querySelector<HTMLElement>(
        '.plan-toc-item[data-active="true"]'
      );
      expect(activeItem?.textContent).toContain("Second section");
    });
  });

  test("active indicator clears when the reader scrolls back above all tracked headings", () => {
    withSyncAnimationFrame(() => {
      // Map entries to the harness DOM: renderIndex aligns with the document
      // order of <h1>/<h2>/<h3> elements in HarnessRenderer.
      const entries: PlanHeading[] = [
        { renderIndex: 1, level: 2, text: "First section" },
        { renderIndex: 2, level: 2, text: "Second section" },
      ];

      const view = render(<HarnessRenderer entries={entries} />);
      const headings = Array.from(
        view.container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      );

      // Scroll so the first h2 is just above the trigger.
      stubHeadingTop(headings[1], -10);
      stubHeadingTop(headings[2], 500);
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(view.container.querySelector('[aria-current="location"]')?.textContent).toBe(
        "First section"
      );

      // Scroll back so all headings are below the trigger: nothing active.
      stubHeadingTop(headings[1], 200);
      stubHeadingTop(headings[2], 700);
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(view.container.querySelector('[aria-current="location"]')).toBeNull();
    });
  });

  test("clicking a TOC entry marks it active immediately so the indicator does not lag scroll", () => {
    withSyncAnimationFrame(() => {
      const entries: PlanHeading[] = [
        { renderIndex: 1, level: 2, text: "First section" },
        { renderIndex: 2, level: 2, text: "Second section" },
        { renderIndex: 3, level: 3, text: "Nested" },
      ];

      const view = render(<HarnessRenderer entries={entries} />);

      // Position all headings below the trigger so nothing is active on mount.
      const headings = Array.from(
        view.container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      );
      headings.forEach((el) => stubHeadingTop(el, 500));
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(view.container.querySelector('[aria-current="location"]')).toBeNull();

      // Click the LAST entry; its active state must immediately reflect the
      // click rather than waiting for the scroll handler to fire post-animation.
      fireEvent.click(view.getByRole("button", { name: "Nested" }));

      const active = view.container.querySelectorAll<HTMLElement>('[aria-current="location"]');
      expect(active).toHaveLength(1);
      expect(active[0].textContent).toBe("Nested");
    });
  });

  test("normalizes indentation so the shallowest visible level sits at column 0", () => {
    // With h1 reserved for the heading, h2 (the shallowest visible) should
    // render at data-level=1, and h3 at data-level=2.
    const view = render(
      <HarnessRenderer
        entries={[
          { renderIndex: 0, level: 1, text: "Title" },
          { renderIndex: 1, level: 2, text: "Section" },
          { renderIndex: 2, level: 3, text: "Subsection" },
        ]}
      />
    );

    const items = view.container.querySelectorAll<HTMLElement>(".plan-toc-item");
    expect(items).toHaveLength(2);
    expect(items[0].dataset.level).toBe("1");
    expect(items[1].dataset.level).toBe("2");
  });
});
