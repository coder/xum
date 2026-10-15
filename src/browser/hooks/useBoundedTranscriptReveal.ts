import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  TRANSCRIPT_REVEAL_AUTO_MAX_ROWS,
  TRANSCRIPT_REVEAL_CHUNK_ROWS,
  TRANSCRIPT_REVEAL_STEP_CHARS,
  TRANSCRIPT_REVEAL_TAIL_ROWS,
} from "@/common/constants/ui";
import assert from "@/common/utils/assert";

interface RevealRow {
  id: string;
}

export interface BoundedTranscriptRevealArgs<Row extends RevealRow> {
  workspaceId: string;
  messages: readonly Row[];
  /**
   * Whether the reveal may start at `index`: true when the row is not inside a bundle or
   * group (a bundle/group head counts as safe). Derived by the caller from the index-based
   * projections it already computes over the full array.
   */
  isSafeCut: (index: number) => boolean;
  /**
   * Relative render cost of the row at `index` (text characters); a step stops once its summed
   * weight would exceed `TRANSCRIPT_REVEAL_STEP_CHARS`, after at least one row. Defaults to 1 per
   * row, which makes the row ceilings the only limit.
   */
  rowWeight?: (index: number) => number;
  /** Opt-in cap on mounted rows (#4961 F20), at least one automatic budget plus a chunk. */
  maxMountedRows?: number;
}

export interface BoundedTranscriptReveal {
  /** Rows at indices >= fromIndex are eligible to mount this render. */
  fromIndex: number;
  isFullyRevealed: boolean;
  /**
   * The automatic reveal reached its rows budget and stopped scheduling frames; older rows
   * mount only through `revealMore` or `revealThrough`.
   */
  isRevealPaused: boolean;
  /** Resumes the automatic reveal for another `TRANSCRIPT_REVEAL_AUTO_MAX_ROWS` rows. */
  revealMore: () => void;
  /**
   * Keeps revealing (past the budget) until the row at `index` is mounted. A no-op when that
   * row is already inside the mounted range.
   */
  revealThrough: (index: number) => void;
  /** Rows below toIndex may mount; below the length when detached (newest rows unmounted). */
  toIndex: number;
  /** `toIndex` is below the length of the rows this hook was given. */
  isDetached: boolean;
  /** Mounts up to one budget of newer rows; resetToLatest restarts tail-first, like a switch. */
  revealNewer: () => void;
  resetToLatest: () => void;
}

interface RevealState {
  workspaceId: string;
  maxMountedRows: number | undefined;
  /**
   * Bumped on every reset (new workspace, bulk arrival, replaced tail). A step scheduled by an
   * older generation is discarded even when the reset happens to pick the same anchor row,
   * so a stale frame can never mount a chunk before the reset tail has painted.
   */
  generation: number;
  /**
   * null ⇒ fully revealed. Anchored by id so appends/deletes above cannot shift the cut.
   * Always a safe cut under the grouping it was last rendered with: a boundary the grouping
   * pulled back (a bundle came to span it) is persisted here, so the mounted range can only
   * grow — never advance again when the grouping changes back.
   */
  anchorMessageId: string | null;
  /**
   * Index the anchor had when last located; the fast path for finding it, and the fallback bound
   * if the id disappears.
   */
  anchorIndexHint: number;
  /**
   * Newest row id at the last render. Rows after it on the next render are the appended
   * suffix; a suffix heavier than one step is a bulk arrival. Prepends (older pages) and
   * in-place changes leave it in place and never restart the reveal.
   */
  newestMessageId: string | null;
  /** Automatic steps stop once this many rows are mounted (reset on every restart). */
  autoRowLimit: number;
  /**
   * Row a navigation waits for (see revealThrough): steps continue past the budget until it is
   * mounted, then it clears. Cleared as well when the row disappears or the reveal restarts.
   */
  targetMessageId: string | null;
  /** First unmounted newer row while detached, anchored by id like the start; null ⇒ the tail. */
  endMessageId: string | null;
  endIndexHint: number;
  /**
   * Ids of the next unmounted rows after the end row, for the fallback when it is gone; [] at the
   * tail. Ids only, so a detached slice never keeps an obsolete transcript reachable (#6669), and
   * at most `maxMountedRows` of them, so a step costs O(cap), not O(transcript) (#6676 review).
   */
  endRows: readonly string[];
}

/**
 * Staged double requestAnimationFrame: the first callback runs before this frame's paint, the
 * second after the committed tail had a rendering opportunity. Returns a cancel function.
 */
function scheduleStagedFrame(callback: () => void): () => void {
  let second: number | undefined;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(callback);
  });
  return () => {
    cancelAnimationFrame(first);
    if (second !== undefined) cancelAnimationFrame(second);
  };
}

/**
 * Frame scheduler for reveal steps, swappable by tests that need to hold the reveal between
 * chunks without stubbing the global requestAnimationFrame (which streaming text also uses):
 * the hook's unit tests and full-app tests. Production never reassigns it.
 */
export const transcriptRevealFrameScheduler: {
  schedule: (callback: () => void) => () => void;
} = { schedule: scheduleStagedFrame };

type IsSafeCut = (index: number) => boolean;

/** Smallest safe cut at or after `index`, clamped to [0, length]; length is always safe. */
function nearestSafeCutAtOrAfter(index: number, length: number, isSafeCut: IsSafeCut): number {
  let cut = Math.min(Math.max(index, 0), length);
  while (cut < length && !isSafeCut(cut)) cut += 1;
  return cut;
}

/** A detached slice's stored end: its first unmounted row survives deleted mounted rows. */
function storedSliceEnd(state: RevealState, rows: readonly RevealRow[], isSafeCut: IsSafeCut) {
  const { endMessageId: id, endIndexHint: hint, endRows } = state;
  if (id === null) return rows.length;
  const found = rows[hint]?.id === id ? hint : rows.findIndex((row) => row.id === id);
  if (found !== -1) return nearestSafeCutAtOrBefore(found, rows.length, isSafeCut);
  return endAtNearestUnmountedRow(rows, endRows, isSafeCut);
}

/**
 * Where the end goes once its row is gone, even when one reconciliation also deleted mounted rows
 * before it (#6667 review): the nearest still-present row that was unmounted (`endRows`), so
 * mounted rows replaced since stay mounted. If none survives, the slice ends at the tail, which the
 * cap then clamps: unmounting what follows could hide read rows. `endRows` holds one cap of rows.
 * With all of them gone too, the clamp can mount a few more unread rows than the nearest survivor
 * would (as many as the update deleted inside the slice); it never hides one.
 */
function endAtNearestUnmountedRow(
  rows: readonly RevealRow[],
  endRows: readonly string[],
  isSafeCut: IsSafeCut
): number {
  const indexById = new Map(rows.map((row, index) => [row.id, index]));
  for (const id of endRows) {
    const index = indexById.get(id);
    if (index !== undefined) return nearestSafeCutAtOrBefore(index, rows.length, isSafeCut);
  }
  return rows.length;
}

/**
 * Where a slice from `fromIndex` ends (#4961 F20): the start is settled first, then a slice over
 * the cap gives up its newest rows in the same render; a first bundle over the cap mounts alone.
 */
function resolveSliceEnd(
  state: RevealState,
  messages: readonly RevealRow[],
  fromIndex: number,
  max: number | undefined,
  isSafeCut: IsSafeCut
): number {
  const length = messages.length;
  if (max === undefined) return length;
  assert(
    Number.isInteger(max) && max >= TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS,
    "maxMountedRows must be an integer holding an automatic reveal budget plus a chunk"
  );
  let to = storedSliceEnd(state, messages, isSafeCut);
  const fitted = nearestSafeCutAtOrBefore(fromIndex + max, length, isSafeCut);
  if (to - fromIndex > max) to = fitted;
  return to > fromIndex ? to : nearestSafeCutAtOrAfter(fromIndex + 1, length, isSafeCut);
}

/** `state` with its end fields set for a slice ending at `to` (null at the tail). */
function withSliceEnd(state: RevealState, messages: readonly RevealRow[], to: number): RevealState {
  const endMessageId = to < messages.length ? messages[to].id : null;
  const endIndexHint = endMessageId === null ? 0 : to;
  if (state.endMessageId === endMessageId && state.endIndexHint === endIndexHint) return state;
  return { ...state, endMessageId, endIndexHint, endRows: sliceEndIds(state, messages, to) };
}

/** Ids of up to one cap of rows after the end row; none at the tail (see `endRows`). */
const sliceEndIds = (state: RevealState, messages: readonly RevealRow[], to: number) =>
  messages.slice(to + 1, to + 1 + (state.maxMountedRows ?? 0)).map((row) => row.id);

interface RevealSnapshot {
  messages: readonly RevealRow[];
  fromIndex: number;
  toIndex: number;
  generation: number;
}

/**
 * The slice moved to start at or before `desired`, end at most `max` rows later and keep row
 * `include`; the budget becomes what is mounted, so the automatic reveal never walks it back.
 */
function sliceStateAt(
  previous: RevealState,
  snapshot: RevealSnapshot,
  desired: number,
  include: number,
  max: number,
  isSafeCut: IsSafeCut
): RevealState {
  const { messages } = snapshot;
  if (previous.generation !== snapshot.generation) return previous;
  const length = messages.length;
  const endFrom = (start: number) => {
    const fitted = nearestSafeCutAtOrBefore(start + max, length, isSafeCut);
    return fitted > start ? fitted : nearestSafeCutAtOrAfter(start + 1, length, isSafeCut);
  };
  let start = nearestSafeCutAtOrBefore(desired, length, isSafeCut);
  if (endFrom(start) <= include) start = nearestSafeCutAtOrBefore(include, length, isSafeCut);
  const moved: RevealState = {
    ...previous,
    anchorMessageId: start === 0 ? null : messages[start].id,
    anchorIndexHint: start,
    autoRowLimit: length - start,
    targetMessageId: null,
  };
  return withSliceEnd(moved, messages, endFrom(start));
}

function revealNewerState(
  previous: RevealState,
  snapshot: RevealSnapshot,
  max: number | undefined,
  isSafeCut: IsSafeCut
): RevealState {
  const { fromIndex, toIndex } = snapshot;
  const length = snapshot.messages.length;
  if (max === undefined || toIndex >= length) return previous;
  const to = Math.min(toIndex + TRANSCRIPT_REVEAL_AUTO_MAX_ROWS, length);
  return sliceStateAt(previous, snapshot, Math.max(fromIndex, to - max), toIndex, max, isSafeCut);
}

/** revealThrough: center the slice on a target out of reach; else step down to an older one. */
function revealThroughState(
  previous: RevealState,
  snapshot: RevealSnapshot,
  index: number,
  max: number | undefined,
  isSafeCut: IsSafeCut
): RevealState {
  if (index >= snapshot.messages.length) return previous; // A stale index, as when uncapped.
  if (max !== undefined && (index >= snapshot.toIndex || snapshot.toIndex - index > max)) {
    return sliceStateAt(previous, snapshot, index - Math.floor(max / 2), index, max, isSafeCut);
  }
  if (index >= snapshot.fromIndex || previous.generation !== snapshot.generation) return previous;
  const targetMessageId = snapshot.messages[index].id;
  return previous.targetMessageId === targetMessageId ? previous : { ...previous, targetMessageId };
}

/**
 * Whether the automatic reveal must stop counting: always while detached (`toIndex < length`), so
 * deletions in the unmounted newer rows cannot resume it; attached, main's mounted-rows budget.
 */
function isBudgetSpent(
  state: RevealState,
  slice: Pick<RevealSnapshot, "messages" | "fromIndex" | "toIndex">
): boolean {
  const length = slice.messages.length;
  return slice.toIndex < length || length - slice.fromIndex >= state.autoRowLimit;
}

/**
 * Load older: attached, main's rule (one more budget of mounted rows). Detached, or about to be,
 * the walk ends at the row one budget older (revealThrough's target rule) instead of a count, so
 * no deletion elsewhere can lengthen it (F20 PR3a-2); a vanished target ends it early.
 */
function revealMoreState(
  previous: RevealState,
  snapshot: RevealSnapshot,
  max: number | undefined,
  isSafeCut: IsSafeCut
): RevealState {
  if (previous.generation !== snapshot.generation) return previous;
  const length = snapshot.messages.length;
  const limit = length - snapshot.fromIndex + TRANSCRIPT_REVEAL_AUTO_MAX_ROWS;
  if (max === undefined || (snapshot.toIndex === length && limit <= max)) {
    return previous.autoRowLimit >= limit ? previous : { ...previous, autoRowLimit: limit };
  }
  if (snapshot.fromIndex === 0) return previous;
  const cut = nearestSafeCutAtOrBefore(
    snapshot.fromIndex - TRANSCRIPT_REVEAL_AUTO_MAX_ROWS,
    length,
    isSafeCut
  );
  return { ...previous, targetMessageId: snapshot.messages[cut].id };
}

/**
 * Where the slice starts once its start row is gone. Attached: main's rule, the old index. Detached
 * (#6669 round 7): as many rows before the end as were mounted, so every surviving mounted row
 * stays mounted even when the deleted run put the old start index past the new length. Rows
 * deleted below it mount instead, never more.
 */
function vanishedStartFallback(
  state: RevealState,
  messages: readonly RevealRow[],
  isSafeCut: IsSafeCut
): number {
  if (state.endMessageId === null) return state.anchorIndexHint;
  const mountedBefore = state.endIndexHint - state.anchorIndexHint;
  return storedSliceEnd(state, messages, isSafeCut) - mountedBefore;
}

/**
 * Where an attached slice starts after an append (F20 PR3a-3): appends that push it over the cap
 * unmount its OLDEST rows, so a streaming reply stays mounted. Walks (a target is set) and
 * detached slices keep their start: there the cap trims the newest rows instead. A tail bundle
 * larger than the cap mounts alone.
 */
function tailFollowingStart(
  state: RevealState,
  messages: readonly RevealRow[],
  from: number,
  max: number | undefined,
  isSafeCut: IsSafeCut
): number {
  const length = messages.length;
  const attached = state.endMessageId === null && state.targetMessageId === null;
  if (max === undefined || !attached || length - from <= max) return from;
  const cut = nearestSafeCutAtOrAfter(length - max, length, isSafeCut);
  return cut < length ? cut : nearestSafeCutAtOrBefore(length - 1, length, isSafeCut);
}

/** `state` with the start persisted at `from` (null at 0), so it cannot move forward again. */
function withStartAt(
  state: RevealState,
  messages: readonly RevealRow[],
  from: number
): RevealState {
  if (from === 0) {
    return state.anchorMessageId === null
      ? state
      : { ...state, anchorMessageId: null, anchorIndexHint: 0 };
  }
  if (from >= messages.length || messages[from].id === state.anchorMessageId) return state;
  return { ...state, anchorMessageId: messages[from].id, anchorIndexHint: from };
}

/** Largest safe cut at or before `index`, clamped to [0, length]; 0 is always safe. */
function nearestSafeCutAtOrBefore(
  index: number,
  length: number,
  isSafeCut: (index: number) => boolean
): number {
  let cut = Math.min(Math.max(index, 0), length);
  while (cut > 0 && !isSafeCut(cut)) cut -= 1;
  return cut;
}

interface StepInputs {
  maxMountedRows?: number;
  isSafeCut: (index: number) => boolean;
  rowWeight: (index: number) => number;
}

/**
 * Where the next step's mounted range starts: walk back from `end` (exclusive) taking rows
 * until either ceiling is reached — `maxRows` rows or `TRANSCRIPT_REVEAL_STEP_CHARS` summed
 * weight — always taking at least one row, then move to the nearest safe cut at or before that
 * index (a bundle mounts whole, so a step containing one can exceed both ceilings).
 */
function nextStepCut(end: number, maxRows: number, inputs: StepInputs): number {
  assert(end >= 0 && maxRows >= 1, "nextStepCut requires end >= 0 and maxRows >= 1");
  let cut = end;
  let weight = 0;
  while (cut > 0 && end - cut < maxRows) {
    const rowWeight = inputs.rowWeight(cut - 1);
    assert(
      Number.isFinite(rowWeight) && rowWeight >= 0,
      "rowWeight must be a finite non-negative number"
    );
    if (cut < end && weight + rowWeight > TRANSCRIPT_REVEAL_STEP_CHARS) break;
    weight += rowWeight;
    cut -= 1;
  }
  return nearestSafeCutAtOrBefore(cut, end, inputs.isSafeCut);
}

/**
 * Whether the rows at [start, end) are more than one step's worth — more rows than a chunk or
 * more summed weight than a step allows. A since-replay publishes its rows together, so a
 * handful of heavy rows must count as a bulk arrival too, not only a long run of rows.
 */
function exceedsOneStep(start: number, end: number, inputs: StepInputs): boolean {
  assert(start >= 0 && start <= end, "exceedsOneStep requires 0 <= start <= end");
  if (end - start > TRANSCRIPT_REVEAL_CHUNK_ROWS) return true;
  let weight = 0;
  for (let index = start; index < end; index += 1) {
    weight += inputs.rowWeight(index);
    if (weight > TRANSCRIPT_REVEAL_STEP_CHARS) return true;
  }
  return false;
}

function startState<Row extends RevealRow>(
  workspaceId: string,
  messages: readonly Row[],
  inputs: StepInputs,
  generation: number
): RevealState {
  assert(Number.isInteger(generation) && generation >= 0, "generation must be a counter");
  const length = messages.length;
  const base: Omit<RevealState, "anchorMessageId" | "anchorIndexHint"> = {
    workspaceId,
    maxMountedRows: inputs.maxMountedRows,
    generation,
    newestMessageId: length > 0 ? messages[length - 1].id : null,
    autoRowLimit: TRANSCRIPT_REVEAL_AUTO_MAX_ROWS,
    targetMessageId: null,
    endMessageId: null,
    endIndexHint: 0,
    endRows: [],
  };
  const cut = nextStepCut(length, TRANSCRIPT_REVEAL_TAIL_ROWS, inputs);
  if (cut === 0) return { ...base, anchorMessageId: null, anchorIndexHint: 0 };
  return { ...base, anchorMessageId: messages[cut].id, anchorIndexHint: cut };
}

const unitRowWeight = (): number => 1;

/** What identifies one reveal: a new workspace or a changed cap restarts it. */
const transcriptKey = (reveal: { workspaceId: string; maxMountedRows?: number }) =>
  `${reveal.workspaceId}\u0000${String(reveal.maxMountedRows)}`;

/**
 * Bundle-granular tail-first reveal for the transcript (progressive RENDERING only; the data
 * path is unchanged). On a workspace switch or a bulk arrival (an appended suffix heavier than
 * one step, or a replaced tail) the newest rows mount first (up to
 * `TRANSCRIPT_REVEAL_TAIL_ROWS` rows or `TRANSCRIPT_REVEAL_STEP_CHARS` of row weight, whichever
 * comes first); the remainder mounts in chunks bounded the same way by
 * `TRANSCRIPT_REVEAL_CHUNK_ROWS`, each scheduled after the committed tail had a rendering
 * opportunity, never cutting inside a bundle or group. Prepends (older history pages) and
 * changes that leave the newest row in place — including aggregator epoch bumps for rows
 * outside the loaded window — never restart the reveal. Row projections are still computed
 * over the full array by the caller; only the mounted range shrinks.
 *
 * The automatic reveal pauses once `TRANSCRIPT_REVEAL_AUTO_MAX_ROWS` rows are mounted (#4869:
 * each step costs O(mounted rows), so revealing every row of a huge chat kept the renderer busy
 * for minutes). `revealMore` resumes it for another budget; `revealThrough` reveals down to a
 * navigation target regardless of the budget.
 *
 * Invariant (tested, not asserted per render): within one workspace and outside the
 * bulk-arrival reset, the set of row ids at indices >= fromIndex only grows.
 */
export function useBoundedTranscriptReveal<Row extends RevealRow>(
  args: BoundedTranscriptRevealArgs<Row>
): BoundedTranscriptReveal {
  assert(args.workspaceId.length > 0, "useBoundedTranscriptReveal requires a workspaceId");
  const stepInputs: StepInputs = {
    maxMountedRows: args.maxMountedRows,
    isSafeCut: args.isSafeCut,
    rowWeight: args.rowWeight ?? unitRowWeight,
  };
  const [state, setState] = useState<RevealState>(() =>
    startState(args.workspaceId, args.messages, stepInputs, 0)
  );

  // State adjustments during render (React's derived-state idiom): a new transcript or a bulk
  // arrival restarts the reveal; a small append only moves the newest-row marker.
  let current = state;
  const length = args.messages.length;
  const newestMessageId = length > 0 ? args.messages[length - 1].id : null;
  let restart = transcriptKey(current) !== transcriptKey(args);
  if (!restart && newestMessageId !== current.newestMessageId) {
    // The tail moved. Rows after the previous newest row are the appended suffix; a previous
    // newest row that is gone means the tail was replaced. An empty transcript that filled
    // (the hydration skeleton hands this hook no rows until it clears) is a fresh transcript,
    // judged by the initial-tail limits in startState rather than the chunk ceiling.
    const previousNewestIndex =
      current.newestMessageId === null
        ? -1
        : args.messages.findIndex((row) => row.id === current.newestMessageId);
    restart =
      previousNewestIndex === -1
        ? true
        : exceedsOneStep(previousNewestIndex + 1, length, stepInputs);
  }
  let appended = false;
  if (restart) {
    current = startState(args.workspaceId, args.messages, stepInputs, current.generation + 1);
    setState(current);
  } else if (current.newestMessageId !== newestMessageId) {
    appended = true;
    current = { ...current, newestMessageId };
    setState(current);
  }

  // fromIndex is derived every render from the anchor id, re-validated against the CURRENT
  // grouping (a bundle can come to span the anchor when density changes): a found anchor is
  // moved to the nearest safe cut at or before it, and a vanished anchor falls back to a safe
  // cut at or before its last known index, never to an unbounded jump. A boundary that moved
  // is persisted as the new anchor so it cannot move forward again (see RevealState).
  let fromIndex = 0;
  if (current.anchorMessageId !== null) {
    // Try the index hint before scanning (#4869: the scan ran over ~620k rows on every reveal
    // step render at 1.24M rows). Appends after the anchor never shift it; a prepend or deletion
    // above it misses the hint and falls back to the scan.
    const anchorId = current.anchorMessageId;
    const anchorIndex =
      args.messages[current.anchorIndexHint]?.id === anchorId
        ? current.anchorIndexHint
        : args.messages.findIndex((row) => row.id === anchorId);
    if (anchorIndex !== -1 && anchorIndex !== current.anchorIndexHint) {
      // Found by the scan at a shifted index: remember it so the next render hits the hint.
      current = { ...current, anchorIndexHint: anchorIndex };
      setState(current);
    }
    fromIndex = nearestSafeCutAtOrBefore(
      anchorIndex !== -1
        ? anchorIndex
        : vanishedStartFallback(current, args.messages, args.isSafeCut),
      length,
      args.isSafeCut
    );
  }
  const max = args.maxMountedRows;
  if (appended)
    fromIndex = tailFollowingStart(current, args.messages, fromIndex, max, args.isSafeCut);
  const started = withStartAt(current, args.messages, fromIndex);
  if (started !== current) {
    current = started;
    setState(current);
  }
  assert(fromIndex >= 0 && fromIndex <= length, "reveal boundary must stay within the transcript");
  const toIndex = resolveSliceEnd(current, args.messages, fromIndex, max, args.isSafeCut);
  const sliced = withSliceEnd(current, args.messages, toIndex);
  if (sliced !== current) {
    current = sliced;
    setState(current);
  }

  // A navigation target is done once its row is mounted, and moot once it is gone.
  if (current.targetMessageId !== null) {
    const targetId = current.targetMessageId;
    const targetIndex = args.messages.findIndex((row) => row.id === targetId);
    if (targetIndex === -1 || targetIndex >= fromIndex) {
      current = { ...current, targetMessageId: null };
      setState(current);
    }
  }
  const isRevealPaused =
    current.anchorMessageId !== null &&
    current.targetMessageId === null &&
    isBudgetSpent(current, { messages: args.messages, fromIndex, toIndex });

  // The scheduled step reads the latest COMMITTED inputs when it runs, not what it captured
  // when scheduled: grouping can change while a frame is pending. Published from a layout
  // effect, not during render, so a concurrent render that is abandoned (the caller feeds
  // deferred values) can never hand a pending frame an uncommitted snapshot.
  const latest = useRef({
    messages: args.messages,
    stepInputs,
    fromIndex,
    toIndex,
    generation: current.generation,
  });
  useLayoutEffect(() => {
    latest.current = {
      messages: args.messages,
      stepInputs,
      fromIndex,
      toIndex,
      generation: current.generation,
    };
  });
  const scheduleFrame = transcriptRevealFrameScheduler.schedule;

  const anchorMessageId = current.anchorMessageId;
  const generation = current.generation;
  const workspaceId = args.workspaceId;
  useEffect(() => {
    if (anchorMessageId === null || isRevealPaused) return;
    const cancel = scheduleFrame(() => {
      const snapshot = latest.current;
      setState((previous) => {
        // A reset since scheduling (new workspace / bulk arrival — a new generation, even if it
        // re-chose this anchor) or a persisted boundary move supersedes this step.
        if (
          previous.generation !== generation ||
          previous.anchorMessageId !== anchorMessageId ||
          previous.workspaceId !== workspaceId
        ) {
          return previous;
        }
        // A frame that slipped past cancellation must not step a reveal that paused meanwhile.
        if (previous.targetMessageId === null && isBudgetSpent(previous, snapshot)) {
          return previous;
        }
        const cut = nextStepCut(
          Math.min(snapshot.fromIndex, snapshot.messages.length),
          TRANSCRIPT_REVEAL_CHUNK_ROWS,
          snapshot.stepInputs
        );
        if (cut === 0) return { ...previous, anchorMessageId: null, anchorIndexHint: 0 };
        return { ...previous, anchorMessageId: snapshot.messages[cut].id, anchorIndexHint: cut };
      });
    });
    return cancel;
  }, [anchorMessageId, generation, workspaceId, scheduleFrame, isRevealPaused]);

  // Both read the latest COMMITTED snapshot (like the scheduled step), so a caller's effect sees
  // the rows and boundary it just rendered.
  const revealMore = () => {
    const snapshot = latest.current;
    setState((previous) => revealMoreState(previous, snapshot, max, args.isSafeCut));
  };
  const revealNewer = () => {
    setState((previous) => revealNewerState(previous, latest.current, max, args.isSafeCut));
  };
  const resetToLatest = () => {
    const snapshot = latest.current;
    setState((previous) =>
      startState(workspaceId, snapshot.messages, snapshot.stepInputs, previous.generation + 1)
    );
  };
  const revealThrough = (index: number) => {
    assert(Number.isInteger(index) && index >= 0, "revealThrough requires a row index");
    setState((previous) =>
      revealThroughState(previous, latest.current, index, max, args.isSafeCut)
    );
  };

  return {
    fromIndex,
    isFullyRevealed: current.anchorMessageId === null,
    isRevealPaused,
    revealMore,
    revealThrough,
    toIndex,
    isDetached: toIndex < length,
    revealNewer,
    resetToLatest,
  };
}
