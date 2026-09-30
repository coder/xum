import React, { useEffect, useState } from "react";
import { cn } from "@/common/lib/utils";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import type { PlanHeading } from "./extractPlanHeadings";

/**
 * Sticky table of contents rendered alongside a plan in the chat transcript.
 *
 * Layout:
 * - At intermediate widths the left gutter shows only sideways hint text so
 *   users can discover that widening the transcript reveals the TOC.
 * - When the transcript container is wide enough, CSS reveals the same sticky
 *   left-gutter nav (see `.plan-toc-aside` in globals.css). The sticky container
 *   follows the user while the plan is on screen, then naturally scrolls away
 *   once the plan exits the viewport.
 *
 * Heading navigation is index-based: each entry stores its position among ALL
 * h1..h6 elements the plan renders, so clicking a TOC item does
 * `container.querySelectorAll("h1,h2,h3,h4,h5,h6")[renderIndex].scrollIntoView()`.
 * This avoids touching the shared markdown rehype pipeline just for plan TOC.
 */
export interface PlanTableOfContentsProps {
  /** Heading entries extracted from the plan markdown, in document order. */
  entries: PlanHeading[];
  /**
   * Ref to a DOM container whose subtree owns the rendered plan headings.
   * Must be a stable ancestor of the markdown output for `scrollIntoView` to
   * locate the right element.
   */
  contentRef: React.RefObject<HTMLElement | null>;
  /**
   * Heading rendered at the top of the TOC. Defaults to "Contents".
   *
   * The plan title is the natural label for a plan TOC, so we let the host
   * surface it here — that conserves vertical space (no separate "CONTENTS"
   * label *and* an h1 list entry) and tightens the visual hierarchy: the
   * title sits at column 0, h2 entries align with it, and h3+ are indented
   * under their parent h2.
   */
  title?: string;
  className?: string;
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const DEFAULT_HEADING = "Contents";

/**
 * Distance in pixels from the top of the scrollport (or viewport) at which a
 * heading is considered "passed" by the reader. The active TOC entry is the
 * last heading (in document order) whose top edge has crossed this line.
 *
 * Matches `scroll-margin-top: 1rem` on plan headings so the indicator updates
 * exactly when scroll-into-view lands a heading at its resting position.
 */
const ACTIVE_TRIGGER_OFFSET_PX = 16;

/**
 * Walk up the DOM to find the nearest ancestor that establishes a scroll
 * context. Using that ancestor as the IntersectionObserver root means our
 * trigger line is anchored to the user's actual reading frame (the transcript
 * scrollport) instead of the browser viewport. Falls back to the viewport
 * (`null`) when no scrolling ancestor is found, which still yields correct
 * relative-position events.
 */
function findScrollAncestor(start: HTMLElement | null): HTMLElement | null {
  let current = start?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export const PlanTableOfContents: React.FC<PlanTableOfContentsProps> = (props) => {
  // h1 is reserved for the TOC's heading (the plan title), so it never appears
  // as a list entry — but it still consumes a renderIndex because the rendered
  // DOM still contains an <h1>. h5/h6 are also hidden as visual noise.
  const visibleEntries = props.entries.filter((entry) => entry.level >= 2 && entry.level <= 4);
  // If the plan's source markdown begins with an h1, clicking the TOC heading
  // jumps to that h1 (the natural "top of plan" target). Otherwise the heading
  // is a static label — there's nothing meaningful to scroll to.
  const titleHeadingEntry = props.entries.find((entry) => entry.level === 1);

  // Track which heading the reader has most recently scrolled past so the TOC
  // can highlight it. `null` means we're still above the first tracked heading.
  const [activeRenderIndex, setActiveRenderIndex] = useState<number | null>(null);

  // Reset the active indicator whenever the set of tracked headings changes
  // (e.g. during streaming or when the user reopens a different plan). The
  // observer effect below will recompute the correct value on its next tick.
  const titleTrackedKey = titleHeadingEntry?.renderIndex ?? -1;
  const trackedKey = `${titleTrackedKey}|${visibleEntries.map((entry) => entry.renderIndex).join(",")}`;
  const hasEnoughVisibleEntries = visibleEntries.length >= 2;

  useEffect(() => {
    // Mirror the visibility gate from render so we don't observe headings the
    // user can't navigate to. The render path bails out early in that case.
    if (!hasEnoughVisibleEntries) return;
    const container = props.contentRef.current;
    if (!container) return;

    // Re-query headings from the live DOM so renderIndexes line up with the
    // index-based `querySelectorAll` lookup used for click navigation.
    const allHeadings = Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
    // Track both the title heading and the list entries so the title can
    // also light up when the reader is in its lead-in section.
    const trackedIndexes = new Set<number>();
    for (const entry of props.entries) {
      if (entry.level === 1 || (entry.level >= 2 && entry.level <= 4)) {
        trackedIndexes.add(entry.renderIndex);
      }
    }
    const tracked = allHeadings.flatMap<{ el: HTMLElement; renderIndex: number }>((el, idx) =>
      trackedIndexes.has(idx) ? [{ el, renderIndex: idx }] : []
    );
    if (tracked.length === 0) return;

    const root = findScrollAncestor(container);
    // We use a scroll listener (rAF-throttled) rather than IntersectionObserver
    // because the active heading needs to update continuously as the user
    // scrolls THROUGH a section, not just at the section's entry/exit points.
    // IO with `threshold: 0` only fires when a heading enters or leaves the
    // root; while a heading is fully in view the IO is silent, so the active
    // indicator would not advance when the heading's top crosses the trigger
    // line mid-scroll. The per-frame rect read is O(N) over the tracked
    // headings, which is cheap for typical plan sizes.
    let rafId: number | null = null;

    const recompute = () => {
      rafId = null;
      // Compute the trigger line in viewport coordinates. `root` of `null`
      // means the viewport itself is the scrolling frame.
      const rootTop = root?.getBoundingClientRect().top ?? 0;
      const trigger = rootTop + ACTIVE_TRIGGER_OFFSET_PX;

      let active: number | null = null;
      for (const { el, renderIndex } of tracked) {
        if (el.getBoundingClientRect().top <= trigger) active = renderIndex;
      }
      setActiveRenderIndex(active);
    };

    const schedule = () => {
      if (rafId !== null) return;
      // requestAnimationFrame coalesces bursts of scroll events into a single
      // recompute per frame; tests that lack rAF fall back to a sync compute.
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(recompute);
      } else {
        recompute();
      }
    };

    // Initial sync so the indicator reflects current scroll position on mount.
    recompute();

    const scrollTarget: EventTarget = root ?? window;
    scrollTarget.addEventListener("scroll", schedule, { passive: true });
    // Resizing the window can also change the trigger line's viewport y
    // coordinate (when the root is offset from the viewport top), so refresh
    // on resize too.
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      scrollTarget.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
    // `trackedKey` is the stable summary of which headings to observe;
    // recreating the listener when it changes covers streaming plan growth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedKey, hasEnoughVisibleEntries, props.contentRef]);

  if (!hasEnoughVisibleEntries) {
    // A TOC with 0 or 1 entries adds visual chrome without navigation value.
    // (Note: this check intentionally excludes the title, since the title is
    // a single label, not a navigable destination on its own.)
    return null;
  }

  // Normalize indentation: anchor the shallowest visible level at column 0 so
  // a plan that starts at "###" doesn't look uniformly indented.
  const minLevel = Math.min(...visibleEntries.map((entry) => entry.level));

  const handleNavigate = (renderIndex: number) => {
    const container = props.contentRef.current;
    if (!container) return;
    const headings = container.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
    const target = headings.item(renderIndex);
    // `scrollIntoView` is not implemented by happy-dom in unit tests; the guard
    // keeps tests from crashing while still exercising the lookup path.
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    }
    // Optimistically reflect the destination as active so the indicator doesn't
    // visibly lag behind smooth scroll animations. The observer will confirm
    // (or correct) this once the heading settles at its resting position.
    setActiveRenderIndex(renderIndex);
  };

  // Use the supplied title when non-blank; fall back to "Contents" otherwise.
  // Treat "  " as blank — a whitespace-only title would render as an empty
  // heading line and look broken.
  const trimmedTitle = props.title?.trim();
  const headingText = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : DEFAULT_HEADING;
  const isTitleActive = activeRenderIndex === titleHeadingEntry?.renderIndex;

  return (
    <aside
      className={cn("plan-toc-aside", props.className)}
      aria-label="Plan contents"
      // At intermediate widths CSS shows only the sideways hint; at wide widths
      // it hides the hint and reveals the sticky nav in the same left gutter.
      // The aside itself stays pointer-events:none so margin clicks fall through
      // to transcript chrome; only the inner nav becomes interactive.
      data-testid="plan-toc"
    >
      <div className="plan-toc-compact-hint" aria-hidden="true">
        Expand to see ToC
      </div>
      <nav className="plan-toc" data-testid="plan-toc-nav">
        {titleHeadingEntry ? (
          <TooltipIfPresent tooltip={headingText} side="right" align="start">
            <button
              type="button"
              className={cn(
                "plan-toc-heading plan-toc-heading-link",
                isTitleActive && "plan-toc-heading-link-active"
              )}
              // `aria-current="location"` signals to assistive tech that this
              // is the section currently in view, the standard ARIA pattern
              // for an in-page TOC indicator.
              aria-current={isTitleActive ? "location" : undefined}
              onClick={() => handleNavigate(titleHeadingEntry.renderIndex)}
            >
              {headingText}
            </button>
          </TooltipIfPresent>
        ) : (
          <div className="plan-toc-heading">{headingText}</div>
        )}
        <ul className="plan-toc-list">
          {visibleEntries.map((entry) => {
            const isActive = activeRenderIndex === entry.renderIndex;
            return (
              <li
                key={entry.renderIndex}
                className="plan-toc-item"
                data-level={entry.level - minLevel + 1}
                // `data-active` lets CSS style the whole row (e.g. a left
                // accent rail) while `aria-current` on the button announces
                // the active section to screen readers.
                data-active={isActive ? "true" : undefined}
              >
                {/*
                 * Wrap with TooltipIfPresent so users can see the full heading
                 * in one place even when the side TOC wraps long text across
                 * multiple lines in the gutter.
                 *
                 * `side="right"` keeps the tooltip from drifting off the left
                 * edge of the transcript — the toc lives in the left gutter.
                 */}
                <TooltipIfPresent tooltip={entry.text} side="right" align="start">
                  <button
                    type="button"
                    className="plan-toc-link"
                    // `aria-current="location"` signals to assistive tech that
                    // this section is currently in view; CSS styling keys off
                    // the parent <li>'s `data-active` attribute.
                    aria-current={isActive ? "location" : undefined}
                    onClick={() => handleNavigate(entry.renderIndex)}
                  >
                    {entry.text}
                  </button>
                </TooltipIfPresent>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
};
