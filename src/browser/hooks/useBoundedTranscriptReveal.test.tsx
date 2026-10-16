import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDom } from "../../../tests/ui/dom";

import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";

import {
  TRANSCRIPT_MAX_MOUNTED_ROWS,
  TRANSCRIPT_REVEAL_AUTO_MAX_ROWS,
  TRANSCRIPT_REVEAL_CHUNK_ROWS,
  TRANSCRIPT_REVEAL_STEP_CHARS,
  TRANSCRIPT_REVEAL_TAIL_ROWS,
} from "@/common/constants/ui";
import { createMuxMessage } from "@/common/types/message";

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

  // #4961 F20: an opt-in cap on mounted rows; reading back unmounts the newest rows.
  describe("two-sided slice (maxMountedRows)", () => {
    const LONG = TRANSCRIPT_MAX_MOUNTED_ROWS * 4;
    const MAX = TRANSCRIPT_MAX_MOUNTED_ROWS;
    const LATEST = { fromIndex: LONG - TRANSCRIPT_REVEAL_TAIL_ROWS, toIndex: LONG };
    // Bundles of 10 rows: a slice edge must land on a multiple of 10 (or the transcript end).
    const bundled = (index: number) => index % 10 === 0;

    function renderSlice(maxMountedRows?: number, isSafeCut = bundled, messages = rows(LONG)) {
      const frames = manualFrames();
      let props = {
        workspaceId: "ws",
        messages,
        maxMountedRows,
        isSafeCut,
        followsTail: true,
        readVisibleMessageIds: undefined as (() => readonly string[]) | undefined,
      };
      const renders: Array<{ from: number; to: number }> = [];
      const view = renderHook(() => {
        const reveal = useBoundedTranscriptReveal(props);
        renders.push({ from: reveal.fromIndex, to: reveal.toIndex });
        return reveal;
      });
      const reveal = () => view.result.current;
      const runFrames = () => {
        while (frames.hasPending()) act(() => frames.flush());
      };
      const setProps = (next: Partial<typeof props>) => {
        props = { ...props, ...next };
        view.rerender();
      };
      const readBack = () => {
        runFrames();
        for (let request = 0; request < 10 && reveal().fromIndex > LONG / 2; request += 1) {
          act(() => reveal().revealMore());
          runFrames();
        }
        expect(reveal().toIndex).toBeLessThan(LONG);
      };
      return { frames, reveal, renders, runFrames, setProps, readBack, props: () => props };
    }

    test("without maxMountedRows the slice always ends at the tail, as before", () => {
      const { reveal, renders, runFrames, setProps } = renderSlice();
      for (let request = 0; request < LONG / TRANSCRIPT_REVEAL_AUTO_MAX_ROWS; request += 1) {
        act(() => reveal().revealMore());
        runFrames();
      }
      act(() => reveal().revealNewer());
      expect(reveal().fromIndex).toBe(0);
      expect(renders.every((render) => render.to === LONG)).toBe(true);
      // Enabling a cap restarts tail-first instead of keeping the oldest rows.
      setProps({ maxMountedRows: MAX });
      expect(reveal()).toMatchObject(LATEST);
    });

    test("older rows mount first, and the newest rows unmount in that same render", () => {
      const { reveal, renders, readBack } = renderSlice(MAX);
      readBack();
      expect(reveal().fromIndex).toBeLessThan(LONG - MAX);
      for (const render of renders) {
        expect(render.to - render.from).toBeLessThanOrEqual(MAX);
        expect(render.to === LONG || bundled(render.to)).toBe(true);
      }
    });

    test("a detached slice keeps its rows across pages and appends; a deleted end row falls back", () => {
      const { reveal, readBack, setProps, props } = renderSlice(MAX);
      readBack();
      const { fromIndex, toIndex } = reveal();
      const ids = (from: number, to: number) => [from, to - 1].map((i) => props().messages[i].id);
      const before = ids(fromIndex, toIndex);
      setProps({ messages: [...rows(30, "old"), ...props().messages, ...rows(3, "new")] });
      expect(ids(reveal().fromIndex, reveal().toIndex)).toEqual(before);
      expect(reveal().toIndex).toBe(toIndex + 30);

      // An edit deletes a run ending at the end row: the slice ends by the kept row above the run.
      const run = (i: number) => i >= toIndex + 5 && i < toIndex + 30;
      setProps({ messages: props().messages.filter((_, i) => !run(i)) });
      // Survivors up to toIndex + 4 stay mounted (cap rule): the end row, now inside their
      // index-based bundle, moves the end forward to that bundle's edge, never back over them.
      expect(reveal().toIndex).toBe(toIndex + 10);
      setProps({ messages: props().messages.filter((_, i) => i !== toIndex + 10) }); // end row
      expect(reveal().toIndex).toBe(toIndex + 10);
    });

    test("revealNewer walks back to the tail; resetToLatest and a dropped cap reattach", () => {
      const { frames, reveal, readBack, setProps } = renderSlice(MAX);
      readBack();
      for (let request = 0; request < 20 && reveal().toIndex < LONG; request += 1) {
        const previousTo = reveal().toIndex;
        act(() => reveal().revealNewer());
        const advanced = reveal().toIndex - previousTo;
        expect(advanced > 0 && advanced <= TRANSCRIPT_REVEAL_AUTO_MAX_ROWS).toBe(true);
        expect(reveal().toIndex - reveal().fromIndex).toBeLessThanOrEqual(MAX);
        // The start moved up; the automatic reveal must not walk it back down.
        expect(frames.hasPending()).toBe(false);
      }
      expect(reveal().toIndex).toBe(LONG);

      readBack();
      act(() => reveal().resetToLatest());
      expect(reveal()).toMatchObject(LATEST);
      readBack();
      setProps({ maxMountedRows: undefined });
      expect(reveal()).toMatchObject(LATEST);
    });

    test("revealThrough a row beyond the cap centers the slice on it, without stepping", () => {
      const { frames, reveal, runFrames, readBack } = renderSlice(MAX);
      runFrames();
      for (const target of [MAX + 300, LONG - MAX / 4]) {
        if (target > LONG / 2) readBack();
        act(() => reveal().revealThrough(target));
        expect(reveal().toIndex).toBeGreaterThan(target);
        expect(Math.abs(target - reveal().fromIndex - MAX / 2)).toBeLessThanOrEqual(10);
        expect(frames.hasPending()).toBe(false);
      }
      act(() => reveal().revealThrough(LONG)); // A stale index past the end is a no-op.
    });

    test("bundles larger than the cap mount whole; centering and revealNewer still reach rows", () => {
      const { reveal, runFrames } = renderSlice(MAX, (index) => index % 1500 === 0);
      // The automatic reveal stops at the cap (cap rule): mounting the 1,500-row bundle alone
      // would unmount the tail under a reader at the bottom. A request mounts it whole, alone.
      runFrames();
      expect(reveal()).toMatchObject({ fromIndex: 4500, toIndex: 4800, isRevealPaused: true });
      act(() => reveal().revealMore()); // #6742 review: Load older shows, and a press mounts it.
      runFrames();
      expect(reveal()).toMatchObject({ fromIndex: 3000, toIndex: 4500 });
      act(() => reveal().revealThrough(2000));
      expect(reveal()).toMatchObject({ fromIndex: 1500, toIndex: 3000 });
      act(() => reveal().revealNewer());
      expect(reveal()).toMatchObject({ fromIndex: 3000, toIndex: 4500 });
    });

    test("a cap smaller than one budget plus a chunk, or fractional, is refused", () => {
      for (const cap of [TRANSCRIPT_REVEAL_AUTO_MAX_ROWS, MAX + 0.5])
        expect(() => renderSlice(cap)).toThrow();
    });

    // One reconciliation each (#6667 review deferral, F20 PR3a-1).
    test("deleting the end rows on both sides of the edge falls back to the newest kept row", () => {
      const { reveal, readBack, setProps, props } = renderSlice(MAX);
      readBack();
      const { toIndex } = reveal();
      const keptId = props().messages[toIndex - 51].id;
      setProps({
        messages: props().messages.filter((_, i) => i < toIndex - 50 || i > toIndex),
      });
      expect(reveal().toIndex).toBe(toIndex - 50);
      expect(props().messages[reveal().toIndex - 1].id).toBe(keptId);
    });

    test("visible rows replaced inside the slice stay mounted when the end row goes later", () => {
      const { reveal, readBack, setProps, props } = renderSlice(MAX);
      readBack();
      const { toIndex } = reveal();
      const replaced = props().messages.map((row, i) =>
        i >= toIndex - 20 && i < toIndex ? { id: `${row.id}-v2` } : row
      );
      setProps({ messages: replaced });
      const seen = replaced.slice(toIndex - 20, toIndex).map((row) => row.id);
      const unread = replaced.slice(toIndex + 1).map((row) => row.id);
      const messages = replaced.filter((_, i) => i !== toIndex);
      setProps({ messages, readVisibleMessageIds: () => seen });
      const mounted = messages.slice(reveal().fromIndex, reveal().toIndex).map((row) => row.id);
      expect(seen.filter((id) => !mounted.includes(id))).toEqual([]);
      expect(mounted.filter((id) => unread.includes(id))).toEqual([]);
    });

    test("every Load older press mounts at least one budget, also across the cap", () => {
      const { reveal, runFrames } = renderSlice(MAX);
      runFrames();
      for (let press = 0; press < 4; press += 1) {
        const from = reveal().fromIndex;
        act(() => reveal().revealMore());
        runFrames();
        const mounted = from - reveal().fromIndex;
        expect(mounted).toBeGreaterThanOrEqual(TRANSCRIPT_REVEAL_AUTO_MAX_ROWS);
        expect(mounted).toBeLessThan(
          TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS
        );
      }
      expect(reveal().toIndex).toBeLessThan(LONG);
    });

    // #6680 review: a bulk arrival (over one chunk of rows, or over one step of weight) restarted
    // at the tail before `followsTail` was read, unmounting the row a scrolled-up reader was on.
    test("a scrolled-up capped reader keeps the read row through bulk and heavy appends", () => {
      const arrivals = [
        { count: TRANSCRIPT_REVEAL_CHUNK_ROWS + 1, weight: 1 },
        { count: 3, weight: TRANSCRIPT_REVEAL_STEP_CHARS },
        { count: MAX, weight: 1 }, // Past the cap: the newest rows unmount (detached).
      ];
      const readers = [
        { followsTail: false, cap: MAX },
        { followsTail: undefined, cap: MAX },
        { followsTail: false, cap: undefined }, // Uncapped, a bulk arrival must not mount at once.
      ];
      for (const [arrival, { count, weight }] of arrivals.entries()) {
        for (const { followsTail, cap } of readers) {
          let messages = rows(LONG);
          const frames = manualFrames();
          const useReader = () =>
            useBoundedTranscriptReveal({
              workspaceId: "ws",
              messages,
              isSafeCut: bundled,
              maxMountedRows: cap,
              followsTail,
              rowWeight: (index: number) => (index >= LONG ? weight : 1),
            });
          const view = renderHook(useReader);
          while (frames.hasPending()) act(() => frames.flush());
          const before = view.result.current;
          const added = rows(count, `bulk-${arrival}`);
          messages = [...messages, ...added];
          view.rerender();
          const after = view.result.current;
          if (followsTail === false && cap !== undefined) {
            expect(after.fromIndex).toBe(before.fromIndex); // The read row stays mounted.
            expect(after.toIndex).toBeLessThanOrEqual(after.fromIndex + MAX);
            expect(after.isDetached).toBe(messages.length - before.fromIndex > MAX);
            continue;
          }
          // Otherwise the bulk arrival restarts at the tail as on main: like a fresh mount.
          const fresh = renderHook(useReader).result.current;
          expect(after).toMatchObject({ fromIndex: fresh.fromIndex, toIndex: fresh.toIndex });
          expect(after.fromIndex).toBeGreaterThan(before.fromIndex);
        }
      }
    });

    test.each([true, false])(
      "appends into a tail bundle larger than the cap scan only new rows (followsTail %p)",
      (followsTail) => {
        // Rows up to 1,000 are safe cuts; later rows are one bundle until a "cut" row arrives.
        let props = { messages: rows(LONG) };
        let calls = 0;
        const isSafeCut = (i: number) => {
          calls += 1;
          return i <= 1000 || props.messages[i]?.id.startsWith("cut") === true;
        };
        const frames = manualFrames();
        const view = renderHook(() =>
          useBoundedTranscriptReveal({
            workspaceId: "ws",
            isSafeCut,
            maxMountedRows: MAX,
            followsTail,
            ...props,
          })
        );
        while (frames.hasPending()) act(() => frames.flush());
        expect(view.result.current).toMatchObject({ fromIndex: 1000, toIndex: LONG });
        const cutIndex = LONG + 2;
        const afterCut = ["new-2", "new-3", "new-4", "new-5", "new-6", "new-7"];
        for (const id of ["new-0", "new-1", "cut-0", ...afterCut]) {
          props = { messages: [...props.messages, { id }] };
          calls = 0;
          view.rerender();
          // Following, the "cut-0" row heads the new tail. Scrolled up (#6680 round 2), the
          // slice detaches at it and keeps the bundle.
          const detachedAtCut = !followsTail && props.messages.length > cutIndex;
          expect(view.result.current).toMatchObject({
            fromIndex: followsTail && props.messages.length > cutIndex ? cutIndex : 1000,
            toIndex: detachedAtCut ? cutIndex : props.messages.length,
          });
          // Measured: an append into the bundle (LONG - 1,000 rows) checks only the new rows (it
          // took 10,005 checks before); the safe cut that moves the start costs one cap.
          expect(calls).toBeLessThan(followsTail && id === "cut-0" ? MAX + 10 : 10);
        }
      }
    );

    // F20 PR3a-3b part 2a, the cap rule: a held slice (scrolled up, a walk, or detached) loses a
    // mounted row only by a reader request, a deletion or a replaced tail. Rows whose id is in
    // `joined` continue the bundle before them; the test owns this grouping.
    describe("cap rule", () => {
      const CAP = TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS;

      function grouped(count = 2000) {
        let messages = rows(count, "r");
        let followsTail = true;
        // The rows the reader sees (refitDetached reads them on an edge loss).
        let visible: readonly string[] = [];
        const stats = { calls: 0 };
        const joined = new Set<string>();
        const isSafeCut = (i: number) => {
          stats.calls += 1;
          return i <= 0 || i >= messages.length || !joined.has(messages[i].id);
        };
        const frames = manualFrames();
        const view = renderHook(() =>
          useBoundedTranscriptReveal({
            workspaceId: "ws",
            messages,
            isSafeCut,
            maxMountedRows: CAP,
            followsTail,
            readVisibleMessageIds: () => visible,
          })
        );
        const reveal = () => view.result.current;
        const runFrames = () => {
          while (frames.hasPending()) act(() => frames.flush());
        };
        const mounted = () => messages.slice(reveal().fromIndex, reveal().toIndex).map((r) => r.id);
        const set = (
          next: { messages?: Row[]; followsTail?: boolean; visible?: readonly string[] },
          frames = true
        ) => {
          messages = next.messages ?? messages;
          followsTail = next.followsTail ?? followsTail;
          visible = next.visible ?? visible;
          view.rerender();
          if (frames) runFrames();
        };
        let fresh = 0;
        const append = (count: number, join: (i: number) => boolean) => {
          const added = rows(count, `a${(fresh += 1)}`);
          added.forEach((row, i) => join(i) && joined.add(row.id));
          set({ messages: [...messages, ...added] });
        };
        // Following, at the cap, with a 30-row bundle at the end.
        const atCap = () => {
          runFrames();
          for (let i = 0; i < 4; i += 1) append(TRANSCRIPT_REVEAL_CHUNK_ROWS, () => false);
          append(30, (i) => i > 0);
          expect(reveal()).toMatchObject({ toIndex: messages.length, isDetached: false });
          expect(reveal().toIndex - reveal().fromIndex).toBe(CAP);
        };
        const pending = () => frames.hasPending();
        const harness = { reveal, mounted, set, append, atCap, stats, joined, pending };
        return { ...harness, messages: () => messages, followsTail: () => followsTail };
      }

      const subset = (before: readonly string[], after: readonly string[]) =>
        expect(before.filter((id) => !after.includes(id))).toEqual([]);

      test("held, an append that grows the end bundle past the cap keeps it mounted", () => {
        const slice = grouped();
        slice.atCap();
        slice.set({ followsTail: false });
        const before = slice.mounted();
        slice.append(5, () => true); // Thread PRRT_kwDOPxxmWM6sqwIK: the end bundle grows.
        subset(before, slice.mounted());
        expect(slice.reveal().toIndex).toBe(slice.messages().length);
        // Back at the bottom, the slice fits the cap again without an append.
        slice.set({ followsTail: true });
        expect(slice.reveal().toIndex - slice.reveal().fromIndex).toBeLessThanOrEqual(CAP);
        expect(slice.reveal().toIndex).toBe(slice.messages().length);
      });

      test("perf: held appends into an end bundle past the cap check only the new rows", () => {
        const slice = grouped();
        slice.atCap();
        slice.set({ followsTail: false });
        for (let i = 0; i < 6; i += 1) {
          slice.stats.calls = 0;
          slice.append(1, () => true);
          expect(slice.stats.calls).toBeLessThan(10);
        }
      });

      test("held, a regroup that moves the start back unmounts no row", () => {
        const slice = grouped();
        slice.atCap();
        slice.set({ followsTail: false });
        const before = slice.mounted();
        slice.joined.add(before[0]); // The start row now continues the bundle before it.
        slice.set({});
        subset(before, slice.mounted());
        const oldStart = slice.messages().findIndex((row) => row.id === before[0]);
        expect(slice.reveal().fromIndex).toBeLessThan(oldStart);
      });

      // #6742 review (Codex's case); the random op 8 in the invariant test generalizes it.
      test("held, one update that deletes the start row and regroups the end keeps the survivors", () => {
        const slice = grouped();
        slice.atCap();
        slice.set({ followsTail: false });
        slice.append(15, () => false); // Past the cap: the slice detaches at the first new row.
        const before = slice.mounted();
        const { toIndex } = slice.reveal();
        expect(slice.reveal().isDetached).toBe(true);
        // The end row and the 9 rows after it join the bundle before them, and the start row goes:
        // the rows the reader sees stay (refitDetached).
        const seen = before.slice(-20);
        for (const row of slice.messages().slice(toIndex, toIndex + 10)) slice.joined.add(row.id);
        slice.set({
          messages: slice.messages().filter((row) => row.id !== before[0]),
          visible: seen,
        });
        subset(seen, slice.mounted());
      });

      test("a capped transcript that starts fully revealed keeps its rows when a page is prepended", () => {
        const slice = grouped(TRANSCRIPT_REVEAL_TAIL_ROWS); // #6742 review: no anchor at start.
        const before = slice.mounted();
        slice.set({ messages: [...rows(CAP + 100, "page"), ...slice.messages()] }, false);
        expect(slice.mounted()).toEqual(before); // The page stays unmounted ...
        slice.set({}); // ... and the automatic reveal mounts older rows within the cap only.
        subset(before, slice.mounted());
        expect(slice.mounted().length).toBeLessThanOrEqual(CAP);
      });

      // #6757 review: a detached slice; one update replaces a mounted row, a later one deletes
      // the start row. The replacement stays mounted. And with every mounted row gone, the slice
      // does not jump forward to rows that were never mounted.
      function detachedPastCap() {
        const slice = grouped();
        slice.atCap();
        slice.set({ followsTail: false });
        slice.append(15, () => false); // Past the cap: the slice detaches at the first new row.
        expect(slice.reveal().isDetached).toBe(true);
        return slice;
      }

      test("a replaced mounted row stays mounted when the start row goes later", () => {
        const slice = detachedPastCap();
        const before = slice.mounted();
        const swapped = slice
          .messages()
          .map((row) => (row.id === before[1] ? { id: "swap" } : row));
        slice.set({ messages: swapped }); // The row right after the start row is replaced, ...
        slice.set({ messages: slice.messages().filter((row) => row.id !== before[0]) });
        expect(slice.mounted()).toContain("swap"); // ... then the start row goes.
        subset(before.slice(2), slice.mounted());
      });

      test("deleting every mounted row does not mount rows that were never mounted", () => {
        const slice = detachedPastCap();
        // Rows inside the slice go first: it gets shorter than the cap with the same start.
        const inner = slice.mounted().slice(10, 110);
        slice.set({ messages: slice.messages().filter((row) => !inner.includes(row.id)) });
        const before = slice.mounted();
        const unread = slice
          .messages()
          .slice(slice.reveal().toIndex)
          .map((row) => row.id);
        slice.set({ messages: slice.messages().filter((row) => !before.includes(row.id)) });
        expect(slice.mounted().filter((row) => unread.includes(row))).toEqual([]);
      });

      // #6757 round 3: the same update also deletes the old end row, while older rows and later
      // unread rows survive. The slice must not restart at those unread rows.
      test("deleting every mounted row and the end row does not mount unread rows", () => {
        const slice = detachedPastCap();
        const { fromIndex: from, toIndex: to } = slice.reveal();
        const gone = slice
          .messages()
          .slice(from, to + 1)
          .map((row) => row.id);
        const unread = slice
          .messages()
          .slice(to + 1)
          .map((row) => row.id);
        expect(unread.length).toBeGreaterThan(0);
        slice.set({ messages: slice.messages().filter((row) => !gone.includes(row.id)) });
        expect(slice.mounted().filter((row) => unread.includes(row))).toEqual([]);
      });

      // #6871 round 1: one mounted row survives, and the first surviving unmounted row joins its
      // bundle in the same update. The end snaps back to that bundle's head; the row stays.
      // #6884 review: one update truncates through the slice (the end row and every newer row go)
      // and new rows arrive: a replaced tail, which restarts, unless the refit keeps the reader.
      test("a truncate through a detached slice plus new rows keeps the visible rows", () => {
        const slice = detachedPastCap();
        const { fromIndex: from, toIndex: to } = slice.reveal();
        const seen = slice.mounted().slice(5, 15);
        const kept = slice.messages().slice(0, to - 1);
        slice.set({ messages: [...kept, ...rows(3, "after-truncate")], visible: seen }, false);
        expect(slice.reveal().fromIndex).toBeLessThanOrEqual(from + 5);
        subset(seen, slice.mounted());
      });

      test("the last surviving mounted row stays when the end regroups into its bundle", () => {
        const slice = detachedPastCap();
        const { fromIndex: from, toIndex: to } = slice.reveal();
        const all = slice.messages();
        const kept = all[to - 1].id;
        slice.joined.add(all[to + 1].id);
        const messages = all.filter((_, i) => i < from || i === to - 1 || i > to);
        slice.set({ messages, visible: [kept] });
        expect(slice.mounted()).toContain(kept);
      });

      // #6871 round 1: with no mounted row left, an older bundle across the one-cap point must
      // not add its older part on top of the cap.
      test("with no mounted row left, an older bundle across the cap point does not pass the cap", () => {
        const slice = detachedPastCap();
        const { fromIndex: from, toIndex: to } = slice.reveal();
        const all = slice.messages();
        const point = from - CAP;
        all.slice(point - 19, point + 20).forEach((row) => slice.joined.add(row.id));
        slice.set({ messages: all.filter((_, i) => i < from || i > to) });
        expect(slice.mounted().length).toBeGreaterThan(0);
        expect(slice.mounted().length).toBeLessThanOrEqual(CAP);
      });

      test("held, deleting only the newest rows keeps the start; new rows replacing them restart", () => {
        const slice = grouped();
        slice.atCap();
        slice.set({ followsTail: false });
        const before = slice.mounted();
        slice.set({ messages: slice.messages().slice(0, -2) }); // A retry removed two rows.
        expect(slice.mounted()).toEqual(before.slice(0, -2));
        slice.set({ messages: [...slice.messages().slice(0, -3), { id: "edited" }] }, false);
        expect(slice.mounted().at(-1)).toBe("edited");
        expect(slice.mounted().length).toBeLessThanOrEqual(TRANSCRIPT_REVEAL_TAIL_ROWS);
      });

      test("a bulk arrival during a Load older walk keeps the walk", () => {
        const slice = grouped();
        slice.set({});
        act(() => slice.reveal().revealMore()); // Crosses the cap: a walk to a target row.
        const { fromIndex } = slice.reveal();
        slice.set({
          messages: [...slice.messages(), ...rows(TRANSCRIPT_REVEAL_CHUNK_ROWS + 1, "bulk")],
        });
        // Thread PRRT_kwDOPxxmWM6sqwIO: no restart at the tail; the walk ran to its row.
        expect(slice.reveal().fromIndex).toBeLessThan(fromIndex);
        expect(slice.reveal().isDetached).toBe(true);
      });

      // Seeded random operations; after each one that is not a reader request, a checker that
      // reads only the hook's output asserts the cap rule.
      // Seeds 28 and 29 reach check (d) with a held overshoot (they fail without keptPastCap).
      // Seeds 9, 11 and 17 reach edge losses that refitDetached handles (#6871 known limit).
      test.each([1, 2, 3, 4, 9, 11, 17, 28, 29])("invariant: seed %p", (seed) => {
        const slice = grouped();
        slice.set({});
        let state = seed;
        const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
        const pick = (n: number) => Math.floor(random() * n);
        const isHead = (ids: readonly string[], i: number) =>
          i === 0 || i === ids.length || !slice.joined.has(ids[i]);
        let id = 0;
        for (let op = 0; op < 300; op += 1) {
          const before = slice.mounted();
          const held = slice.reveal().isDetached || !slice.followsTail();
          // The reader sees up to 20 mounted rows; derived from op, so the random sequence holds.
          const seen = before.slice((op * 7) % Math.max(1, before.length)).slice(0, 1 + (op % 20));
          slice.set({ visible: seen }, false);
          const kind = pick(10);
          const all = slice.messages();
          const { toIndex: oldTo, isDetached: wasDetached } = slice.reveal();
          const oldEnd = wasDetached ? all[oldTo].id : null;
          if (kind === 0) slice.append(1 + pick(3), () => random() < 0.5);
          if (kind === 1) slice.append(TRANSCRIPT_REVEAL_CHUNK_ROWS + 5, () => random() < 0.5);
          if (kind === 2) {
            const gone = new Set(
              Array.from({ length: 1 + pick(3) }, () => all[pick(all.length)].id)
            );
            slice.set({ messages: all.filter((row) => !gone.has(row.id)) });
          }
          if (kind === 3) slice.set({ messages: [...rows(20, `p${(id += 1)}`), ...all] });
          if (kind === 4) slice.set({ followsTail: !slice.followsTail() });
          if (kind === 5) act(() => slice.reveal().revealMore());
          if (kind === 6) act(() => slice.reveal().revealNewer());
          if (kind === 7 && all.length > 1) {
            const row = all[1 + pick(all.length - 1)].id;
            if (slice.joined.has(row)) slice.joined.delete(row);
            else slice.joined.add(row);
          }
          if (kind === 8) {
            // One update: the start row goes, and the end row plus 9 after it join the bundle
            // before them (#6742 review; the vanished-start fallback uses startRows).
            const { fromIndex: start, toIndex: end } = slice.reveal();
            for (const row of all.slice(end, end + 10)) slice.joined.add(row.id);
            slice.set({ messages: all.filter((_, i) => i !== start) });
          }
          if (kind === 9 && slice.reveal().isDetached) {
            // One update: every mounted row and the end row go; with an older row left, unread
            // rows after them stay unmounted (#6757 round 3: compare with the resolved end).
            const { fromIndex: start, toIndex: end } = slice.reveal();
            const unread = all.slice(end + 1).map((row) => row.id);
            slice.set({ messages: all.filter((_, i) => i < start || i > end) });
            if (start > 0)
              expect(slice.mounted().filter((row) => unread.includes(row))).toEqual([]);
          }
          slice.set({});
          // Liveness (#6742 review): after the frames, fully revealed or paused, never stuck.
          const { fromIndex: start, isRevealPaused: paused } = slice.reveal();
          expect(slice.pending() || (start === 0 ? !paused : paused)).toBe(true);
          // (d) Back at the bottom (following, attached, frames flushed), the slice fits the cap
          // again, except one bundle larger than the cap that mounts alone (keptPastCap refit).
          const { fromIndex: head, toIndex: tail, isDetached } = slice.reveal();
          if (slice.followsTail() && !isDetached && tail - head > CAP) {
            const now = slice.messages().map((row) => row.id);
            const bundleHeads = now.slice(head + 1, tail).filter((row) => !slice.joined.has(row));
            expect(bundleHeads).toEqual([]);
          }
          if (kind === 5 || kind === 6) continue;
          const ids = slice.messages().map((row) => row.id);
          const { fromIndex: from, toIndex: to } = slice.reveal();
          const after = slice.mounted();
          // An edge loss: the update deleted a detached slice's start or end row (refitDetached).
          const lost = oldEnd !== null && (!ids.includes(oldEnd) || !ids.includes(before[0]));
          // Held on both sides of the step: turning followsTail on makes rule 3 apply.
          if (held && (slice.reveal().isDetached || !slice.followsTail())) {
            // (e) The rows the reader saw stay mounted; on other steps every mounted row does.
            subset(
              (lost ? seen : before).filter((row) => ids.includes(row)),
              after
            );
          }
          expect(isHead(ids, from) && isHead(ids, to)).toBe(true);
          // (f) An edge loss refits to at most one cap, or to one bundle larger than it.
          if (lost) {
            const inner = ids.slice(from + 1, to).filter((row) => !slice.joined.has(row));
            expect(to - from <= CAP || inner.length === 0).toBe(true);
          }
          if (to - from > CAP) {
            // Past the cap, rows that mounted in this step lie only in the first or the last
            // mounted bundle, and only one that was partly mounted before (it grew or regrouped
            // at an edge). A held slice already past the cap stays there but mounts nothing else.
            const heads = [...after.keys()].filter((i) => isHead(ids, from + i));
            const wasMounted = (bundle: string[]) => bundle.some((row) => before.includes(row));
            const edges = [after.slice(0, heads[1] ?? 0), after.slice(heads.at(-1))]
              .filter(wasMounted)
              .flat();
            const added = after.filter((row) => !before.includes(row));
            expect(added.filter((row) => !edges.includes(row))).toEqual([]);
          }
        }
      });
    });

    // F20 PR3a-2: each edit is ONE update through the real aggregator's delete, reconcile or
    // page path. Row i has historySequence SEQ + i (one displayed row per user message). Every
    // cut is safe: the index-based `bundled` would move bundle edges when rows above them go.
    describe("detached budget on real aggregator updates", () => {
      const SEQ = 1000;
      function renderOnAggregator(maxMountedRows: number | undefined) {
        const aggregator = new StreamingMessageAggregator(new Date().toISOString(), "ws");
        const message = (id: string, sequence: number) =>
          createMuxMessage(id, "user", id, { historySequence: sequence, timestamp: sequence });
        const history = (from: number, to: number, prefix = "m") =>
          Array.from({ length: to - from }, (_, i) =>
            message(`${prefix}-${from + i}`, SEQ + from + i)
          );
        aggregator.loadHistoricalMessages(history(0, LONG));
        const slice = renderSlice(maxMountedRows, alwaysSafe, aggregator.getDisplayedMessages());
        const update = (edit: () => void) => {
          edit();
          slice.setProps({ messages: aggregator.getDisplayedMessages() });
        };
        const deleteRows = (keep: (i: number) => boolean) =>
          update(() =>
            aggregator.handleDeleteMessage({
              type: "delete",
              historySequences: Array.from({ length: LONG }, (_, i) => i)
                .filter((i) => !keep(i))
                .map((i) => SEQ + i),
            })
          );
        const mountedIds = () =>
          slice
            .props()
            .messages.slice(slice.reveal().fromIndex, slice.reveal().toIndex)
            .map((r) => r.id);
        return { ...slice, aggregator, message, history, update, deleteRows, mountedIds };
      }

      test("a delete, reconcile or page in the unmounted newer rows keeps the slice paused", () => {
        const edits: Array<(s: ReturnType<typeof renderOnAggregator>, to: number) => void> = [
          (s, to) => s.deleteRows((i) => i < to + 5 || i >= to + 105),
          (s, to) =>
            s.update(() =>
              s.aggregator.reconcileSinceReplay({
                requestedAnchorSequence: SEQ + to + 5,
                messages: s.history(to + 105, LONG),
                hasActiveStream: false,
              })
            ),
          (s) =>
            s.update(() =>
              s.aggregator.loadHistoricalMessages(
                Array.from({ length: 200 }, (_, i) => s.message(`old-${i}`, i)),
                false,
                { mode: "append" }
              )
            ),
        ];
        // Read back by presses, or centered by a navigation (its budget is the whole suffix).
        const setups = [
          (s: ReturnType<typeof renderOnAggregator>) => s.readBack(),
          (s: ReturnType<typeof renderOnAggregator>) =>
            act(() => s.reveal().revealThrough(LONG / 2)),
        ];
        for (const [edit, setup] of edits.flatMap((e) => setups.map((u) => [e, u] as const))) {
          const slice = renderOnAggregator(MAX);
          setup(slice);
          const before = slice.mountedIds();
          expect(slice.reveal().isRevealPaused).toBe(true);
          edit(slice, slice.reveal().toIndex);
          expect(slice.frames.hasPending()).toBe(false);
          expect(slice.reveal().isRevealPaused).toBe(true);
          expect(slice.mountedIds()).toEqual(before);
          cleanup();
        }
      });

      // #6669 round 7: the old anchor index ends up at or past the new length.
      test("deleting the start anchor and every older row keeps the survivors mounted", () => {
        const slice = renderOnAggregator(MAX);
        slice.readBack();
        const { fromIndex, toIndex } = slice.reveal();
        const survivors = slice.mountedIds().slice(1);
        // Also drop unmounted newer rows (the newest 3 survive) so the old start is past the end.
        const newer = Math.max(0, LONG - 2 * fromIndex);
        slice.deleteRows((i) => i > fromIndex && !(i >= toIndex + 10 && i < toIndex + 10 + newer));
        expect(fromIndex).toBeGreaterThanOrEqual(slice.props().messages.length);
        expect(slice.mountedIds().slice(-survivors.length)).toEqual(survivors);
        expect(slice.reveal().toIndex - slice.reveal().fromIndex).toBeLessThanOrEqual(MAX);
        expect(slice.frames.hasPending()).toBe(false);
      });

      test("attached, the same update behaves as on main", () => {
        const slice = renderOnAggregator(MAX);
        slice.runFrames();
        const { fromIndex } = slice.reveal();
        expect(slice.reveal()).toMatchObject({ isRevealPaused: true, toIndex: LONG });
        slice.renders.length = 0;
        slice.deleteRows((i) => i > fromIndex);
        slice.runFrames();
        // Captured on main 34c70e3de7: the old start is past the end, so no row shows, then the
        // automatic reveal mounts the survivors chunk by chunk without a press.
        const main = [519, 459, 399, 339, 279, 219, 159, 99, 39, 0];
        expect(slice.renders).toEqual(main.map((from) => ({ from, to: 519 })));
      });

      /** One reply streams: two chunks of text deltas and tool calls, one update each. */
      function streamReply(slice: ReturnType<typeof renderOnAggregator>, afterEach: () => void) {
        const event = { workspaceId: "ws", messageId: "reply" };
        slice.update(() =>
          slice.aggregator.handleStreamStart({
            ...event,
            type: "stream-start",
            historySequence: SEQ + LONG,
            model: "anthropic:claude-test",
            startTime: 1,
          })
        );
        for (let call = 0; call < 2 * TRANSCRIPT_REVEAL_CHUNK_ROWS; call += 1) {
          slice.update(() => {
            slice.aggregator.handleStreamDelta({
              ...event,
              type: "stream-delta",
              delta: `step ${call} `,
              tokens: 1,
              timestamp: call,
            });
            slice.aggregator.handleToolCallStart({
              ...event,
              type: "tool-call-start",
              toolCallId: `call-${call}`,
              toolName: "bash",
              args: { script: `echo ${call}` },
              tokens: 1,
              timestamp: call,
            });
          });
          afterEach();
        }
      }

      // F20 PR3a-3: a reply streaming into an attached slice at the cap must stay mounted.
      test("streamed rows past the cap unmount the oldest rows, never the newest", () => {
        // The smallest cap: the reveal pauses about one chunk under it, attached. The aggregator
        // shows a few dozen rows of one reply, enough to cross it.
        const cap = TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS;
        const slice = renderOnAggregator(cap);
        slice.runFrames();
        expect(slice.reveal().toIndex).toBe(LONG);
        streamReply(slice, () => {
          const { fromIndex, toIndex } = slice.reveal();
          expect(toIndex).toBe(slice.props().messages.length);
          expect(toIndex - fromIndex).toBeLessThanOrEqual(cap);
        });
        expect(slice.reveal().toIndex - slice.reveal().fromIndex).toBe(cap);
        expect(slice.frames.hasPending()).toBe(false);
      });

      // F20 PR3a-3b: a reader scrolled up mid-stream keeps the rows they read.
      test("with followsTail off, streamed rows past the cap detach the slice instead", () => {
        const cap = TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS;
        const slice = renderOnAggregator(cap);
        slice.runFrames();
        const { fromIndex } = slice.reveal();
        const readRow = slice.props().messages[fromIndex].id;
        slice.setProps({ followsTail: false });
        streamReply(slice, () => {
          expect(slice.reveal().fromIndex).toBe(fromIndex);
          expect(slice.mountedIds()).toContain(readRow);
        });
        expect(slice.reveal().isDetached).toBe(true);
        // Jump to bottom: the newest streamed row mounts again.
        act(() => slice.reveal().resetToLatest());
        expect(slice.mountedIds().at(-1)).toBe(slice.props().messages.at(-1)!.id);
      });

      // Walk-append decision: a Load-older walk does not follow the tail (the reader asked for
      // older rows), so it ends detached; Show newer still reaches every streamed row.
      test("rows streamed during a Load-older walk stay reachable after it ends", () => {
        const slice = renderOnAggregator(MAX);
        slice.runFrames();
        act(() => slice.reveal().revealMore());
        slice.runFrames();
        act(() => slice.reveal().revealMore()); // Crosses the cap: a walk to a target row.
        act(() => slice.frames.flush());
        streamReply(slice, () => undefined);
        slice.runFrames();
        expect(slice.reveal()).toMatchObject({ isDetached: true, isRevealPaused: true });
        for (let press = 0; press < 20 && slice.reveal().isDetached; press += 1) {
          act(() => slice.reveal().revealNewer());
        }
        expect(slice.mountedIds().at(-1)).toBe(slice.props().messages.at(-1)!.id);
      });

      // #6680 round 3 check: an edit truncates the tail and appends the edited row in one update.
      // The previous newest row is gone, so the reveal restarts at the new tail even while a
      // scrolled-up reader holds the slice: it never stays on rows unrelated to the new tail.
      test("a replaced tail restarts at the new tail even while the reader is scrolled up", () => {
        const slice = renderOnAggregator(MAX);
        slice.readBack();
        slice.setProps({ followsTail: false });
        const editFrom = LONG - TRANSCRIPT_REVEAL_CHUNK_ROWS;
        slice.update(() => {
          slice.aggregator.handleDeleteMessage({
            type: "delete",
            historySequences: Array.from({ length: LONG - editFrom }, (_, i) => SEQ + editFrom + i),
          });
          slice.aggregator.addMessage(slice.message("edited", SEQ + editFrom));
        });
        const fresh = renderSlice(MAX, alwaysSafe, slice.props().messages).reveal();
        expect(slice.reveal()).toMatchObject({
          fromIndex: fresh.fromIndex,
          toIndex: fresh.toIndex,
        });
        expect(slice.mountedIds().at(-1)).toBe("edited");
      });

      test("without a cap, the same stream renders as on main", () => {
        const slice = renderOnAggregator(undefined);
        slice.runFrames();
        slice.renders.length = 0;
        streamReply(slice, () => undefined);
        // Captured on main 7ea2aa5220: the start never moves; the end follows the tail (two
        // renders per update) until the aggregator stops adding rows for this reply.
        const tail = Array.from({ length: 32 }, (_, i) => [4802 + 2 * i, 4802 + 2 * i]).flat();
        const main = [4800, ...tail, ...Array<number>(176).fill(4865)];
        expect(slice.renders).toEqual(main.map((to) => ({ from: 4280, to })));
      });

      test("a vanished navigation target pauses, and the start still re-anchors that render", () => {
        const slice = renderOnAggregator(MAX);
        slice.readBack();
        act(() => slice.reveal().revealMore());
        act(() => slice.frames.flush()); // One chunk of the walk to the target.
        expect(slice.reveal().isRevealPaused).toBe(false);
        const { fromIndex, toIndex } = slice.reveal();
        const survivors = slice.mountedIds().slice(1);
        // One update deletes the target row (one budget older) and the current start row.
        const target = fromIndex - TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS;
        slice.deleteRows((i) => i !== fromIndex && !(i >= target - 10 && i <= target));
        expect(slice.reveal().isRevealPaused).toBe(true);
        expect(slice.frames.hasPending()).toBe(false);
        expect(slice.mountedIds().slice(-survivors.length)).toEqual(survivors);
        expect(slice.reveal().toIndex).toBe(toIndex - 12);
      });
    });
  });
});
