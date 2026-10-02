import { z } from "zod";
import { ARTIFACT_KINDS } from "@/common/utils/artifactKind";

/**
 * Schemas for the Artifacts tab oRPC surface (experiment: "artifacts").
 * Paths are always relative to the workspace's `$XUM_SCRATCH_DIR/artifacts`
 * dir; the backend owns containment and the read size cap.
 */

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

export const ArtifactEntrySchema = z.object({
  /** POSIX path relative to the artifacts dir, e.g. "reports/summary.md". */
  path: z.string(),
  kind: ArtifactKindSchema,
  size: z.number(),
  modifiedMs: z.number(),
});
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const ArtifactListingSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    /** Absolute artifacts dir as the agent sees it ($XUM_SCRATCH_DIR/artifacts). */
    dir: z.string(),
    /** Newest first. */
    entries: z.array(ArtifactEntrySchema),
    /** True when the walk stopped at the entry or depth limit. */
    truncated: z.boolean(),
  }),
  z.object({
    available: z.literal(false),
    /** Human-readable reason, e.g. the runtime has no scratch dir yet. */
    reason: z.string(),
  }),
]);
export type ArtifactListing = z.infer<typeof ArtifactListingSchema>;

const ArtifactFileMetaSchema = {
  path: z.string(),
  kind: ArtifactKindSchema,
  size: z.number(),
  modifiedMs: z.number(),
};

export const ArtifactReadResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    ...ArtifactFileMetaSchema,
    /** utf8 for text kinds, base64 for images. */
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
  }),
  /** The file is larger than the read cap; the tab shows the path instead. */
  z.object({ status: z.literal("too_large"), ...ArtifactFileMetaSchema, maxBytes: z.number() }),
  /** A non-image file containing NUL bytes; not previewable as text. */
  z.object({ status: z.literal("binary"), ...ArtifactFileMetaSchema }),
]);
export type ArtifactReadResult = z.infer<typeof ArtifactReadResultSchema>;

export const ArtifactCapabilitiesSchema = z.object({
  /**
   * Whether `agent-browser` is on the runtime's PATH, so the agent can look at its own HTML
   * artifacts. null when not probed yet or the probe failed.
   */
  agentBrowserAvailable: z.boolean().nullable(),
});
export type ArtifactCapabilities = z.infer<typeof ArtifactCapabilitiesSchema>;
