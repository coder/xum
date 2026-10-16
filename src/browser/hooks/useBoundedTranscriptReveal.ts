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
  /**
   * Whether appends past the cap move the start up (default true). False while the reader has
   * scrolled away from the bottom: the slice detaches instead, so the row being read stays.
   */
  followsTail?: boolean;
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
  /**
   * Detached, with a cap: ids of the unmounted rows just before the start, nearest first (at most
   * one cap), taken when the row before the start changes. Once the start row is gone, the slice
   * starts right after the nearest of them still present: every row after it stays mounted,
   * replacements included, and no older row mounts (F20 PR3a-3b part 2b-1, #6757 review).
   */
  startRows: readonly string[];
  /**
   * The start row while it heads a bundle larger than the cap, scanned up to the slice end (the
   * newest row, or a detached end) (#6678 review): the next render scans only the rows appended
   * after it, not the whole bundle. A change that makes a cut inside it safe is missed, so the
   * bundle stays mounted (more rows, never hidden ones) until a row after it is a safe cut.
   */
  tailBundleHeadId: string | null;
  /**
   * Ids of the newest rows (one chunk), for telling a deletion of only the newest rows (the new
   * newest row is one of them) from a replaced tail (it is new): see `appendRestarts`.
   */
  tailIds: readonly string[];
  /** A held reader left this attached slice past the cap (see `resolveSliceEnd`). */
  keptPastCap: boolean;
  /**
   * The automatic step stopped at the cap before a bundle too large for the room left: the reveal
   * is paused, and the next Load older press walks to a target, which may pass the cap.
   */
  capBlocked: boolean;
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
function storedSliceEnd(
  state: RevealState,
  rows: readonly RevealRow[],
  isSafeCut: IsSafeCut,
  /** Where the end goes from its row's index; the vanished-start fallback keeps the index. */
  nearest: (index: number, length: number, isSafeCut: IsSafeCut) => number = nearestSafeCutAtOrAfter
) {
  const { endMessageId: id, endIndexHint: hint, endRows } = state;
  if (id === null) return rows.length;
  const found = rows[hint]?.id === id ? hint : rows.findIndex((row) => row.id === id);
  if (found === -1) return endAtNearestUnmountedRow(rows, endRows, isSafeCut);
  // A regroup that puts the end row inside a bundle moves the end forward: no mounted row
  // unmounts (cap rule); the bundle mounts whole.
  return nearest(found, rows.length, isSafeCut);
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
  const index = firstPresentIndex(rows, endRows);
  return index === -1 ? rows.length : nearestSafeCutAtOrBefore(index, rows.length, isSafeCut);
}

/**
 * Index of the first of `ids` (in their order) still in `rows`, or -1. One scan; memory O(ids),
 * not O(rows), for million-row transcripts (#6757 review).
 */
function firstPresentIndex(rows: readonly RevealRow[], ids: readonly string[]): number {
  const rank = new Map(ids.map((id, order) => [id, order]));
  let best = -1;
  let bestRank = ids.length;
  rows.forEach((row, index) => {
    const order = rank.get(row.id);
    if (order !== undefined && order < bestRank) [best, bestRank] = [index, order];
  });
  return best;
}

/**
 * `state` with `startRows` taken before `from` when a detached slice's preceding row changed, and
 * cleared once attached: only the detached fallback reads it, so the attached path renders as on
 * main (no extra render per step).
 */
function withStartRows(
  state: RevealState,
  slice: Pick<RevealSnapshot, "messages" | "fromIndex" | "toIndex">
): RevealState {
  const { messages, fromIndex: from } = slice;
  const max = state.maxMountedRows;
  if (max === undefined) return state;
  if (slice.toIndex === messages.length) {
    return state.startRows.length === 0 ? state : { ...state, startRows: [] };
  }
  if (messages[from - 1]?.id === state.startRows[0]) return state;
  const before = messages.slice(Math.max(0, from - max), from).map((row) => row.id);
  return { ...state, startRows: before.reverse() };
}

interface SliceEndInputs {
  fromIndex: number;
  max: number | undefined;
  isSafeCut: IsSafeCut;
  /** No safe cut lies in (fromIndex, bundleScanFrom): see `tailBundleHeadId`. */
  bundleScanFrom: number;
  /** Held, no walk (cap rule, #6680 round 3): the end never moves back over mounted rows. */
  keepsEnd: boolean;
  appendedFrom: number;
}

/**
 * Where a slice from `fromIndex` ends (#4961 F20): the start is settled first, then a slice over
 * the cap gives up its newest rows in the same render; a first bundle over the cap mounts alone.
 */
function resolveSliceEnd(
  state: RevealState,
  messages: readonly RevealRow[],
  inputs: SliceEndInputs
): number {
  const { fromIndex, max, isSafeCut } = inputs;
  const length = messages.length;
  if (max === undefined) return length;
  assert(
    Number.isInteger(max) && max >= TRANSCRIPT_REVEAL_AUTO_MAX_ROWS + TRANSCRIPT_REVEAL_CHUNK_ROWS,
    "maxMountedRows must be an integer holding an automatic reveal budget plus a chunk"
  );
  const to = endWithinCap(state, messages, storedSliceEnd(state, messages, isSafeCut), {
    ...inputs,
    max,
  });
  return to > fromIndex ? to : nearestSafeCutAtOrAfter(fromIndex + 1, length, isSafeCut);
}

/** The stored end `to`, or for a slice over the cap, where the cap rule lets it end. */
function endWithinCap(
  state: RevealState,
  messages: readonly RevealRow[],
  to: number,
  inputs: SliceEndInputs & { max: number }
): number {
  const { fromIndex, max, isSafeCut } = inputs;
  const length = messages.length;
  if (to - fromIndex <= max) return to;
  if (inputs.keepsEnd) {
    // Detached: the stored end stays. Attached: the rows mounted before this render (up to the
    // previous length) stay, with the rest of a bundle they began; only newer rows past the cap
    // stay unmounted. O(appended rows).
    if (state.endMessageId !== null) return to;
    const kept = nearestSafeCutAtOrAfter(inputs.appendedFrom, length, isSafeCut);
    if (kept - fromIndex > max) return kept;
  }
  return cappedEnd(fromIndex, to, max, length, isSafeCut, inputs.bundleScanFrom);
}

/** The end of a slice over the cap; a known bundle (`tailBundleHeadId`) skips its scanned rows. */
function cappedEnd(
  fromIndex: number,
  to: number,
  max: number,
  length: number,
  isSafeCut: IsSafeCut,
  bundleScanFrom: number
): number {
  // `to` is a safe cut, so a detached end at or before the scanned rows ends the scan at once.
  if (bundleScanFrom > fromIndex + 1) {
    return nearestSafeCutAtOrAfter(Math.min(bundleScanFrom, to), length, isSafeCut);
  }
  return nearestSafeCutAtOrBefore(fromIndex + max, length, isSafeCut);
}

/** The slice end, and `state` with it and with the head of an oversized tail bundle stored. */
function endedState(
  state: RevealState,
  messages: readonly RevealRow[],
  fromIndex: number,
  max: number | undefined,
  isSafeCut: IsSafeCut,
  appendedFrom: number,
  holds: boolean
): { toIndex: number; state: RevealState } {
  const length = messages.length;
  const headId = fromIndex < length ? messages[fromIndex].id : null;
  const knownBundle = headId !== null && headId === state.tailBundleHeadId;
  const keepsEnd = holds && state.targetMessageId === null;
  const bundleScanFrom = knownBundle ? appendedFrom : fromIndex + 1;
  const inputs = { fromIndex, max, isSafeCut, bundleScanFrom, keepsEnd, appendedFrom };
  const toIndex = resolveSliceEnd(state, messages, inputs);
  const sliced = withSliceEnd(state, messages, toIndex);
  const pastCap = {
    headId,
    mounted: toIndex - fromIndex,
    max,
    keepsEnd,
    atTail: toIndex === length,
  };
  return { toIndex, state: withBundleFlags(sliced, pastCap) };
}

/**
 * `state` with `tailBundleHeadId` and `keptPastCap`. Past the cap without a kept end means no safe
 * cut between the start and the end: one bundle, scanned to the end. A kept end can span several
 * bundles, so it is never cached.
 */
function withBundleFlags(
  state: RevealState,
  slice: {
    headId: string | null;
    mounted: number;
    max: number | undefined;
    keepsEnd: boolean;
    atTail: boolean;
  }
): RevealState {
  const pastCap = slice.max !== undefined && slice.mounted > slice.max;
  const tailBundleHeadId = pastCap && !slice.keepsEnd ? slice.headId : null;
  const keptPastCap = pastCap && slice.keepsEnd && slice.atTail;
  if (state.tailBundleHeadId === tailBundleHeadId && state.keptPastCap === keptPastCap)
    return state;
  return { ...state, tailBundleHeadId, keptPastCap };
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
 * `state` started at row 0: null (fully revealed) without a cap. With a cap the start stays
 * anchored to its row, so rows prepended above it (older pages) are new rows past the cap and
 * stay unmounted (cap rule, F20 PR3a-3b part 2a-2).
 */
function startAtZero(state: RevealState, messages: readonly RevealRow[]): RevealState {
  const anchorMessageId =
    state.maxMountedRows !== undefined && messages.length > 0 ? messages[0].id : null;
  if (state.anchorMessageId === anchorMessageId) return state;
  return { ...state, anchorMessageId, anchorIndexHint: 0 };
}

/** A capped start at row 0 keeps an anchor (see startAtZero) but has nothing older to step to. */
const isFullyRevealedAt = (anchorMessageId: string | null, max: number | undefined, from: number) =>
  anchorMessageId === null || (max !== undefined && from === 0);

/** One automatic step older: a chunk, kept within the cap unless a walk is active. */
function autoStepState(
  previous: RevealState,
  snapshot: RevealSnapshot & { stepInputs: StepInputs }
): RevealState {
  const cut = cappedStepCut(
    previous,
    snapshot,
    nextStepCut(
      Math.min(snapshot.fromIndex, snapshot.messages.length),
      TRANSCRIPT_REVEAL_CHUNK_ROWS,
      snapshot.stepInputs
    )
  );
  // Blocked by the cap: a zero budget pauses the reveal (see capBlocked).
  if (cut > 0 && cut >= snapshot.fromIndex)
    return { ...previous, capBlocked: true, autoRowLimit: 0 };
  if (cut === 0) return withStartAt(previous, snapshot.messages, 0);
  return { ...previous, anchorMessageId: snapshot.messages[cut].id, anchorIndexHint: cut };
}

/** An automatic step's cut, kept within the cap unless a walk (a reader request) is active. */
function cappedStepCut(
  state: RevealState,
  snapshot: RevealSnapshot & { stepInputs: StepInputs },
  cut: number
): number {
  const max = state.maxMountedRows;
  if (max === undefined || state.targetMessageId !== null || snapshot.toIndex - cut <= max) {
    return cut;
  }
  const { messages, toIndex, stepInputs } = snapshot;
  return nearestSafeCutAtOrAfter(toIndex - max, messages.length, stepInputs.isSafeCut);
}

/**
 * Load older: attached, main's rule (one more budget of mounted rows). Detached, or about to be,
 * the walk ends at the row one budget older (revealThrough's target rule) instead of a count, so
 * no deletion elsewhere can lengthen it (F20 PR3a-2); a vanished target ends it early.
 */
/** A Load older press adds a budget (main's rule): no cap, or attached, within it, not blocked. */
function pressFitsBudget(
  state: RevealState,
  snapshot: RevealSnapshot,
  max: number | undefined,
  limit: number
): boolean {
  if (max === undefined) return true;
  return snapshot.toIndex === snapshot.messages.length && limit <= max && !state.capBlocked;
}

function revealMoreState(
  previous: RevealState,
  snapshot: RevealSnapshot,
  max: number | undefined,
  isSafeCut: IsSafeCut
): RevealState {
  if (previous.generation !== snapshot.generation) return previous;
  const length = snapshot.messages.length;
  const limit = length - snapshot.fromIndex + TRANSCRIPT_REVEAL_AUTO_MAX_ROWS;
  if (pressFitsBudget(previous, snapshot, max, limit)) {
    return previous.autoRowLimit >= limit ? previous : { ...previous, autoRowLimit: limit };
  }
  if (snapshot.fromIndex === 0) return previous;
  const cut = nearestSafeCutAtOrBefore(
    snapshot.fromIndex - TRANSCRIPT_REVEAL_AUTO_MAX_ROWS,
    length,
    isSafeCut
  );
  return { ...previous, targetMessageId: snapshot.messages[cut].id, capBlocked: false };
}

/**
 * Where the slice starts once its start row is gone. Attached: main's rule, the old index.
 * Detached with a cap: the first surviving row of `startRows`. When none survives, detached
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
  return detachedStartFallback(state, messages, isSafeCut);
}

/** vanishedStartFallback for a detached slice. */
function detachedStartFallback(
  state: RevealState,
  messages: readonly RevealRow[],
  isSafeCut: IsSafeCut
): number {
  // The end row's own index: a safe cut before any regroup in this update (#6742 review). When
  // the end row went too, its `endRows` fallback (#6757 round 3).
  const end = storedSliceEnd(state, messages, isSafeCut, (index) => index);
  const mountedBefore = state.endIndexHint - state.anchorIndexHint;
  const after = firstPresentIndex(messages, state.startRows) + 1;
  // No row before the start survives: as many rows before the end as were mounted (#6669 round 7).
  if (after === 0) return end - mountedBefore;
  // Right after the nearest older row still present, while a mounted row (or a replacement)
  // still lies between it and the end.
  if (after < end) return after;
  // No mounted row survives: older rows instead of unread newer ones, at most one cap of them, so
  // a held slice past the cap mounts no more rows it never showed (#6757 round 3).
  return end - Math.min(mountedBefore, state.maxMountedRows ?? mountedBefore);
}

interface TailAppend {
  from: number;
  /** Index of the first row this render appended (the length when nothing was appended). */
  appendedFrom: number;
  max: number | undefined;
  /** Rows were appended, or a held reader left the slice past the cap (`keptPastCap`). */
  moved: boolean;
  /** The caller's `followsTail`: false while the reader is scrolled away from the bottom. */
  follows: boolean;
}

/**
 * Whether the start may move up to fit the cap: attached, no walk, the reader at the bottom, and
 * rows were appended or a held reader left the slice past the cap (`keptPastCap`).
 */
function followsAppend(state: RevealState, tail: TailAppend): boolean {
  return (
    tail.moved && tail.follows && state.endMessageId === null && state.targetMessageId === null
  );
}

/**
 * `from` heads a cached tail bundle larger than the cap (`tailBundleHeadId`), and no appended
 * row starts a new one: the bundle keeps the start. O(appended rows), not a rescan (#6678).
 */
function keepsOversizedTail(
  state: RevealState,
  messages: readonly RevealRow[],
  tail: TailAppend,
  isSafeCut: IsSafeCut
) {
  const length = messages.length;
  return (
    messages[tail.from]?.id === state.tailBundleHeadId &&
    nearestSafeCutAtOrAfter(tail.appendedFrom, length, isSafeCut) === length
  );
}

/**
 * Where an attached slice starts after an append (F20 PR3a-3): appends that push it over the cap
 * unmount its OLDEST rows, so a streaming reply stays mounted. Walks (a target is set) and
 * detached slices keep their start: there the cap trims the newest rows instead. A tail bundle
 * larger than the cap mounts alone. A reader scrolled up (`followsTail` false) keeps the start.
 */
function tailFollowingStart(
  state: RevealState,
  messages: readonly RevealRow[],
  tail: TailAppend,
  isSafeCut: IsSafeCut
): number {
  const { from, max } = tail;
  const length = messages.length;
  if (max === undefined || !followsAppend(state, tail) || length - from <= max) return from;
  if (keepsOversizedTail(state, messages, tail, isSafeCut)) return from;
  const cut = nearestSafeCutAtOrAfter(length - max, length, isSafeCut);
  return cut < length ? cut : nearestSafeCutAtOrBefore(length - 1, length, isSafeCut);
}

/** `state` with the start persisted at `from` (null at 0), so it cannot move forward again. */
function withStartAt(
  state: RevealState,
  messages: readonly RevealRow[],
  from: number
): RevealState {
  if (from === 0) return startAtZero(state, messages);
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

/**
 * Whether a tail change restarts the reveal at the tail. A replaced tail (the previous newest row
 * is gone and the newest row is new: edit, truncate, compaction) always does. With a cap, deleting
 * only newest rows does not (`deletedTail`): a retry that removes an error row keeps a reader's
 * place. A bulk arrival (more than one step) restarts unless the slice is held (`holds`: scrolled
 * up, a walk, or detached; #6680 review): it then keeps its start, and past the cap it detaches.
 */
function appendRestarts(
  previousNewestIndex: number,
  length: number,
  inputs: StepInputs,
  hold: { holds: boolean; deletedTail: boolean }
): boolean {
  if (previousNewestIndex === -1) return !hold.deletedTail;
  return !hold.holds && exceedsOneStep(previousNewestIndex + 1, length, inputs);
}

/** Held (see the cap rule): scrolled up, a walk, or detached; only with a cap. */
function isHeld(state: RevealState, max: number | undefined, followsTail: boolean | undefined) {
  if (max === undefined) return false;
  return followsTail === false || state.targetMessageId !== null || state.endMessageId !== null;
}

/**
 * For a render whose newest row changed: whether the reveal restarts, and where the appended rows
 * begin (the length when rows were only deleted).
 */
function tailChange(
  state: RevealState,
  messages: readonly RevealRow[],
  inputs: StepInputs,
  holds: boolean
): { restart: boolean; appendedFrom: number } {
  const length = messages.length;
  const newestId = messages[length - 1]?.id;
  const previousNewestIndex =
    state.newestMessageId === null
      ? -1
      : messages.findIndex((row) => row.id === state.newestMessageId);
  const capped = inputs.maxMountedRows !== undefined;
  const deletedTail = capped && newestId !== undefined && state.tailIds.includes(newestId);
  const restart = appendRestarts(previousNewestIndex, length, inputs, { holds, deletedTail });
  // Only rows deleted: nothing was appended.
  return { restart, appendedFrom: previousNewestIndex === -1 ? length : previousNewestIndex + 1 };
}

/** Ids of the newest rows, see `tailIds`. */
const newestIds = (messages: readonly RevealRow[]) =>
  messages.slice(-TRANSCRIPT_REVEAL_CHUNK_ROWS).map((row) => row.id);

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
    startRows: [],
    tailBundleHeadId: null,
    tailIds: newestIds(messages),
    keptPastCap: false,
    capBlocked: false,
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
  let appendedFrom = length;
  const max = args.maxMountedRows;
  const holds = isHeld(current, max, args.followsTail);
  if (!restart && newestMessageId !== current.newestMessageId) {
    // The tail moved. Rows after the previous newest row are the appended suffix; a previous
    // newest row that is gone means the tail was replaced. An empty transcript that filled
    // (the hydration skeleton hands this hook no rows until it clears) is a fresh transcript,
    // judged by the initial-tail limits in startState rather than the chunk ceiling.
    ({ restart, appendedFrom } = tailChange(current, args.messages, stepInputs, holds));
  }
  if (restart) {
    current = startState(args.workspaceId, args.messages, stepInputs, current.generation + 1);
    setState(current);
  } else if (current.newestMessageId !== newestMessageId) {
    current = { ...current, newestMessageId, tailIds: newestIds(args.messages) };
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
  const follows = args.followsTail !== false;
  const moved = appendedFrom < length || current.keptPastCap;
  const tail = { from: fromIndex, appendedFrom, max, moved, follows };
  fromIndex = tailFollowingStart(current, args.messages, tail, args.isSafeCut);
  const started = withStartAt(current, args.messages, fromIndex);
  if (started !== current) {
    current = started;
    setState(current);
  }
  assert(fromIndex >= 0 && fromIndex <= length, "reveal boundary must stay within the transcript");
  const ended = endedState(
    current,
    args.messages,
    fromIndex,
    max,
    args.isSafeCut,
    appendedFrom,
    holds
  );
  const toIndex = ended.toIndex;
  const withRows = withStartRows(ended.state, { messages: args.messages, fromIndex, toIndex });
  if (withRows !== current) {
    current = withRows;
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
  // A fully revealed capped start is never paused (#6742 review): Load older must fetch history.
  const isFullyRevealed = isFullyRevealedAt(current.anchorMessageId, max, fromIndex);
  const isRevealPaused =
    !isFullyRevealed &&
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
    if (isFullyRevealed || isRevealPaused) return;
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
        return autoStepState(previous, snapshot);
      });
    });
    return cancel;
  }, [anchorMessageId, isFullyRevealed, generation, workspaceId, scheduleFrame, isRevealPaused]);

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
    isFullyRevealed,
    isRevealPaused,
    revealMore,
    revealThrough,
    toIndex,
    isDetached: toIndex < length,
    revealNewer,
    resetToLatest,
  };
}
