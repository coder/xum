import { z } from "zod";
import { CREATION_DRAFT_NAME_MAX_CHARS, DRAFT_ID_PATTERN } from "@/constants/drafts";
import { ServiceTierSchema } from "@/common/config/schemas/providersConfig";
import { OpenAIReasoningModeSchema, ThinkingLevelSchema } from "@/common/types/thinking";
import { AgentDefinitionScopeSchema } from "./agentDefinition";
import { CoderWorkspaceConfigSchema } from "./coder";
import { SendIdSchema, SendMessageOptionsSchema } from "./stream";

/**
 * Composer drafts persisted by the backend DraftService (see src/node/services/draftService.ts).
 *
 * A workspace draft lives in `<sessionDir>/draft.json`. A creation draft (the "new workspace"
 * composer) is one record, `<xumRoot>/creation-drafts/<draftId>.json` (CreationDraftSchema): its
 * project is data, not identity, so changing it keeps the draft. The legacy renderer pending
 * scope (getPendingScopeId) is never a backend scope.
 */
export const DraftScopeSchema = z.object({
  kind: z.literal("workspace"),
  workspaceId: z.string().min(1),
});

export const CreationDraftScopeSchema = z.object({
  kind: z.literal("creation"),
  draftId: z.string().regex(DRAFT_ID_PATTERN),
});

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
 * Idempotent sends: a workspace composer send whose acceptance is not settled yet. The draft keeps
 * its text and attachments (retained in the legacy `text`/`attachments` fields, hidden from the
 * composer) until the backend answers for its id: accepted drops them, not accepted makes them
 * visible again.
 */
export const PendingSendSchema = z.object({
  sendId: SendIdSchema,
  /** The backend process the latest attempt went to (WorkspaceService.getSendStatus). */
  receiverId: z.string().min(1),
  /** What the user typed: shown again when the send is not accepted. */
  text: z.string(),
  /** Draft attachments this send took, in send order (provider ones are its file parts). */
  attachmentIds: z.array(z.string()),
  /**
   * The exact request, so a retry (also after a reload) replays the same payload: same message,
   * same file parts (rebuilt from the attachments by id) and same muxMetadata, hence the same
   * send digest. The options also carry the model and agent, which the digest ignores.
   */
  request: z.object({
    message: z.string(),
    options: SendMessageOptionsSchema.omit({
      sendId: true,
      editMessageId: true,
      historyEditPrecondition: true,
      unfencedEdit: true,
    }),
  }),
});

/**
 * Per-scope monotonic revision, bumped on every persisted change. Scopes start at the backend
 * process start time, so a restarted backend does not regress below the previous one in practice.
 */
const DraftRevisionSchema = z.number();

/**
 * API views of a draft: `text` is the VISIBLE text (the composer's), without the text retained
 * for pending sends; `attachments` lists every attachment, retained ones included (a client hides
 * those named by `pendingSends`).
 */
export const DraftSummarySchema = z.object({
  scope: DraftScopeSchema,
  text: z.string(),
  attachments: z.array(DraftAttachmentMetadataSchema),
  pendingSends: z.array(PendingSendSchema).optional(),
  revision: DraftRevisionSchema,
});

export const DraftGetOutputSchema = DraftSchema.extend({
  pendingSends: z.array(PendingSendSchema).optional(),
  revision: DraftRevisionSchema,
});

/**
 * A pending send the writing window has seen since its fields were last in sync with the
 * backend (request only, never stored). The backend, not the window, merges what happened to it
 * meanwhile into the write: a send returned since (not accepted) keeps its restored text and
 * attachments, an accepted one stays gone. `undone`: the window could not confirm the send's draft
 * write (lost reply) and shows its text and attachments again; while the backend still holds the
 * entry, the write must not show them a second time. `inUnsavedText`: the window's text had an
 * unsaved edit holding the send's text when it saw the send (a stale copy). Only then (and for
 * a pending send the window did not see, or undid) does the backend take the send's text out of
 * the write: text a window types after it saw the send is the user's, even when it matches (e.g.
 * editing the sent message).
 */
export const BasisSendSchema = z.object({
  sendId: SendIdSchema,
  text: z.string(),
  attachmentIds: z.array(z.string()),
  undone: z.boolean().optional(),
  inUnsavedText: z.boolean().optional(),
});

export const DraftUpdateInputSchema = z.object({
  scope: DraftScopeSchema,
  // Partial: typing sends only text, attachment changes send only the attachment list. Both are
  // the VISIBLE part: the backend keeps what pending sends retain.
  text: z.string().optional(),
  attachments: z.array(DraftAttachmentSchema).optional(),
  basisSends: z.array(BasisSendSchema).max(1000).optional(),
});

/** A write's result: the stored draft's view after the backend merged the write. */
export const DraftWriteOutputSchema = z.object({
  revision: DraftRevisionSchema,
  text: z.string(),
  attachments: z.array(DraftAttachmentMetadataSchema),
  pendingSends: z.array(PendingSendSchema).optional(),
});

export const DraftBeginSendInputSchema = z.object({
  scope: DraftScopeSchema,
  pendingSend: PendingSendSchema,
  /** Payloads of `pendingSend.attachmentIds` the stored draft may lack (not saved yet). */
  attachments: z.array(DraftAttachmentSchema),
  /**
   * The sender's unsaved visible text, as its pending draft update would write it (one write
   * instead of two before the send); the backend then takes the sent text out of it.
   */
  text: z.string().optional(),
  /**
   * #6405, #6585: how the sender took the sent text (takeSentText with what it saw since Enter),
   * from its visible text `from`, or `text` when `from` is absent (one copy of the text per
   * request). The backend repeats that take only when its visible text (after `text` is merged
   * in) is exactly that text. Otherwise it applies the whitespace rule (removeSentText).
   */
  localTake: z
    .object({ kind: z.enum(["typed-after", "edited"]), from: z.string().optional() })
    .optional(),
  /** As for drafts.update: the pending sends the sender's unsaved text was written against. */
  basisSends: z.array(BasisSendSchema).max(1000).optional(),
});

export const DraftSetSendReceiverInputSchema = z.object({
  scope: DraftScopeSchema,
  sendId: SendIdSchema,
  receiverId: z.string().min(1),
});

export const DraftSetSendReceiverOutputSchema = z.object({
  revision: DraftRevisionSchema,
  /** False: the entry is gone (already resolved): nothing was written, do not re-send. */
  present: z.boolean(),
});

export const DraftResolveSendsInputSchema = z.object({
  scope: DraftScopeSchema,
  /**
   * Ids this client has a send request in flight for: not looked up (a lookup before the request
   * reaches the receiver makes it refuse the send).
   */
  exceptSendIds: z.array(z.string()).optional(),
});

export const SendStatusSchema = z.enum(["accepted", "pending", "not-accepted", "unknown"]);

export const DraftResolveSendsOutputSchema = z.object({
  /** The receiver that answered (absent when nothing was looked up). */
  receiverId: z.string().optional(),
  statuses: z.array(z.object({ sendId: z.string(), status: SendStatusSchema })),
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
 * `drafts.subscribe` stream (workspace drafts): a full snapshot first (the same data as
 * `drafts.list`), then one event per change. A resubscription starts with a fresh snapshot, so a
 * client that missed events while disconnected reconciles from it (including deletions).
 */
export const DraftEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), drafts: z.array(DraftSummarySchema) }),
  DraftSummarySchema.extend({ type: z.literal("changed") }),
  z.object({ type: z.literal("deleted"), scope: DraftScopeSchema, revision: DraftRevisionSchema }),
]);

/** Mirrors ParsedRuntime (src/common/types/runtime.ts). */
const ParsedRuntimeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }),
  z.object({ mode: z.literal("worktree") }),
  z.object({
    mode: z.literal("ssh"),
    host: z.string(),
    coder: CoderWorkspaceConfigSchema.optional(),
  }),
  z.object({
    mode: z.literal("docker"),
    image: z.string(),
    shareCredentials: z.boolean().optional(),
  }),
  z.object({
    mode: z.literal("devcontainer"),
    configPath: z.string(),
    shareCredentials: z.boolean().optional(),
  }),
]);

/**
 * A creation draft's execution choices, grouped with the project they were made for: the backend
 * refuses a save whose `projectPath` is not the record's (a stale window's choices for another
 * project). Null fields (and a null group) fall back to the project's defaults.
 */
export const CreationDraftExecutionSchema = z.object({
  projectPath: z.string().min(1),
  agent: z.object({ id: z.string().min(1), scope: AgentDefinitionScopeSchema }).nullable(),
  runtime: ParsedRuntimeSchema.nullable(),
  trunkBranch: z.string().nullable(),
});

/**
 * One creation draft. Its AI choices and manual name belong to the draft: a project change keeps
 * them, and project defaults only seed a new draft. Absent AI fields fall back to defaults.
 */
export const CreationDraftSchema = z.object({
  id: z.string().regex(DRAFT_ID_PATTERN),
  projectPath: z.string().min(1),
  /** Sub-project the workspace is created in; null for the project itself. */
  subProjectPath: z.string().min(1).nullable(),
  createdAt: z.number(),
  text: z.string(),
  // Staged attachments are worktree paths: a creation draft has no worktree.
  attachments: z.array(
    z.discriminatedUnion("kind", [ProviderDraftAttachmentSchema, PendingFileDraftAttachmentSchema])
  ),
  /** Empty: the workspace is named automatically on Send. */
  manualName: z.string().max(CREATION_DRAFT_NAME_MAX_CHARS),
  ai: z.object({
    model: z.string().optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    reasoningMode: OpenAIReasoningModeSchema.optional(),
    serviceTier: ServiceTierSchema.optional(),
  }),
  intent: z.object({
    model: z.literal(true).optional(),
    thinkingLevel: z.literal(true).optional(),
    reasoningMode: z.literal(true).optional(),
    serviceTier: z.literal(true).optional(),
  }),
  auto: z.object({ model: z.boolean().optional(), thinkingLevel: z.boolean().optional() }),
  execution: CreationDraftExecutionSchema.nullable(),
});

/** A creation draft deleted by a project removal. */
export const RemovedCreationDraftSchema = z.object({
  projectPath: z.string().min(1),
  draftId: z.string().regex(DRAFT_ID_PATTERN),
});

/** A sidebar row: kept in backend memory, so listing never reads payloads. */
export const CreationDraftSummarySchema = CreationDraftSchema.pick({
  projectPath: true,
  subProjectPath: true,
  createdAt: true,
  manualName: true,
}).extend({ draftId: z.string().regex(DRAFT_ID_PATTERN), preview: z.string() });

export const CreationDraftListSchema = z.object({
  drafts: z.array(CreationDraftSummarySchema),
  /** Old drafts the one-way import kept because a newer draft differs (their files stay). */
  importError: z.string().nullable(),
});

/** Partial: omitted fields keep their stored value; only an explicit `projectPath` moves it. */
export const CreationDraftUpdateInputSchema = CreationDraftSchema.omit({ id: true })
  .partial()
  .extend({ scope: CreationDraftScopeSchema });

/** A pre-record renderer draft (localStorage text or a typed name) of an old creation scope. */
export const CreationDraftImportLegacyInputSchema = z.object({
  projectPath: z.string().min(1),
  legacyDraftId: z.string().regex(DRAFT_ID_PATTERN),
  text: z.string().optional(),
  attachments: z.array(DraftAttachmentSchema).optional(),
  manualName: z.string().max(CREATION_DRAFT_NAME_MAX_CHARS).optional(),
});

export const CreationDraftImportLegacyOutputSchema = z.object({
  /** "conflict": a newer draft differs; the caller keeps its legacy keys (and shows the error). */
  result: z.enum(["imported", "conflict", "orphaned"]),
});

export type DraftScope = z.infer<typeof DraftScopeSchema>;
export type DraftAttachment = z.infer<typeof DraftAttachmentSchema>;
export type DraftAttachmentMetadata = z.infer<typeof DraftAttachmentMetadataSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
export type DraftGetOutput = z.infer<typeof DraftGetOutputSchema>;
export type DraftUpdateInput = z.infer<typeof DraftUpdateInputSchema>;
export type BasisSend = z.infer<typeof BasisSendSchema>;
export type DraftWriteOutput = z.infer<typeof DraftWriteOutputSchema>;
export type PendingSend = z.infer<typeof PendingSendSchema>;
export type DraftBeginSendInput = z.infer<typeof DraftBeginSendInputSchema>;
export type LocalTake = NonNullable<DraftBeginSendInput["localTake"]>;
export type DraftSetSendReceiverInput = z.infer<typeof DraftSetSendReceiverInputSchema>;
export type DraftResolveSendsInput = z.infer<typeof DraftResolveSendsInputSchema>;
export type DraftResolveSendsOutput = z.infer<typeof DraftResolveSendsOutputSchema>;
export type SendStatus = z.infer<typeof SendStatusSchema>;
export type DraftImportLegacyOutput = z.infer<typeof DraftImportLegacyOutputSchema>;
export type DraftEvent = z.infer<typeof DraftEventSchema>;
export type RemovedCreationDraft = z.infer<typeof RemovedCreationDraftSchema>;
export type CreationDraftScope = z.infer<typeof CreationDraftScopeSchema>;
export type CreationDraft = z.infer<typeof CreationDraftSchema>;
export type CreationDraftExecution = z.infer<typeof CreationDraftExecutionSchema>;
export type CreationDraftSummary = z.infer<typeof CreationDraftSummarySchema>;
export type CreationDraftList = z.infer<typeof CreationDraftListSchema>;
export type CreationDraftUpdateInput = z.infer<typeof CreationDraftUpdateInputSchema>;
export type CreationDraftImportLegacyInput = z.infer<typeof CreationDraftImportLegacyInputSchema>;
