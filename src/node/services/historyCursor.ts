import {
  SESSION_HISTORY_MAX_ID_CHARS,
  SESSION_HISTORY_RESET_PROBE_CHARS,
} from "@/common/constants/contextBudget";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { z } from "zod";

/** IDs must fit tool inputs and their JSON envelopes without lossy aliases. */
export function isHistoryIdentifierRepresentable(id: string): boolean {
  return (
    id.length <= SESSION_HISTORY_MAX_ID_CHARS &&
    Buffer.byteLength(JSON.stringify(id)) <= SESSION_HISTORY_MAX_ID_CHARS
  );
}

const offset = z.number().int().nonnegative().safe();
export const HistoryArtifactSchema = z.enum(["chat", "archive"]);
export type HistoryArtifact = z.infer<typeof HistoryArtifactSchema>;
export const HistorySnapshotSchema = z
  .object({
    endOffsetSnapshot: offset,
    inode: z.string(),
    modifiedTimeMs: z.number(),
    headHash: z.string(),
    anchorHash: z.string(),
  })
  .strict();
export type HistorySnapshot = z.infer<typeof HistorySnapshotSchema>;
const positionFields = {
  byteOffset: offset,
  skippingOversized: z.boolean(),
  oversizedRowEnd: offset.nullable(),
  resetProbe: z.string().max(SESSION_HISTORY_RESET_PROBE_CHARS),
  resetStage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  possibleReset: z.boolean(),
};
// null means an unaddressable persisted window, not an alias for the root.
const windowIdField = z.string().refine(isHistoryIdentifierRepresentable).nullable();
const windowBoundaryKindField = z.nativeEnum(CONTEXT_BOUNDARY_KINDS).nullable();
const rowLocation = z.object({ artifact: HistoryArtifactSchema, byteOffset: offset }).strict();
export const HistoryScanStateSchema = z
  .object({
    provenanceEpoch: z.string().uuid(),
    snapshots: z.object({ chat: HistorySnapshotSchema, archive: HistorySnapshotSchema }).strict(),
    validatedChatSnapshot: HistorySnapshotSchema,
    // Oldest-first: floor -> browse -> done. Newest-first: floor -> (probe -> deliver)* -> done.
    phase: z.enum(["floor", "browse", "probe", "deliver", "done"]),
    recentFirst: z.boolean(),
    artifact: HistoryArtifactSchema,
    ...positionFields,
    archiveWatermark: z.number().int().min(-1).safe(),
    anchorSequence: offset.nullable(),
    windowId: windowIdField,
    windowBoundaryKind: windowBoundaryKindField,
    windowPending: z.boolean(),
    appendCheck: z
      .object({ snapshot: HistorySnapshotSchema, ...positionFields })
      .strict()
      .nullable(),
    // Newest-first browsing never crosses the floor discovered by the floor phase.
    floor: z
      .object({
        artifact: HistoryArtifactSchema,
        byteOffset: offset,
        windowId: windowIdField,
        windowBoundaryKind: windowBoundaryKindField,
      })
      .strict()
      .nullable(),
    // Reverse discovery position: only locations, never buffered rows.
    probe: z
      .object({
        artifact: HistoryArtifactSchema,
        ...positionFields,
        lowestReadable: rowLocation.nullable(),
      })
      .strict()
      .nullable(),
    // The window span currently being delivered in reverse, ending at artifact/byteOffset above.
    span: z
      .object({
        start: rowLocation,
        windowId: windowIdField,
        windowBoundaryKind: windowBoundaryKindField,
        startsWindow: rowLocation.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type HistoryScanState = z.infer<typeof HistoryScanStateSchema>;
