import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDom } from "../../../tests/ui/dom";

import {
  TRANSCRIPT_REVEAL_AUTO_MAX_ROWS,
  TRANSCRIPT_REVEAL_CHUNK_ROWS,
  TRANSCRIPT_REVEAL_STEP_CHARS,
  TRANSCRIPT_REVEAL_TAIL_ROWS,
} from "@/common/constants/ui";

import {
  transcriptRevealFrameScheduler,
  useBoundedTranscriptReveal,
} from "./useBoundedTranscriptReveal";

const defaultSchedule = transcriptRevealFrameScheduler.schedule;
let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  transcriptRevealFrameScheduler.schedule = defaultSchedule;
  cleanupDom?.();
  cleanupDom = null;
});

interface Row {
  id: string;
}

const rows = (count: number, prefix = "m"): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));

/**
 * Installs a manual frame scheduler for the hook (restored after each test): `flush()` runs the
 * pending callback, `cancelled` counts cancels.
 */
function manualFrames() {
  let pending: (() => void) | null = null;
  let cancelled = 0;
  const scheduleFrame = (callback: () => void) => {
    pending = callback;
    return () => {
      if (pending === callback) pending = null;
      cancelled += 1;
    };
  };
  transcriptRevealFrameScheduler.schedule = scheduleFrame;
  return {
    hasPending: () => pending !== null,
    flush: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    cancelledCount: () => cancelled,
  };
}

const alwaysSafe = () => true;

describe("useBoundedTranscriptReveal", () => {
  test("(a,b) mounts a tail first, then reveals in chunks until fully revealed", () => {
    const frames = manualFrames();
    // About the size of the largest perf fixture (xl, ~340 displayed rows): it must reveal fully
    // without any request, or the nightly perf baselines would shift with the budget.
    const messages = rows(340);
    const { result } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut: alwaysSafe,
      })
    );
    expect(result.current.isFullyRevealed).toBe(false);
    expect(result.current.fromIndex).toBe(340 - TRANSCRIPT_REVEAL_TAIL_ROWS);
    let previous = result.current.fromIndex;
    let steps = 0;
    while (!result.current.isFullyRevealed) {
      expect(frames.hasPending()).toBe(true);
      act(() => frames.flush());
      expect(result.current.fromIndex).toBeLessThan(previous);
      expect(previous - result.current.fromIndex).toBeLessThanOrEqual(TRANSCRIPT_REVEAL_CHUNK_ROWS);
      previous = result.current.fromIndex;
      steps += 1;
    }
    expect(result.current.fromIndex).toBe(0);
    expect(steps).toBe(
      Math.ceil((340 - TRANSCRIPT_REVEAL_TAIL_ROWS) / TRANSCRIPT_REVEAL_CHUNK_ROWS)
    );
    expect(frames.hasPending()).toBe(false);
  });

  test("(g) a transcript no longer than the tail is fully revealed at once", () => {
    const frames = manualFrames();
    const { result } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages: rows(TRANSCRIPT_REVEAL_TAIL_ROWS),
        isSafeCut: alwaysSafe,
      })
    );
    expect(result.current).toMatchObject({ fromIndex: 0, isFullyRevealed: true });
    expect(frames.hasPending()).toBe(false);
  });

  test("(c,d,e) tail replacement and bulk arrivals reset and cancel; small appends and prepends do neither", () => {
    const frames = manualFrames();
    let props = { workspaceId: "ws", messages: rows(300) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
      })
    );
    const initialFrom = result.current.fromIndex;
    act(() => frames.flush());
    const afterOneChunk = result.current.fromIndex;
    expect(afterOneChunk).toBeLessThan(initialFrom);

    // Small append: boundary and pending frame untouched.
    const cancelledBefore = frames.cancelledCount();
    props = { ...props, messages: [...props.messages, ...rows(3, "new")] };
    rerender();
    expect(result.current.fromIndex).toBe(afterOneChunk);
    expect(frames.cancelledCount()).toBe(cancelledBefore);
    expect(frames.hasPending()).toBe(true);

    // Prepend of more than a chunk (an older history page): the anchor keeps its row, so the
    // boundary shifts by the prepended count and the pending frame survives.
    const prepended = TRANSCRIPT_REVEAL_CHUNK_ROWS + 5;
    props = { ...props, messages: [...rows(prepended, "old"), ...props.messages] };
    rerender();
    expect(result.current.fromIndex).toBe(afterOneChunk + prepended);
    expect(frames.cancelledCount()).toBe(cancelledBefore);
    expect(frames.hasPending()).toBe(true);

    // Replaced tail (the previous newest row is gone): restart from the new tail, drop the frame.
    props = { ...props, messages: [...props.messages.slice(0, -1), ...rows(1, "replaced")] };
    rerender();
    expect(result.current.fromIndex).toBe(props.messages.length - TRANSCRIPT_REVEAL_TAIL_ROWS);
    expect(frames.cancelledCount()).toBeGreaterThan(cancelledBefore);

    // Bulk arrival (more than a chunk at once) restarts as well.
    act(() => frames.flush());
    props = {
      ...props,
      messages: [...props.messages, ...rows(TRANSCRIPT_REVEAL_CHUNK_ROWS + 1, "bulk")],
    };
    rerender();
    expect(result.current.fromIndex).toBe(props.messages.length - TRANSCRIPT_REVEAL_TAIL_ROWS);
  });

  test("(e') a few appended rows heavier than one step count as a bulk arrival", () => {
    const frames = manualFrames();
    let props = { workspaceId: "ws", messages: rows(300) };
    const heavy = new Set<string>();
    const rowWeight = (index: number) =>
      heavy.has(props.messages[index].id) ? TRANSCRIPT_REVEAL_STEP_CHARS : 1;
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
        rowWeight,
      })
    );
    while (frames.hasPending()) act(() => frames.flush());
    expect(result.current.isFullyRevealed).toBe(true);
    // Two rows, each one full step heavy, arrive together (a since-replay publishes at once).
    const appended = rows(2, "heavy");
    for (const row of appended) heavy.add(row.id);
    props = { ...props, messages: [...props.messages, ...appended] };
    rerender();
    expect(result.current.isFullyRevealed).toBe(false);
    // The tail step takes the last heavy row only: the ceiling admits one row per step.
    expect(result.current.fromIndex).toBe(props.messages.length - 1);
  });

  test("(p) a prepend onto a fully revealed transcript mounts at once", () => {
    const frames = manualFrames();
    let props = { workspaceId: "ws", messages: rows(TRANSCRIPT_REVEAL_TAIL_ROWS) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
      })
    );
    expect(result.current.isFullyRevealed).toBe(true);
    props = { ...props, messages: [...rows(200, "old"), ...props.messages] };
    rerender();
    expect(result.current).toMatchObject({ fromIndex: 0, isFullyRevealed: true });
    expect(frames.hasPending()).toBe(false);
  });

  test("(f) a vanished anchor falls back to a safe cut at or before its index hint, never 0", () => {
    // Hold every step so only the boundary logic under test moves fromIndex.
    manualFrames();
    let props = { workspaceId: "ws", messages: rows(300) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
      })
    );
    const anchorIndex = result.current.fromIndex;
    // Remove the anchor row itself (same epoch, e.g. a reconciliation that kept the epoch).
    props = { ...props, messages: props.messages.filter((_, index) => index !== anchorIndex) };
    rerender();
    expect(result.current.isFullyRevealed).toBe(false);
    expect(result.current.fromIndex).toBe(anchorIndex);
  });

  test("(f') after a prepend, a vanished anchor falls back to where it was last seen", () => {
    manualFrames();
    let props = { workspaceId: "ws", messages: rows(300) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
      })
    );
    // An older page arrives above the anchor, then the anchor row itself goes away. The fallback
    // must use the shifted index, not the pre-prepend one (which would mount the page at once).
    const prepended = 50;
    props = { ...props, messages: [...rows(prepended, "old"), ...props.messages] };
    rerender();
    const shiftedAnchorIndex = result.current.fromIndex;
    expect(shiftedAnchorIndex).toBe(300 - TRANSCRIPT_REVEAL_TAIL_ROWS + prepended);
    props = {
      ...props,
      messages: props.messages.filter((_, index) => index !== shiftedAnchorIndex),
    };
    rerender();
    expect(result.current.fromIndex).toBe(shiftedAnchorIndex);
  });

  test("(i,k) never cuts inside a bundle and computes each cut from the grouping current at execution", () => {
    const frames = manualFrames();
    const messages = rows(200);
    // Bundle A spans [150, 170), bundle B spans [80, 130). Heads (150, 80) are safe cuts.
    let bundles: Array<[number, number]> = [
      [150, 170],
      [80, 130],
    ];
    const isSafeCut = (index: number) =>
      !bundles.some(([head, end]) => index > head && index < end);
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut,
      })
    );
    // 200 - 40 = 160 lies inside bundle A → the cut moves to its head.
    expect(result.current.fromIndex).toBe(150);
    // Grouping changes while the frame is pending: bundle B now spans [60, 130).
    bundles = [
      [150, 170],
      [60, 130],
    ];
    act(() => frames.flush());
    // 150 - 60 = 90 is inside the CURRENT bundle B → cut at its current head, 60 (not 80).
    expect(result.current.fromIndex).toBe(60);
    // Grouping changes again so a bundle spans the anchor row itself (e.g. a density switch):
    // the found anchor is re-validated too and the boundary moves to that bundle's head.
    bundles = [
      [150, 170],
      [50, 70],
    ];
    rerender();
    expect(result.current.fromIndex).toBe(50);
    while (!result.current.isFullyRevealed) act(() => frames.flush());
    expect(result.current.fromIndex).toBe(0);
  });

  test("(k') a boundary the grouping pulled back stays there when the grouping changes back", () => {
    const frames = manualFrames();
    const messages = rows(200);
    let bundles: Array<[number, number]> = [];
    const isSafeCut = (index: number) =>
      !bundles.some(([head, end]) => index > head && index < end);
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut,
      })
    );
    expect(result.current.fromIndex).toBe(160);
    // normal → hyper density: a work bundle comes to span the anchor row (160) → its head.
    bundles = [[140, 175]];
    rerender();
    expect(result.current.fromIndex).toBe(140);
    // hyper → normal: the bundle is gone again. Rows 140..159 were already mounted; the cut
    // must not advance back to 160 and unmount them.
    bundles = [];
    rerender();
    expect(result.current.fromIndex).toBe(140);
    // The step after the move continues from the persisted boundary.
    act(() => frames.flush());
    expect(result.current.fromIndex).toBe(140 - TRANSCRIPT_REVEAL_CHUNK_ROWS);
  });

  test("(l') a frame scheduled before a tail replacement that re-chose the same anchor is dropped", () => {
    // A scheduler whose cancel is a no-op, so an already-cancelled (stale) callback can still be
    // invoked — the way a frame that slipped past cancellation would fire.
    const scheduled: Array<() => void> = [];
    transcriptRevealFrameScheduler.schedule = (callback) => {
      scheduled.push(callback);
      return () => undefined;
    };
    let props = { workspaceId: "ws", messages: rows(300) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({ ...props, isSafeCut: alwaysSafe })
    );
    const initialFrom = result.current.fromIndex;
    expect(scheduled).toHaveLength(1);
    const stale = scheduled[0];
    // The newest row is replaced by another single row before the first step ran: same length,
    // so the reset's tail cut lands on the same anchor row as before.
    props = { ...props, messages: [...props.messages.slice(0, -1), ...rows(1, "replaced")] };
    rerender();
    expect(result.current.fromIndex).toBe(initialFrom);
    // The reset scheduled its own generation's frame…
    expect(scheduled).toHaveLength(2);
    // …and the older generation's frame, firing late, must not mount a chunk ahead of the reset
    // tail's paint.
    act(() => stale());
    expect(result.current.fromIndex).toBe(initialFrom);
    // Only the new generation's frame moves the boundary, by exactly one step.
    act(() => scheduled[1]());
    expect(result.current.fromIndex).toBe(initialFrom - TRANSCRIPT_REVEAL_CHUNK_ROWS);
  });

  test("an empty transcript that fills starts tail-first, judged by the initial-tail limits", () => {
    // Hold every step so only the boundary logic under test moves fromIndex.
    manualFrames();
    let props = { workspaceId: "ws", messages: rows(0) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
      })
    );
    expect(result.current.fromIndex).toBe(0);
    // 50 rows fit one 60-row chunk but not the 40-row initial tail: the skeleton clearing must
    // paint the tail, not everything at once.
    props = { ...props, messages: rows(50) };
    rerender();
    expect(result.current.fromIndex).toBe(50 - TRANSCRIPT_REVEAL_TAIL_ROWS);
    expect(result.current.isFullyRevealed).toBe(false);
  });

  test("(j) across randomized appends, deletions and grouping changes, eligible ids only grow", () => {
    const frames = manualFrames();
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let messages = rows(400);
    let bundleHeads = new Set<number>();
    let nextId = 400;
    const isSafeCut = (index: number) => {
      // Rows within 5 after a bundle head are inside that bundle.
      for (const head of bundleHeads) if (index > head && index < head + 6) return false;
      return true;
    };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut,
      })
    );
    const eligible = () => new Set(messages.slice(result.current.fromIndex).map((row) => row.id));
    let previous = eligible();
    for (let step = 0; step < 200; step += 1) {
      const roll = random();
      if (roll < 0.3) {
        messages = [...messages, { id: `m-${nextId++}` }];
      } else if (roll < 0.45 && messages.length > 50) {
        // Delete a row below the boundary (streaming never deletes eligible rows; a
        // reconciliation that replaces the tail restarts the reveal instead).
        const index = Math.floor(random() * Math.max(1, result.current.fromIndex - 1));
        messages = messages.filter((_, i) => i !== index);
      } else if (roll < 0.6) {
        bundleHeads = new Set(
          Array.from({ length: 5 }, () => Math.floor(random() * messages.length))
        );
      }
      rerender();
      if (frames.hasPending() && random() < 0.5) act(() => frames.flush());
      const current = eligible();
      for (const id of previous) {
        if (messages.some((row) => row.id === id)) expect(current.has(id)).toBe(true);
      }
      previous = current;
    }
  });

  test("(m) the weight ceiling bounds a step of heavy rows, taking at least one row per step", () => {
    const frames = manualFrames();
    // Alternating light prompt / heavy reply, like a long code-block-heavy chat: a heavy row
    // weighs half the ceiling, so a step takes at most two heavy rows (plus the light rows).
    const messages = rows(200);
    const heavy = TRANSCRIPT_REVEAL_STEP_CHARS / 2;
    const rowWeight = (index: number) => (index % 2 === 1 ? heavy : 50);
    const { result } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut: alwaysSafe,
        rowWeight,
      })
    );
    const stepWeight = (from: number, to: number) => {
      let total = 0;
      for (let index = from; index < to; index++) total += rowWeight(index);
      return total;
    };
    // Tail walk: 199 (heavy, ½) + 198 (light) fit; adding 197 (heavy) would exceed the ceiling
    // by the light row's weight → the tail is [198, 200), not TAIL_ROWS rows.
    expect(result.current.fromIndex).toBe(198);
    let previous = result.current.fromIndex;
    while (!result.current.isFullyRevealed) {
      act(() => frames.flush());
      const next = result.current.fromIndex;
      expect(next).toBeLessThan(previous);
      // Every step exceeds the ceiling by at most its first (always taken) row.
      expect(stepWeight(next, previous) - rowWeight(next)).toBeLessThanOrEqual(
        TRANSCRIPT_REVEAL_STEP_CHARS
      );
      previous = next;
    }
  });

  test("(n) one row heavier than the ceiling still mounts as its own step", () => {
    const frames = manualFrames();
    const messages = rows(3);
    const { result } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut: alwaysSafe,
        rowWeight: () => TRANSCRIPT_REVEAL_STEP_CHARS * 10,
      })
    );
    expect(result.current.fromIndex).toBe(2);
    act(() => frames.flush());
    expect(result.current.fromIndex).toBe(1);
    act(() => frames.flush());
    expect(result.current.fromIndex).toBe(0);
    expect(result.current.isFullyRevealed).toBe(true);
  });

  test("(o) a bundle straddling the weight cut mounts whole (the documented exception)", () => {
    const frames = manualFrames();
    const messages = rows(50);
    // Rows 40..44 form a bundle whose head is 40; each row weighs 40% of the ceiling.
    const isSafeCut = (index: number) => !(index > 40 && index < 45);
    const { result } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut,
        rowWeight: () => TRANSCRIPT_REVEAL_STEP_CHARS * 0.4,
      })
    );
    // Weight allows rows 48, 49 only (a third row would exceed the ceiling) → cut 48 is safe.
    expect(result.current.fromIndex).toBe(48);
    act(() => frames.flush());
    // Next step: 46, 47 by weight → 46 is safe (outside the bundle).
    expect(result.current.fromIndex).toBe(46);
    act(() => frames.flush());
    // Next step: 44, 45 by weight → 44 is inside the bundle → the cut moves to its head, 40.
    expect(result.current.fromIndex).toBe(40);
  });

  describe("automatic reveal budget", () => {
    const LONG = TRANSCRIPT_REVEAL_AUTO_MAX_ROWS * 3;
    const mounted = (fromIndex: number) => LONG - fromIndex;

    function renderLong(frames: ReturnType<typeof manualFrames>) {
      let props = { workspaceId: "ws", messages: rows(LONG) };
      const view = renderHook(() =>
        useBoundedTranscriptReveal({ ...props, isSafeCut: alwaysSafe })
      );
      const runFrames = () => {
        while (frames.hasPending()) act(() => frames.flush());
      };
      const setProps = (next: Partial<typeof props>) => {
        props = { ...props, ...next };
        view.rerender();
      };
      return { ...view, runFrames, setProps, messages: () => props.messages };
    }

    test("pauses once the budget is mounted, and Load older resumes it by one budget", () => {
      const frames = manualFrames();
      const { result, runFrames } = renderLong(frames);
      runFrames();
      expect(result.current.isRevealPaused).toBe(true);
      expect(result.current.isFullyRevealed).toBe(false);
      expect(frames.hasPending()).toBe(false);
      const firstPause = mounted(result.current.fromIndex);
      expect(firstPause).toBeGreaterThanOrEqual(TRANSCRIPT_REVEAL_AUTO_MAX_ROWS);
      expect(firstPause).toBeLessThan(
        TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS
      );

      act(() => result.current.revealMore());
      expect(result.current.isRevealPaused).toBe(false);
      runFrames();
      expect(result.current.isRevealPaused).toBe(true);
      const secondPause = mounted(result.current.fromIndex);
      expect(secondPause).toBeGreaterThanOrEqual(firstPause + TRANSCRIPT_REVEAL_AUTO_MAX_ROWS);
      expect(secondPause).toBeLessThan(
        firstPause + TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS
      );

      // Fewer rows than a budget remain: the next request reveals the rest.
      act(() => result.current.revealMore());
      runFrames();
      expect(result.current).toMatchObject({
        fromIndex: 0,
        isFullyRevealed: true,
        isRevealPaused: false,
      });
    });

    test("a navigation to a row far above a paused boundary reveals down to it, then stops", () => {
      const frames = manualFrames();
      const { result, runFrames } = renderLong(frames);
      runFrames();
      expect(result.current.isRevealPaused).toBe(true);
      const target = Math.floor(result.current.fromIndex / 4);

      act(() => result.current.revealThrough(target));
      expect(result.current.isRevealPaused).toBe(false);
      runFrames();
      // The target row is mounted, at most one chunk past it, and the reveal paused again.
      expect(result.current.fromIndex).toBeLessThanOrEqual(target);
      expect(target - result.current.fromIndex).toBeLessThan(TRANSCRIPT_REVEAL_CHUNK_ROWS);
      expect(result.current.isRevealPaused).toBe(true);
      expect(frames.hasPending()).toBe(false);

      // A row already mounted is a no-op.
      act(() => result.current.revealThrough(result.current.fromIndex));
      expect(frames.hasPending()).toBe(false);
    });

    test("a navigation target that disappears stops the reveal it started", () => {
      const frames = manualFrames();
      const { result, runFrames, setProps, messages } = renderLong(frames);
      runFrames();
      const target = 10;
      const targetId = messages()[target].id;
      act(() => result.current.revealThrough(target));
      act(() => frames.flush());
      expect(frames.hasPending()).toBe(true);
      setProps({ messages: messages().filter((row) => row.id !== targetId) });
      expect(result.current.isRevealPaused).toBe(true);
      expect(frames.hasPending()).toBe(false);
    });

    test("a restart resets the budget and drops a pending navigation target", () => {
      const frames = manualFrames();
      const { result, runFrames, setProps } = renderLong(frames);
      runFrames();
      act(() => result.current.revealMore());
      act(() => result.current.revealThrough(0));
      // Switch to another long workspace before either request finished. Its row ids match the
      // old ones, so a target carried across the restart would still be found (not dropped as
      // vanished) and would reveal every row.
      setProps({ workspaceId: "ws-2", messages: rows(LONG) });
      runFrames();
      expect(result.current.isRevealPaused).toBe(true);
      expect(mounted(result.current.fromIndex)).toBeLessThan(
        TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS
      );
    });
  });
});
