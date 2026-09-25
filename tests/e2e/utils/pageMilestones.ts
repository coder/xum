import type { Page } from "@playwright/test";

/**
 * In-page milestone timing for perf scenarios.
 *
 * Why (#4441): Playwright's `expect(...).toHave*` assertions poll with backoff
 * (+100/+250/+500/+1000 ms). Wall time measured when an assertion passes is therefore
 * quantized, and it jumps whenever a milestone moves later. After #4293 made `data-loaded`
 * wait for the full tail-first reveal, the gap between the real flip and the passing poll
 * grew from ~27 ms to ~423 ms, and it read as a regression. These timestamps come from
 * the page's own clock at the DOM change instead.
 */
export interface PageMilestones {
  /** ms from start until the first transcript row exists ("useful content ready"). */
  firstMessageMs: number | null;
  /** ms from start until the message window reports data-loaded="true" ("fully revealed"). */
  fullyLoadedMs: number | null;
  /** Longest main-thread task after start, in ms. 0 when no task exceeded the 50 ms long-task floor. */
  longestTaskMs: number;
}

const STATE_KEY = "__xumPerfMilestones";
const FIRST_MESSAGE_SELECTOR = '[data-testid="message-window"] [data-testid="chat-message"]';
const FULLY_LOADED_SELECTOR = '[data-testid="message-window"][data-loaded="true"]';

interface MilestoneState extends PageMilestones {
  stop: () => void;
}

/** Start recording milestones. Call immediately before the action being measured. */
export async function startPageMilestones(page: Page): Promise<void> {
  await page.evaluate(
    ({ stateKey, firstSelector, loadedSelector }) => {
      const host = window as unknown as Record<string, MilestoneState | undefined>;
      if (host[stateKey]) {
        throw new Error("Page milestones already started; call readPageMilestones first");
      }
      // A milestone that is already true at start would record 0 and silently measure nothing.
      if (document.querySelector(loadedSelector)) {
        throw new Error("Message window is already loaded; the milestone would be meaningless");
      }

      const t0 = performance.now();
      const state: MilestoneState = {
        firstMessageMs: null,
        fullyLoadedMs: null,
        longestTaskMs: 0,
        stop: () => undefined,
      };

      // MutationObserver callbacks run as a microtask after the DOM change, in the same task,
      // so the timestamp is not quantized by any polling interval.
      const mutationObserver = new MutationObserver(() => {
        const elapsed = performance.now() - t0;
        if (state.firstMessageMs === null && document.querySelector(firstSelector)) {
          state.firstMessageMs = elapsed;
        }
        if (state.fullyLoadedMs === null && document.querySelector(loadedSelector)) {
          state.fullyLoadedMs = elapsed;
        }
        if (state.firstMessageMs !== null && state.fullyLoadedMs !== null) {
          mutationObserver.disconnect();
        }
      });
      mutationObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-loaded"],
      });

      const recordLongTasks = (entries: PerformanceEntryList) => {
        for (const entry of entries) {
          state.longestTaskMs = Math.max(state.longestTaskMs, entry.duration);
        }
      };
      const longTaskObserver = new PerformanceObserver((list) =>
        recordLongTasks(list.getEntries())
      );
      longTaskObserver.observe({ type: "longtask" });

      state.stop = () => {
        mutationObserver.disconnect();
        // Long-task entries are delivered asynchronously; drain the queue so the last
        // task before the read is not missed.
        recordLongTasks(longTaskObserver.takeRecords());
        longTaskObserver.disconnect();
      };
      host[stateKey] = state;
    },
    {
      stateKey: STATE_KEY,
      firstSelector: FIRST_MESSAGE_SELECTOR,
      loadedSelector: FULLY_LOADED_SELECTOR,
    }
  );
}

/** Stop recording and return the milestones. */
export async function readPageMilestones(page: Page): Promise<PageMilestones> {
  const milestones = await page.evaluate((stateKey) => {
    const host = window as unknown as Record<string, MilestoneState | undefined>;
    const state = host[stateKey];
    if (!state) {
      throw new Error("Page milestones were not started");
    }
    state.stop();
    delete host[stateKey];
    return {
      firstMessageMs: state.firstMessageMs,
      fullyLoadedMs: state.fullyLoadedMs,
      longestTaskMs: state.longestTaskMs,
    };
  }, STATE_KEY);

  if (
    milestones.firstMessageMs !== null &&
    milestones.fullyLoadedMs !== null &&
    milestones.firstMessageMs > milestones.fullyLoadedMs
  ) {
    throw new Error(
      `Impossible milestone order: first message at ${milestones.firstMessageMs} ms after full load at ${milestones.fullyLoadedMs} ms`
    );
  }
  return milestones;
}

/**
 * In-page DOM timing for a chat switch, measured from the sidebar row's click event.
 *
 * startPageMilestones cannot time a switch: the message window of the chat being left is
 * already loaded. This recorder instead starts at the click event's own timestamp and treats
 * a row as "first row" only when its message id was not on screen before the click.
 */
export interface SwitchMilestones {
  /** Click event timestamp on the page's performance timeline (ms since timeOrigin). */
  clickAt: number | null;
  /** ms from the click until the transcript hydration skeleton appeared; null if it never did. */
  skeletonShownMs: number | null;
  /** ms from the click until the skeleton was removed again; null if it was never shown. */
  skeletonHiddenMs: number | null;
  /** ms from the click until a transcript row of the target chat exists. */
  firstRowMs: number | null;
  /** Longest main-thread task after the click, in ms (0 when none exceeded 50 ms). */
  longestTaskMs: number;
}

const SWITCH_STATE_KEY = "__xumPerfSwitchMilestones";
const SKELETON_SELECTOR = '[data-testid="transcript-hydration-placeholder"]';

interface SwitchMilestoneState extends SwitchMilestones {
  stop: () => void;
}

/** Arm the recorder; the next click inside `rowSelector` is time zero. */
export async function startSwitchMilestones(page: Page, rowSelector: string): Promise<void> {
  await page.evaluate(
    ({ stateKey, rowSelector, rowsSelector, skeletonSelector }) => {
      const host = window as unknown as Record<string, SwitchMilestoneState | undefined>;
      if (host[stateKey]) {
        throw new Error("Switch milestones already started; call readSwitchMilestones first");
      }
      const previousRowIds = new Set(
        Array.from(document.querySelectorAll(rowsSelector), (row) =>
          row.getAttribute("data-message-id")
        )
      );
      const state: SwitchMilestoneState = {
        clickAt: null,
        skeletonShownMs: null,
        skeletonHiddenMs: null,
        firstRowMs: null,
        longestTaskMs: 0,
        stop: () => undefined,
      };

      const sample = () => {
        if (state.clickAt === null) return;
        const elapsed = performance.now() - state.clickAt;
        const skeletonVisible = document.querySelector(skeletonSelector) !== null;
        if (state.skeletonShownMs === null && skeletonVisible) {
          state.skeletonShownMs = elapsed;
        }
        if (state.skeletonShownMs !== null && state.skeletonHiddenMs === null && !skeletonVisible) {
          state.skeletonHiddenMs = elapsed;
        }
        if (state.firstRowMs === null) {
          for (const row of document.querySelectorAll(rowsSelector)) {
            const id = row.getAttribute("data-message-id");
            if (id !== null && !previousRowIds.has(id)) {
              state.firstRowMs = elapsed;
              break;
            }
          }
        }
      };
      // Capture phase: runs before React's handler starts the switch.
      const onClick = (event: MouseEvent) => {
        if (state.clickAt !== null) return;
        if (event.target instanceof Element && event.target.closest(rowSelector)) {
          state.clickAt = event.timeStamp;
        }
      };
      document.addEventListener("click", onClick, true);
      const mutationObserver = new MutationObserver(sample);
      mutationObserver.observe(document.body, { subtree: true, childList: true });

      const recordLongTasks = (entries: PerformanceEntryList) => {
        for (const entry of entries) {
          if (state.clickAt !== null && entry.startTime >= state.clickAt) {
            state.longestTaskMs = Math.max(state.longestTaskMs, entry.duration);
          }
        }
      };
      const longTaskObserver = new PerformanceObserver((list) =>
        recordLongTasks(list.getEntries())
      );
      longTaskObserver.observe({ type: "longtask" });

      state.stop = () => {
        document.removeEventListener("click", onClick, true);
        mutationObserver.disconnect();
        recordLongTasks(longTaskObserver.takeRecords());
        longTaskObserver.disconnect();
      };
      host[stateKey] = state;
    },
    {
      stateKey: SWITCH_STATE_KEY,
      rowSelector,
      rowsSelector: `${FIRST_MESSAGE_SELECTOR}[data-message-id]`,
      skeletonSelector: SKELETON_SELECTOR,
    }
  );
}

/** Stop recording and return the switch milestones. */
export async function readSwitchMilestones(page: Page): Promise<SwitchMilestones> {
  const milestones = await page.evaluate((stateKey) => {
    const host = window as unknown as Record<string, SwitchMilestoneState | undefined>;
    const state = host[stateKey];
    if (!state) {
      throw new Error("Switch milestones were not started");
    }
    state.stop();
    delete host[stateKey];
    return {
      clickAt: state.clickAt,
      skeletonShownMs: state.skeletonShownMs,
      skeletonHiddenMs: state.skeletonHiddenMs,
      firstRowMs: state.firstRowMs,
      longestTaskMs: state.longestTaskMs,
    };
  }, SWITCH_STATE_KEY);

  if (milestones.clickAt === null) {
    throw new Error("Switch milestones never saw the row click");
  }
  return milestones;
}
