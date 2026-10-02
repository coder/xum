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
    /**
     * Artifact paths with stored versions (Artifacts tab only). Paths missing from `entries`
     * are deleted working files whose versions stay viewable.
     */
    versionedPaths: z.array(z.string()).optional(),
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

/**
 * Artifact versions (M4). Each artifact (identified by its path relative to the artifacts dir)
 * keeps an append-only list of byte-exact copies in the workspace's host session dir, so old
 * versions stay viewable after the file changes, is deleted, or its container is gone.
 */
export const ArtifactVersionSourceSchema = z.enum(["publish", "turn-end", "attach_file"]);
export type ArtifactVersionSource = z.infer<typeof ArtifactVersionSourceSchema>;

/** Shelf pin requested by the agent's `artifact` tool; M5 copies pinned versions to the shelf. */
export const ArtifactPinSchema = z.enum(["project", "global"]);
export type ArtifactPin = z.infer<typeof ArtifactPinSchema>;

export const ArtifactVersionSchema = z.object({
  /** 1-based, increasing per artifact. */
  version: z.number().int().positive(),
  /** Title given at publish time; null for turn-end snapshots. */
  label: z.string().nullable(),
  source: ArtifactVersionSourceSchema,
  createdAtMs: z.number(),
  sha256: z.string(),
  size: z.number(),
  /** POSIX path relative to the artifacts dir at the time of the version. */
  path: z.string(),
  /** Kind override from the `artifact` tool; absent means "from the extension". */
  kind: ArtifactKindSchema.optional(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactVersionListSchema = z.object({
  /** Stable id derived from the path (see getArtifactId). */
  artifactId: z.string(),
  path: z.string(),
  pin: ArtifactPinSchema.nullable(),
  /** Newest first; empty when the artifact has no versions yet. */
  versions: z.array(ArtifactVersionSchema),
});
export type ArtifactVersionList = z.infer<typeof ArtifactVersionListSchema>;

/**
 * Pinned workspace files (Concept C): any file of the checkout shown live in the Artifacts tab.
 * Paths are relative to the workspace checkout.
 */
export const PinnedArtifactFileSchema = z.object({
  path: z.string(),
  kind: ArtifactKindSchema,
  /** null when the file is missing or not a regular file right now. */
  size: z.number().nullable(),
  modifiedMs: z.number().nullable(),
});
export type PinnedArtifactFile = z.infer<typeof PinnedArtifactFileSchema>;

export const PinnedArtifactFilesSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), files: z.array(PinnedArtifactFileSchema) }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type PinnedArtifactFiles = z.infer<typeof PinnedArtifactFilesSchema>;

/**
 * Cross-workspace shelf (M5c): pinned artifact versions shared by every workspace of a project
 * ("project") or by every workspace ("global"). Entries are read-only byte copies.
 */
export const ArtifactShelfScopeSchema = z.enum(["project", "global"]);
export type ArtifactShelfScope = z.infer<typeof ArtifactShelfScopeSchema>;

export const ArtifactShelfEntrySchema = z.object({
  scope: ArtifactShelfScopeSchema,
  /** Entry id within its scope (the source artifact path, flattened). */
  name: z.string(),
  /** File name of the pinned copy (keeps the extension). */
  file: z.string(),
  title: z.string(),
  kind: ArtifactKindSchema,
  size: z.number(),
  version: z.number(),
  sourceWorkspaceId: z.string(),
  sourcePath: z.string(),
  pinnedAtMs: z.number(),
  pinnedBy: z.enum(["agent", "user"]),
});
export type ArtifactShelfEntry = z.infer<typeof ArtifactShelfEntrySchema>;

export const ArtifactShelfListingSchema = z.object({
  /** Project shelf, or why this workspace has none (multi-project workspaces). */
  project: z.discriminatedUnion("available", [
    z.object({ available: z.literal(true), entries: z.array(ArtifactShelfEntrySchema) }),
    z.object({ available: z.literal(false), reason: z.string() }),
  ]),
  global: z.array(ArtifactShelfEntrySchema),
});
export type ArtifactShelfListing = z.infer<typeof ArtifactShelfListingSchema>;
