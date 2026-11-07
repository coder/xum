import { z } from "zod";
import {
  SettingsBackupInputSchema,
  SettingsBackupSchema,
} from "@/common/config/schemas/settingsBackup";
import {
  AgentPluginGitSourceSchema,
  AgentPluginImportedComponentsSchema,
  AgentPluginInstallEntrySchema,
} from "@/common/config/schemas/agentPluginInstalls";
import { AgentPluginInstallMethodSchema } from "./agentPlugins";
import { ResultSchema } from "./result";

/**
 * An MCP command a restore would introduce or change. `token` binds the approval to this
 * exact command text, so an approval cannot carry over to a command the repository
 * changed after the user read it.
 */
export const BackupCommandApprovalSchema = z.object({
  path: z.string(),
  command: z.string(),
  token: z.string(),
});

/**
 * A project-bundle entry that is not registered on this machine at exactly its recorded
 * path. Nothing is written for it unless the user approves the import explicitly. `token`
 * binds the approval to the exact entry and memory content it was shown for, so a
 * repository change between preview and restore forces re-approval.
 */
export const BackupProjectImportSchema = z.object({
  sourcePath: z.string(),
  name: z.string(),
  /** Display-only hint; the user clones manually. Never rendered as a link or executed. */
  gitRemote: z.string().nullish(),
  memoryFileCount: z.number(),
  token: z.string(),
});

/** One approved import's outcome; failures are reported per candidate, never thrown. */
export const BackupProjectImportResultSchema = z.object({
  sourcePath: z.string(),
  targetPath: z.string(),
  name: z.string(),
  status: z.enum(["imported", "failed"]),
  message: z.string().nullish(),
  writtenFiles: z.array(z.string()),
  /** Existing target files with different content: kept, reported, never overwritten. */
  skippedFiles: z.array(z.string()),
  /**
   * True when this import registered the target as a new project. The safety snapshot does
   * not cover registrations, so undoing the import means unregistering it — but only then:
   * an import into an already registered project must not tell the user to remove it.
   */
  registered: z.boolean(),
});

/**
 * A full commit id. The same shape as `isFullCommitSha` (src/node/services/agentPlugins/sourceInput.ts),
 * which common code cannot import. Lowercase only: the install status and the pinned-commit check
 * compare ids as exact strings, and git prints lowercase.
 */
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Cap on the plugins one backup list names: it is repository-controlled, and a restore shows every row. */
export const MAX_BACKUP_PLUGIN_ENTRIES = 512;

/**
 * One managed Agent Plugin as the backup records it: where it came from and which commit it was
 * pinned to. Only what is needed to offer the install again. Consent, hook trust, approved copies,
 * enabled servers and timestamps are local facts and never travel (the parse drops them): another
 * machine's review is the only thing that can approve a plugin there. Fields are capped like the
 * project bundle's, because the list is repository-controlled.
 */
export const BackupPluginEntrySchema = z.object({
  name: AgentPluginInstallEntrySchema.shape.name,
  source: AgentPluginGitSourceSchema.extend({
    // The list is repository-controlled and the preview hands this URL to git: a leading dash
    // would be read as a git option, not a repository. The preview trims its input, so leading
    // whitespace before the dash is refused too.
    url: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[^\s-]/, { message: "A repository URL must not start with '-' or whitespace" }),
    ref: z.string().min(1).max(256),
    subpath: z.string().min(1).max(1024).optional(),
  }),
  /** Full commit id: a restore previews this exact commit, whatever `source.ref` tracks now. */
  lockedSha: z.string().regex(FULL_COMMIT_SHA_PATTERN, { message: "Not a full commit id" }),
  /** The install method of a plugin Xum generated a plugin.json for; absent takes the first that fits. */
  method: AgentPluginInstallMethodSchema.optional(),
  importedComponents: AgentPluginImportedComponentsSchema.optional(),
});

/** The `agent-plugins/manifest.json` sidecar of a backup. */
export const BackupPluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    plugins: z.array(BackupPluginEntrySchema).max(MAX_BACKUP_PLUGIN_ENTRIES),
  })
  .refine(
    (manifest) =>
      new Set(manifest.plugins.map((plugin) => plugin.name)).size === manifest.plugins.length,
    {
      message: "The plugin list names a plugin twice",
    }
  );

/**
 * How a listed plugin compares with this machine's managed installs: `missing` (nothing by that
 * name), `installed` (that name at the same commit), `conflict` (that name is taken by another
 * commit or by a folder the installer does not manage).
 */
export const BackupPluginInstallStatusSchema = z.enum(["missing", "installed", "conflict"]);

export const BackupPluginInstallSchema = BackupPluginEntrySchema.extend({
  status: BackupPluginInstallStatusSchema,
});

/**
 * What a push removes from the backup's plugin list: the listed plugins this machine's export
 * leaves out, and `wholeList` when the backup has a list and the push writes none. The push
 * refuses until it carries the `approval` of exactly this removal (a changed list asks again).
 */
export const BackupPluginRemovalSchema = z.object({
  names: z.array(z.string()),
  wholeList: z.boolean(),
  approval: z.string(),
});

export const BackupOperationErrorSchema = z.object({
  code: z.enum([
    "AUTH_FAILED",
    "REMOTE_UNREACHABLE",
    "REPOSITORY_CHANGED",
    "INVALID_BACKUP",
    "SECRET_DETECTED",
    "COMMAND_APPROVAL_REQUIRED",
    "PROJECT_IMPORT_APPROVAL_REQUIRED",
    "PLUGIN_REMOVAL_APPROVAL_REQUIRED",
    "IO_ERROR",
    "GIT_ERROR",
  ]),
  message: z.string(),
  files: z.array(z.string()).nullish(),
  /** Echo back on the next push to approve exactly the payload that was blocked. */
  secretApproval: z.string().nullish(),
  /**
   * On COMMAND_APPROVAL_REQUIRED: every command the restore needs approved, so a restore
   * attempted without a preview, or after the backup drifted, can present the current
   * list instead of a stale or empty one.
   */
  commandApprovals: z.array(BackupCommandApprovalSchema).nullish(),
  /**
   * On PROJECT_IMPORT_APPROVAL_REQUIRED: the current import candidates, recomputed from
   * the checked-out payload, so a restore whose approval tokens went stale can present
   * the fresh list instead of failing opaquely.
   */
  projectImports: z.array(BackupProjectImportSchema).nullish(),
  /**
   * On PLUGIN_REMOVAL_APPROVAL_REQUIRED: what the push would remove from the backup's plugin
   * list. Echo `approval` back as `approvedPluginRemovalDigest` to push anyway.
   */
  pluginRemoval: BackupPluginRemovalSchema.nullish(),
  /**
   * Set when a restore fails after its safety snapshot completed: files may already have
   * been overwritten, and the snapshot is the only recovery path, so a failure report
   * that omitted it would hide the copy the user needs.
   */
  snapshotPath: z.string().nullish(),
});

export const BackupFileChangeSchema = z.object({
  path: z.string(),
  status: z.string(),
});

export const BackupCredentialKindSchema = z.enum(["ssh", "gh", "ambient"]);

const BackupResult = <T extends z.ZodTypeAny>(schema: T) =>
  ResultSchema(schema, BackupOperationErrorSchema);

export const backup = {
  getSettings: {
    output: SettingsBackupSchema.nullable(),
  },
  saveSettings: {
    input: SettingsBackupInputSchema,
    output: BackupResult(SettingsBackupSchema),
  },
  validate: {
    input: SettingsBackupInputSchema,
    output: BackupResult(
      z.object({
        reachable: z.literal(true),
        credential: BackupCredentialKindSchema,
        empty: z.boolean(),
      })
    ),
  },
  preview: {
    input: SettingsBackupInputSchema,
    output: BackupResult(
      z.object({
        pushChanges: z.array(BackupFileChangeSchema),
        restoreChanges: z.array(BackupFileChangeSchema),
        localOnlyFiles: z.array(z.string()),
        redactions: z.array(z.string()),
        commandApprovals: z.array(BackupCommandApprovalSchema),
        /** Project-bundle entries a restore would only import with explicit approval. */
        projectImports: z.array(BackupProjectImportSchema),
        /** The backup carries a project bundle but `includeProjects` is off, so it is skipped. */
        projectBundleSkipped: z.boolean(),
        /** Artifact shelf files left out of the push or a restore, each with its reason. */
        shelfSkipped: z.array(z.string()).optional(),
        /** The backup's plugin list against this machine's installs. Restoring installs none of them. */
        pluginInstalls: z.array(BackupPluginInstallSchema).optional(),
        /** The backup carries a plugin list but `includePlugins` is off, so it is skipped. */
        pluginListSkipped: z.boolean().optional(),
        /** What this build could not read of the plugin list (the list or a row); the rest still shows. */
        pluginListWarnings: z.array(z.string()).optional(),
        /** Backed-up files left untouched because their local path is a symlink. */
        symlinkSkipped: z.array(z.string()).optional(),
        /**
         * Why the push half could not be computed, if it could not. The restore half is
         * still reported so a local export problem never blocks reviewing or approving
         * what a restore would bring in.
         */
        pushError: z.string().nullable(),
      })
    ),
  },
  push: {
    input: SettingsBackupInputSchema.extend({
      approvedSecretDigest: z.string().nullish(),
      approvedPluginRemovalDigest: z.string().nullish(),
    }),
    output: BackupResult(
      z.object({
        commit: z.string(),
        changed: z.boolean(),
        credential: BackupCredentialKindSchema,
        redactions: z.array(z.string()),
        shelfSkipped: z.array(z.string()).optional(),
      })
    ),
  },
  restore: {
    input: SettingsBackupInputSchema.extend({
      approvedCommandTokens: z.array(z.string()).nullish(),
      /**
       * Approved project imports: each token from a previewed candidate plus the local
       * directory to register the project at. Unknown or stale tokens abort the restore
       * with PROJECT_IMPORT_APPROVAL_REQUIRED before anything is written.
       */
      projectImports: z.array(z.object({ token: z.string(), targetPath: z.string() })).nullish(),
    }),
    output: BackupResult(
      z.object({
        commit: z.string(),
        snapshotPath: z.string(),
        changedFiles: z.array(z.string()),
        localOnlyFiles: z.array(z.string()),
        projectImportResults: z.array(BackupProjectImportResultSchema),
        /** The backup carries a project bundle but `includeProjects` is off, so it is skipped. */
        projectBundleSkipped: z.boolean(),
        shelfSkipped: z.array(z.string()).optional(),
        /** The backup's plugin list against this machine's installs, for the reinstall offer. */
        pluginInstalls: z.array(BackupPluginInstallSchema).optional(),
        pluginListSkipped: z.boolean().optional(),
        pluginListWarnings: z.array(z.string()).optional(),
        /** Backed-up files left untouched because their local path is a symlink. */
        symlinkSkipped: z.array(z.string()).optional(),
        /**
         * Candidates left unimported for lack of approval (no preview, or unchecked). Fresh
         * tokens, so the UI can offer them for approval right away.
         */
        unapprovedProjectImports: z.array(BackupProjectImportSchema),
      })
    ),
  },
};

export type { SettingsBackupInput } from "@/common/config/schemas/settingsBackup";
export type BackupOperationError = z.infer<typeof BackupOperationErrorSchema>;
export type BackupFileChange = z.infer<typeof BackupFileChangeSchema>;
export type BackupCommandApproval = z.infer<typeof BackupCommandApprovalSchema>;
export type BackupCredentialKind = z.infer<typeof BackupCredentialKindSchema>;
export type BackupProjectImport = z.infer<typeof BackupProjectImportSchema>;
export type BackupProjectImportResult = z.infer<typeof BackupProjectImportResultSchema>;
export type BackupPluginEntry = z.infer<typeof BackupPluginEntrySchema>;
export type BackupPluginManifest = z.infer<typeof BackupPluginManifestSchema>;
export type BackupPluginInstall = z.infer<typeof BackupPluginInstallSchema>;
export type BackupPluginRemoval = z.infer<typeof BackupPluginRemovalSchema>;
