/**
 * Pure merge/sanitize/cap helpers for per-workspace code-review state.
 *
 * Shared by the backend store (ReviewStateService, `<sessionDir>/review-state.json`)
 * and the frontend ReviewStateStore view composition so client and server agree on
 * the result of applying the same delta.
 */
import {
  REVIEW_STATE_ENTRY_SCHEMAS,
  REVIEW_STATE_SECTIONS,
  type ReviewStateDelta,
  type ReviewStateSection,
  type ReviewStateSectionDelta,
  type ReviewStateSections,
  type ReviewStateSnapshot,
} from "@/common/orpc/schemas/reviewState";
import { MAX_FIRST_SEEN_RECORDS, MAX_READ_STATES } from "@/constants/reviewState";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createEmptyReviewStateSnapshot(): ReviewStateSnapshot {
  return { sections: {} };
}

function keepNewest<V>(
  record: Record<string, V>,
  maxCount: number,
  timestampOf: (value: V) => number
): Record<string, V> {
  const entries = Object.entries(record);
  if (entries.length <= maxCount) return record;
  entries.sort((a, b) => timestampOf(b[1]) - timestampOf(a[1]));
  return Object.fromEntries(entries.slice(0, maxCount));
}

/**
 * Enforce the per-workspace caps. Returns the same object when nothing was evicted
 * so callers can rely on referential stability for untouched data.
 */
export function capReviewStateSections(sections: ReviewStateSections): ReviewStateSections {
  const readState =
    sections.readState &&
    keepNewest(sections.readState, MAX_READ_STATES, (state) => state.timestamp);
  const firstSeen =
    sections.firstSeen &&
    keepNewest(sections.firstSeen, MAX_FIRST_SEEN_RECORDS, (timestamp) => timestamp);
  if (readState === sections.readState && firstSeen === sections.firstSeen) {
    return sections;
  }
  return { ...sections, readState, firstSeen };
}

function sanitizeSection<S extends ReviewStateSection>(
  section: S,
  raw: unknown
): { value: ReviewStateSections[S]; dropped: number } {
  if (!isPlainObject(raw)) {
    // A non-object section is treated as never written so a legacy import can repair it.
    return { value: undefined, dropped: raw === undefined ? 0 : 1 };
  }
  const schema = REVIEW_STATE_ENTRY_SCHEMAS[section];
  const result: Record<string, unknown> = {};
  let dropped = 0;
  for (const [key, entry] of Object.entries(raw)) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) {
      result[key] = parsed.data;
    } else {
      dropped++;
    }
  }
  // Every kept entry passed the section's entry schema above.
  return { value: result as ReviewStateSections[S], dropped };
}

/**
 * Self-healing load: validates every entry independently and drops invalid ones,
 * so one malformed entry (or a hand-edited file) never bricks the review pane.
 */
export function sanitizeReviewStateSnapshot(raw: unknown): {
  snapshot: ReviewStateSnapshot;
  droppedEntries: number;
} {
  const rawSections = isPlainObject(raw) && isPlainObject(raw.sections) ? raw.sections : {};
  const sections: ReviewStateSections = {};
  let droppedEntries = 0;
  for (const section of REVIEW_STATE_SECTIONS) {
    const { value, dropped } = sanitizeSection(section, rawSections[section]);
    droppedEntries += dropped;
    if (value !== undefined) {
      assignSection(sections, section, value);
    }
  }
  return { snapshot: { sections: capReviewStateSections(sections) }, droppedEntries };
}

export function assignSection<S extends ReviewStateSection>(
  sections: ReviewStateSections,
  section: S,
  value: ReviewStateSections[S]
): void {
  sections[section] = value;
}

/** Replace one whole section (used by the legacy import); caps still apply. */
export function withReviewStateSection<S extends ReviewStateSection>(
  sections: ReviewStateSections,
  section: S,
  value: NonNullable<ReviewStateSections[S]>
): ReviewStateSections {
  const next: ReviewStateSections = { ...sections };
  assignSection(next, section, value);
  return capReviewStateSections(next);
}

/** Combines a key present on both sides; absent means last write wins. */
type EntryMerge<V> = ((existing: V, incoming: V) => V) | undefined;

/**
 * First-seen rule: keep the earliest timestamp. A minimum (not "existing wins") makes the
 * result independent of the order in which clients' reports arrive.
 */
const earliest: EntryMerge<number> = (existing, incoming) => Math.min(existing, incoming);

/** Apply one section delta. Deletes run before sets, so a key present in both ends up set. */
function applySectionDelta<V>(
  existing: Record<string, V> | undefined,
  delta: { set?: Record<string, V>; delete?: string[] },
  merge: EntryMerge<V>
): Record<string, V> {
  const next: Record<string, V> = { ...existing };
  for (const key of delta.delete ?? []) {
    delete next[key];
  }
  for (const [key, value] of Object.entries(delta.set ?? {})) {
    next[key] = merge && key in next ? merge(next[key], value) : value;
  }
  return next;
}

/**
 * Apply a delta to sections. Any section touched by the delta becomes present
 * (even if empty); untouched sections keep their object identity.
 *
 * Merge rule per entry: last write wins, except `firstSeen`, where the earliest
 * timestamp is kept so a second client can never move first-seen later.
 */
export function applyReviewStateDelta(
  sections: ReviewStateSections,
  delta: ReviewStateDelta
): ReviewStateSections {
  const next: ReviewStateSections = { ...sections };
  if (delta.reviews) next.reviews = applySectionDelta(sections.reviews, delta.reviews, undefined);
  if (delta.readState) {
    next.readState = applySectionDelta(sections.readState, delta.readState, undefined);
  }
  if (delta.firstSeen) {
    next.firstSeen = applySectionDelta(sections.firstSeen, delta.firstSeen, earliest);
  }
  if (delta.hunkExpand) {
    next.hunkExpand = applySectionDelta(sections.hunkExpand, delta.hunkExpand, undefined);
  }
  if (delta.readMore)
    next.readMore = applySectionDelta(sections.readMore, delta.readMore, undefined);
  return capReviewStateSections(next);
}

function mergeSectionDeltas<V>(
  first: { set?: Record<string, V>; delete?: string[] } | undefined,
  second: { set?: Record<string, V>; delete?: string[] } | undefined,
  merge: EntryMerge<V>
): { set?: Record<string, V>; delete?: string[] } | undefined {
  if (!first) return second;
  if (!second) return first;
  const secondDeletes = new Set(second.delete ?? []);
  const firstSet = Object.fromEntries(
    Object.entries(first.set ?? {}).filter(([key]) => !secondDeletes.has(key))
  );
  // Applying the merged delta (deletes, then sets) must equal applying `first` then `second`.
  const set = applySectionDelta(firstSet, { set: second.set }, merge);
  const deletes = [...new Set([...(first.delete ?? []), ...secondDeletes])];
  return {
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(deletes.length > 0 ? { delete: deletes } : {}),
  };
}

/**
 * Combine deltas into one whose application equals applying them in order, except for the
 * caps: they apply once, after the whole batch, so an entry an intermediate cap would have
 * evicted may survive (it is still valid data, and the final cap still bounds the result).
 * Used by the frontend store to flush all pending local changes in one request.
 */
export function mergeReviewStateDeltas(deltas: readonly ReviewStateDelta[]): ReviewStateDelta {
  let merged: ReviewStateDelta = {};
  for (const delta of deltas) {
    merged = {
      reviews: mergeSectionDeltas(merged.reviews, delta.reviews, undefined),
      readState: mergeSectionDeltas(merged.readState, delta.readState, undefined),
      firstSeen: mergeSectionDeltas(merged.firstSeen, delta.firstSeen, earliest),
      hunkExpand: mergeSectionDeltas(merged.hunkExpand, delta.hunkExpand, undefined),
      readMore: mergeSectionDeltas(merged.readMore, delta.readMore, undefined),
    };
  }
  return merged;
}

/** Wrap a single-section delta into a full delta. */
export function sectionDelta<S extends ReviewStateSection>(
  section: S,
  delta: ReviewStateSectionDelta<S>
): ReviewStateDelta {
  const result: ReviewStateDelta = {};
  result[section] = delta;
  return result;
}
