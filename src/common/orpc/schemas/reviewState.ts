import { z } from "zod";
import type { Review, ReviewNoteData, ReviewStatus } from "@/common/types/review";

// Review data schema for queued message display and persisted review notes.
export const ReviewNoteDataSchema = z.object({
  filePath: z.string(),
  lineRange: z.string(),
  selectedCode: z.string(),
  selectedDiff: z.string().optional(),
  oldStart: z.number().optional(),
  newStart: z.number().optional(),
  userNote: z.string(),
});

export const ReviewStatusSchema = z.enum(["pending", "attached", "checked"]);

export const ReviewSchema = z.object({
  id: z.string(),
  data: ReviewNoteDataSchema,
  status: ReviewStatusSchema,
  createdAt: z.number(),
  statusChangedAt: z.number().optional(),
});

// Compile-time guard: the persisted schemas must describe exactly the shared Review types, so
// adding a field (even an optional one) on only one side fails typecheck.
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type ReviewSchemasMatchTypes = [
  Assert<Exactly<z.infer<typeof ReviewNoteDataSchema>, ReviewNoteData>>,
  Assert<Exactly<z.infer<typeof ReviewStatusSchema>, ReviewStatus>>,
  Assert<Exactly<z.infer<typeof ReviewSchema>, Review>>,
];
type Assert<T extends true> = T;

export const HunkReadStateSchema = z.object({
  hunkId: z.string(),
  isRead: z.boolean(),
  timestamp: z.number(),
});

export const ReadMoreStateSchema = z.object({
  up: z.number().int().nonnegative(),
  down: z.number().int().nonnegative(),
});

/**
 * Entry schema per review-state section. Every section is a string-keyed record,
 * so every client mutation is expressible as per-entry set/delete.
 */
export const REVIEW_STATE_ENTRY_SCHEMAS = {
  reviews: ReviewSchema,
  readState: HunkReadStateSchema,
  firstSeen: z.number(),
  hunkExpand: z.boolean(),
  readMore: ReadMoreStateSchema,
} as const;

export type ReviewStateSection = keyof typeof REVIEW_STATE_ENTRY_SCHEMAS;

export const REVIEW_STATE_SECTIONS = Object.keys(
  REVIEW_STATE_ENTRY_SCHEMAS
) as ReviewStateSection[];

function sectionRecord<T extends z.ZodType>(entry: T) {
  return z.record(z.string(), entry);
}

/**
 * An ABSENT section means "never written on the backend"; an empty object means
 * written-and-empty. The distinction is what keeps the one-time localStorage
 * import from clobbering newer backend data.
 */
export const ReviewStateSectionsSchema = z.object({
  reviews: sectionRecord(ReviewSchema).optional(),
  readState: sectionRecord(HunkReadStateSchema).optional(),
  firstSeen: sectionRecord(z.number()).optional(),
  hunkExpand: sectionRecord(z.boolean()).optional(),
  readMore: sectionRecord(ReadMoreStateSchema).optional(),
});

export const ReviewStateSnapshotSchema = z.object({
  sections: ReviewStateSectionsSchema,
});

/**
 * Wire-only ordering for snapshots (never persisted): the backend's in-memory per-workspace
 * counter, bumped on every persisted change. It lets a client tell whether a write's reply is
 * older than a subscription push it already applied. It is only comparable within one
 * subscription to one backend process, so clients reset it on each subscription's first event.
 */
const ReviewStateRevisionSchema = z.number();

/** `update` reply: the snapshot right after this write, and that write's revision. */
export const ReviewStateUpdateOutputSchema = ReviewStateSnapshotSchema.extend({
  revision: ReviewStateRevisionSchema,
});

function sectionDelta<T extends z.ZodType>(entry: T) {
  return z.object({
    set: sectionRecord(entry).optional(),
    delete: z.array(z.string()).optional(),
  });
}

/** Per-entry changes per section; untouched sections are omitted. */
export const ReviewStateDeltaSchema = z.object({
  reviews: sectionDelta(ReviewSchema).optional(),
  readState: sectionDelta(HunkReadStateSchema).optional(),
  firstSeen: sectionDelta(z.number()).optional(),
  hunkExpand: sectionDelta(z.boolean()).optional(),
  readMore: sectionDelta(ReadMoreStateSchema).optional(),
});

export const ReviewStateImportResultSchema = z.enum(["applied", "present"]);

export const ReviewStateImportLegacyOutputSchema = z.object({
  snapshot: ReviewStateSnapshotSchema,
  revision: ReviewStateRevisionSchema,
  results: z.object({
    reviews: ReviewStateImportResultSchema.optional(),
    readState: ReviewStateImportResultSchema.optional(),
    firstSeen: ReviewStateImportResultSchema.optional(),
    hunkExpand: ReviewStateImportResultSchema.optional(),
    readMore: ReviewStateImportResultSchema.optional(),
  }),
});

export const ReviewStateEventSchema = z.object({
  type: z.literal("snapshot"),
  snapshot: ReviewStateSnapshotSchema,
  revision: ReviewStateRevisionSchema,
});

export type ReviewStateSections = z.infer<typeof ReviewStateSectionsSchema>;
export type ReviewStateSnapshot = z.infer<typeof ReviewStateSnapshotSchema>;
export type ReviewStateDelta = z.infer<typeof ReviewStateDeltaSchema>;
export type ReviewStateUpdateOutput = z.infer<typeof ReviewStateUpdateOutputSchema>;
export type ReviewStateImportLegacyOutput = z.infer<typeof ReviewStateImportLegacyOutputSchema>;
export type ReviewStateEvent = z.infer<typeof ReviewStateEventSchema>;
/** Full record type for one section. */
export type ReviewStateSectionValue<S extends ReviewStateSection> = NonNullable<
  ReviewStateSections[S]
>;
/** Delta type for one section. */
export type ReviewStateSectionDelta<S extends ReviewStateSection> = NonNullable<
  ReviewStateDelta[S]
>;
