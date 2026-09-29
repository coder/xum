import { z } from "zod";
import { DRAFT_ID_PATTERN } from "@/constants/drafts";

/**
 * Composer drafts persisted by the backend DraftService (see src/node/services/draftService.ts).
 *
 * A workspace draft lives in `<sessionDir>/draft.json`; a creation draft (the "new workspace"
 * composer) lives in `<xumRoot>/drafts/<projectHash>/<draftId>.json`; the composer opened without
 * a draft id uses a fixed draft id (see defaultCreationDraftScope). The legacy renderer pending
 * scope (getPendingScopeId) is never a backend scope.
 */
export const DraftScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) }),
  z.object({
    kind: z.literal("creation"),
    projectPath: z.string().min(1),
    draftId: z.string().regex(DRAFT_ID_PATTERN),
  }),
]);

const ProviderDraftAttachmentSchema = z.object({
  kind: z.literal("provider"),
  id: z.string(),
  // A `data:` URL: provider attachments are sent inline, so the payload stays in the draft.
  url: z.string(),
  mediaType: z.string(),
  filename: z.string().optional(),
  resizeInfo: z
    .object({
      originalWidth: z.number(),
      originalHeight: z.number(),
      newWidth: z.number(),
      newHeight: z.number(),
    })
    .optional(),
});

const StagedDraftAttachmentSchema = z.object({
  kind: z.literal("staged"),
  id: z.string(),
  mediaType: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  // A path inside the workspace's worktree; stripped when a fork copies the draft.
  stagedPath: z.string(),
});

const PendingFileDraftAttachmentSchema = z.object({
  kind: z.literal("pending-file"),
  id: z.string(),
  mediaType: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  dataBase64: z.string(),
});

/** Mirrors the renderer's ChatAttachment union (checked at compile time in DraftStore). */
export const DraftAttachmentSchema = z.discriminatedUnion("kind", [
  ProviderDraftAttachmentSchema,
  StagedDraftAttachmentSchema,
  PendingFileDraftAttachmentSchema,
]);

/** An attachment without its payload, for bulk hydration and change events. */
export const DraftAttachmentMetadataSchema = z.object({
  id: z.string(),
  kind: z.enum(["provider", "staged", "pending-file"]),
  mediaType: z.string(),
  filename: z.string().optional(),
  /** Approximate payload size in bytes. */
  sizeBytes: z.number().nonnegative(),
});

export const DraftSchema = z.object({
  text: z.string(),
  attachments: z.array(DraftAttachmentSchema),
});

/**
 * Per-scope monotonic revision, bumped on every persisted change. Scopes start at the backend
 * process start time, so a restarted backend does not regress below the previous one in practice.
 */
const DraftRevisionSchema = z.number();

export const DraftSummarySchema = z.object({
  scope: DraftScopeSchema,
  text: z.string(),
  attachments: z.array(DraftAttachmentMetadataSchema),
  revision: DraftRevisionSchema,
});

export const DraftGetOutputSchema = DraftSchema.extend({ revision: DraftRevisionSchema });

export const DraftUpdateInputSchema = z.object({
  scope: DraftScopeSchema,
  // Partial: typing sends only text, attachment changes send only the attachment list.
  text: z.string().optional(),
  attachments: z.array(DraftAttachmentSchema).optional(),
});

export const DraftRevisionOutputSchema = z.object({ revision: DraftRevisionSchema });

export const DraftImportLegacyOutputSchema = z.object({
  /**
   * "applied": the backend had no draft and stored the legacy one. "present": the backend already
   * had a draft and kept it (never clobbered). "orphaned": the scope has no owner (unregistered
   * workspace, unconfigured project, invalid id), so nothing was stored. In every case the client
   * may delete its legacy keys.
   */
  result: z.enum(["applied", "present", "orphaned"]),
  revision: DraftRevisionSchema,
});

/**
 * One listed creation draft (a row under its project in the sidebar). The list lives in
 * `<xumRoot>/drafts/list.json`, separate from draft bodies: a listed draft may be empty (no body),
 * and clearing a draft's text never delists it. It used to be the renderer localStorage key
 * `workspaceDraftsByProject`, whose size budget dropped newer entries after a restart (#5225).
 */
export const DraftListEntrySchema = z.object({
  projectPath: z.string().min(1),
  draftId: z.string().regex(DRAFT_ID_PATTERN),
  /** Sub-project the workspace is created in; null for the project itself. */
  subProjectPath: z.string().min(1).nullable(),
  createdAt: z.number(),
});

/** The whole list with its revision (bumped on every change; starts at the process start time). */
export const DraftListSchema = z.object({
  entries: z.array(DraftListEntrySchema),
  revision: DraftRevisionSchema,
});

/**
 * `drafts.subscribe` stream: a full snapshot first (the same data as `drafts.list`, plus the
 * creation draft list), then one event per change (the whole list on a list change). A resubscription starts with a fresh snapshot, so a client that missed events while
 * disconnected reconciles from it (including deletions).
 */
export const DraftEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    drafts: z.array(DraftSummarySchema),
    list: DraftListSchema,
  }),
  DraftListSchema.extend({ type: z.literal("list") }),
  DraftSummarySchema.extend({ type: z.literal("changed") }),
  z.object({ type: z.literal("deleted"), scope: DraftScopeSchema, revision: DraftRevisionSchema }),
]);

export type DraftScope = z.infer<typeof DraftScopeSchema>;
export type DraftAttachment = z.infer<typeof DraftAttachmentSchema>;
export type DraftAttachmentMetadata = z.infer<typeof DraftAttachmentMetadataSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
export type DraftGetOutput = z.infer<typeof DraftGetOutputSchema>;
export type DraftUpdateInput = z.infer<typeof DraftUpdateInputSchema>;
export type DraftImportLegacyOutput = z.infer<typeof DraftImportLegacyOutputSchema>;
export type DraftEvent = z.infer<typeof DraftEventSchema>;
export type DraftListEntry = z.infer<typeof DraftListEntrySchema>;
export type DraftList = z.infer<typeof DraftListSchema>;
