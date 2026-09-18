import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDom } from "../../../tests/ui/dom";

import {
  TRANSCRIPT_REVEAL_CHUNK_ROWS,
  TRANSCRIPT_REVEAL_STEP_CHARS,
  TRANSCRIPT_REVEAL_TAIL_ROWS,
} from "@/common/constants/ui";

import { useBoundedTranscriptReveal } from "./useBoundedTranscriptReveal";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

interface Row {
  id: string;
}

const rows = (count: number, prefix = "m"): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));

/** Manual frame scheduler: `flush()` runs the pending callback, `cancelled` counts cancels. */
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
  return {
    scheduleFrame,
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
    const messages = rows(540);
    const { result } = renderHook(() =>
      useBoundedTranscriptReveal({
        workspaceId: "ws",
        messages,
        isSafeCut: alwaysSafe,
        scheduleFrame: frames.scheduleFrame,
      })
    );
    expect(result.current.isFullyRevealed).toBe(false);
    expect(result.current.fromIndex).toBe(540 - TRANSCRIPT_REVEAL_TAIL_ROWS);
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
      Math.ceil((540 - TRANSCRIPT_REVEAL_TAIL_ROWS) / TRANSCRIPT_REVEAL_CHUNK_ROWS)
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
        scheduleFrame: frames.scheduleFrame,
      })
    );
    expect(result.current).toEqual({ fromIndex: 0, isFullyRevealed: true });
    expect(frames.hasPending()).toBe(false);
  });

  test("(c,d,e) tail replacement and bulk arrivals reset and cancel; small appends and prepends do neither", () => {
    const frames = manualFrames();
    let props = { workspaceId: "ws", messages: rows(300) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
        scheduleFrame: frames.scheduleFrame,
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
        scheduleFrame: frames.scheduleFrame,
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
        scheduleFrame: frames.scheduleFrame,
      })
    );
    expect(result.current.isFullyRevealed).toBe(true);
    props = { ...props, messages: [...rows(200, "old"), ...props.messages] };
    rerender();
    expect(result.current).toEqual({ fromIndex: 0, isFullyRevealed: true });
    expect(frames.hasPending()).toBe(false);
  });

  test("(f) a vanished anchor falls back to a safe cut at or before its index hint, never 0", () => {
    const frames = manualFrames();
    let props = { workspaceId: "ws", messages: rows(300) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
        scheduleFrame: frames.scheduleFrame,
      })
    );
    const anchorIndex = result.current.fromIndex;
    // Remove the anchor row itself (same epoch, e.g. a reconciliation that kept the epoch).
    props = { ...props, messages: props.messages.filter((_, index) => index !== anchorIndex) };
    rerender();
    expect(result.current.isFullyRevealed).toBe(false);
    expect(result.current.fromIndex).toBe(anchorIndex);
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
        scheduleFrame: frames.scheduleFrame,
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

  test("(l) a step whose generation changed before it ran is a no-op", () => {
    const frames = manualFrames();
    let props = { workspaceId: "ws", messages: rows(300) };
    const { result, rerender } = renderHook(() =>
      useBoundedTranscriptReveal({
        ...props,
        isSafeCut: alwaysSafe,
        scheduleFrame: frames.scheduleFrame,
      })
    );
    const stale = frames.flush; // keep a handle to the scheduler; the callback is replaced on reset
    props = { ...props, workspaceId: "other", messages: rows(300, "o") };
    rerender();
    const fresh = result.current.fromIndex;
    act(() => stale());
    // Only the new generation's own step may move the boundary, and it did by one chunk at most.
    expect(fresh - result.current.fromIndex).toBeLessThanOrEqual(TRANSCRIPT_REVEAL_CHUNK_ROWS);
    expect(result.current.fromIndex).toBeGreaterThanOrEqual(0);
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
        scheduleFrame: frames.scheduleFrame,
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
        scheduleFrame: frames.scheduleFrame,
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
        scheduleFrame: frames.scheduleFrame,
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
        scheduleFrame: frames.scheduleFrame,
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
});
