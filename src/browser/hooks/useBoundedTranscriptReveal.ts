import { useEffect, useRef, useState } from "react";

import {
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
  /**
   * Test seam. Defaults to a staged double requestAnimationFrame: the first callback runs
   * before this frame's paint, the second after the committed tail had a rendering
   * opportunity. Returns a cancel function.
   */
  scheduleFrame?: (callback: () => void) => () => void;
}

export interface BoundedTranscriptReveal {
  /** Rows at indices >= fromIndex are eligible to mount this render. */
  fromIndex: number;
  isFullyRevealed: boolean;
}

interface RevealState {
  workspaceId: string;
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
  /** Index the anchor had when chosen; the fallback bound if the id disappears. */
  anchorIndexHint: number;
  /**
   * Newest row id at the last render. Rows after it on the next render are the appended
   * suffix; a suffix heavier than one step is a bulk arrival. Prepends (older pages) and
   * in-place changes leave it in place and never restart the reveal.
   */
  newestMessageId: string | null;
}

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
 * Default frame scheduler, swappable by full-app tests that need to hold the reveal between
 * chunks without stubbing the global requestAnimationFrame (which streaming text also uses).
 * Production never reassigns it.
 */
export const transcriptRevealFrameScheduler: {
  schedule: (callback: () => void) => () => void;
} = { schedule: scheduleStagedFrame };

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
    generation,
    newestMessageId: length > 0 ? messages[length - 1].id : null,
  };
  const cut = nextStepCut(length, TRANSCRIPT_REVEAL_TAIL_ROWS, inputs);
  if (cut === 0) return { ...base, anchorMessageId: null, anchorIndexHint: 0 };
  return { ...base, anchorMessageId: messages[cut].id, anchorIndexHint: cut };
}

const unitRowWeight = (): number => 1;

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
 * Invariant (tested, not asserted per render): within one workspace and outside the
 * bulk-arrival reset, the set of row ids at indices >= fromIndex only grows.
 */
export function useBoundedTranscriptReveal<Row extends RevealRow>(
  args: BoundedTranscriptRevealArgs<Row>
): BoundedTranscriptReveal {
  assert(args.workspaceId.length > 0, "useBoundedTranscriptReveal requires a workspaceId");
  const stepInputs: StepInputs = {
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
  let restart = current.workspaceId !== args.workspaceId;
  if (!restart && newestMessageId !== current.newestMessageId) {
    // The tail moved. Rows after the previous newest row are the appended suffix; a previous
    // newest row that is gone means the tail was replaced (or the transcript was empty).
    const previousNewestIndex =
      current.newestMessageId === null
        ? -1
        : args.messages.findIndex((row) => row.id === current.newestMessageId);
    restart =
      previousNewestIndex === -1 && current.newestMessageId !== null
        ? true
        : exceedsOneStep(previousNewestIndex + 1, length, stepInputs);
  }
  if (restart) {
    current = startState(args.workspaceId, args.messages, stepInputs, current.generation + 1);
    setState(current);
  } else if (current.newestMessageId !== newestMessageId) {
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
    const anchorIndex = args.messages.findIndex((row) => row.id === current.anchorMessageId);
    fromIndex = nearestSafeCutAtOrBefore(
      anchorIndex === -1 ? current.anchorIndexHint : anchorIndex,
      length,
      args.isSafeCut
    );
    if (fromIndex === 0) {
      current = { ...current, anchorMessageId: null, anchorIndexHint: 0 };
      setState(current);
    } else if (fromIndex < length && args.messages[fromIndex].id !== current.anchorMessageId) {
      current = {
        ...current,
        anchorMessageId: args.messages[fromIndex].id,
        anchorIndexHint: fromIndex,
      };
      setState(current);
    }
  }
  assert(fromIndex >= 0 && fromIndex <= length, "reveal boundary must stay within the transcript");

  // The scheduled step reads the latest committed inputs when it runs, not what it captured
  // when scheduled: grouping can change while a frame is pending.
  const latest = useRef({ messages: args.messages, stepInputs, fromIndex });
  latest.current = { messages: args.messages, stepInputs, fromIndex };
  const scheduleFrame = args.scheduleFrame ?? transcriptRevealFrameScheduler.schedule;

  const anchorMessageId = current.anchorMessageId;
  const generation = current.generation;
  const workspaceId = args.workspaceId;
  useEffect(() => {
    if (anchorMessageId === null) return;
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
  }, [anchorMessageId, generation, workspaceId, scheduleFrame]);

  return { fromIndex, isFullyRevealed: current.anchorMessageId === null };
}
