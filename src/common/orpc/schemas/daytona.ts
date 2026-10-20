import { z } from "zod";

// Daytona sandbox config - attached to the SSH runtime when Daytona is the SSH backend.
export const DaytonaSandboxConfigSchema = z.object({
  /**
   * Daytona sandbox id.
   * - Omitted at creation: Xum creates a sandbox and fills this in.
   * - Given at creation: Xum attaches to that existing sandbox (and marks it shared).
   */
  sandboxId: z.string().optional().meta({ description: "Daytona sandbox id" }),
  snapshot: z
    .string()
    .optional()
    .meta({ description: "Snapshot used to create the sandbox (empty = Daytona default)" }),
  cpu: z.number().int().positive().optional().meta({ description: "vCPU count (size preset)" }),
  memoryGiB: z
    .number()
    .int()
    .positive()
    .optional()
    .meta({ description: "Memory in GiB (size preset)" }),
  diskGiB: z
    .number()
    .int()
    .positive()
    .optional()
    .meta({ description: "Disk in GiB (size preset)" }),
  target: z.string().optional().meta({ description: "Daytona target (region)" }),
  /**
   * True when the sandbox is not owned by this workspace alone (attached existing sandbox, or a
   * fork sharing its parent's sandbox). Shared sandboxes are never deleted with a workspace.
   */
  shared: z.boolean().optional().meta({
    description: "True if the sandbox is shared with other workspaces or pre-existing",
  }),
});

export type DaytonaSandboxConfig = z.infer<typeof DaytonaSandboxConfigSchema>;

export const DaytonaApiKeySourceSchema = z.enum(["settings", "env"]);
export type DaytonaApiKeySource = z.infer<typeof DaytonaApiKeySourceSchema>;

/** What the UI may see of the Daytona credentials: never the key itself. */
export const DaytonaPublicConfigSchema = z.object({
  apiKeySet: z.boolean(),
  apiKeySource: DaytonaApiKeySourceSchema.nullable(),
  apiUrl: z.string(),
  target: z.string().nullable(),
});

export type DaytonaPublicConfig = z.infer<typeof DaytonaPublicConfigSchema>;

export const DaytonaErrorKindSchema = z.enum([
  "not_configured",
  "unauthorized",
  "not_found",
  "bad_request",
  "unreachable",
  "timeout",
  "server",
]);

export type DaytonaErrorKind = z.infer<typeof DaytonaErrorKindSchema>;

const DaytonaFailureSchema = z.object({
  ok: z.literal(false),
  kind: DaytonaErrorKindSchema,
  error: z.string(),
});

export const DaytonaTestConnectionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  DaytonaFailureSchema,
]);

export type DaytonaTestConnectionResult = z.infer<typeof DaytonaTestConnectionResultSchema>;

/** Sandbox lifecycle collapsed to what Xum acts on; `missing` is a 404. */
export const DaytonaSandboxStateSchema = z.enum([
  "starting",
  "started",
  "stopped",
  "archived",
  "error",
  "missing",
]);

export type DaytonaSandboxState = z.infer<typeof DaytonaSandboxStateSchema>;

export const DaytonaSandboxSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  state: DaytonaSandboxStateSchema,
  cpu: z.number().optional(),
  memoryGiB: z.number().optional(),
  diskGiB: z.number().optional(),
  snapshot: z.string().optional(),
  target: z.string().optional(),
});

export type DaytonaSandboxSummary = z.infer<typeof DaytonaSandboxSummarySchema>;

export const DaytonaListSandboxesResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), sandboxes: z.array(DaytonaSandboxSummarySchema) }),
  DaytonaFailureSchema,
]);

export type DaytonaListSandboxesResult = z.infer<typeof DaytonaListSandboxesResultSchema>;

export const DaytonaListSnapshotsResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshots: z.array(z.object({ name: z.string() })) }),
  DaytonaFailureSchema,
]);

export type DaytonaListSnapshotsResult = z.infer<typeof DaytonaListSnapshotsResultSchema>;

// API schemas for the daytona namespace
export const daytona = {
  getConfig: {
    input: z.void(),
    output: DaytonaPublicConfigSchema,
  },
  setConfig: {
    // Each field: omitted = unchanged, empty string = cleared.
    input: z.object({
      apiKey: z.string().optional(),
      apiUrl: z.string().optional(),
      target: z.string().optional(),
    }),
    output: DaytonaPublicConfigSchema,
  },
  testConnection: {
    input: z.void(),
    output: DaytonaTestConnectionResultSchema,
  },
  listSandboxes: {
    input: z.void(),
    output: DaytonaListSandboxesResultSchema,
  },
  listSnapshots: {
    input: z.void(),
    output: DaytonaListSnapshotsResultSchema,
  },
};
