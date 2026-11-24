import { z } from "zod";
import {
  hasUrlCredentials,
  isValidBackupBranch,
  SettingsBackupInputSchema,
  SettingsBackupSchema,
  UNSAFE_URL_CHARACTERS,
} from "@/common/config/schemas/settingsBackup";
import {
  AgentPluginGitSourceSchema,
  AgentPluginInstallEntrySchema,
} from "@/common/config/schemas/agentPluginInstalls";
import {
  hasEscapedUnreservedCharacter,
  isAbbreviatedCommitSha,
  isNormalizedAgentPluginSubpath,
  pointsAtThisMachine,
} from "@/common/utils/agentPluginSource";
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
 * A full commit id in lowercase. `isFullCommitSha` (src/node/services/agentPlugins/sourceInput.ts)
 * also takes uppercase, but common code cannot import it. The install status and the pinned-commit
 * check compare ids as exact strings, and git prints lowercase, so a row with an uppercase id is
 * refused here rather than normalized.
 */
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Cap on the plugins one backup list names: it is repository-controlled, and a restore shows every row. */
export const MAX_BACKUP_PLUGIN_ENTRIES = 512;

/** Caps on what one row names, for the same reason: skills and MCP servers, and each name. */
export const MAX_BACKUP_PLUGIN_COMPONENTS = 512;
const MAX_BACKUP_PLUGIN_COMPONENT_NAME_CHARS = 256;

const BackupPluginComponentNamesSchema = z
  .array(z.string().min(1).max(MAX_BACKUP_PLUGIN_COMPONENT_NAME_CHARS))
  .max(MAX_BACKUP_PLUGIN_COMPONENTS);

/**
 * A repository URL a restore hands to git. The list is repository-controlled, so the URL must not
 * read as a git option (a leading dash, or whitespace before it, since the preview trims its
 * input), or carry whitespace, control or bidi characters or a credential. It must also not point
 * at this machine: the export leaves out every such source with this same check
 * (agentPluginBackup.ts), so only a tampered list carries one, and on Windows a path, a `file:`
 * URL or a UNC or NT-namespace spelling of one can make the preview's fetch open SMB, which can
 * send the user's credentials before any consent.
 */
const BackupPluginUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s-]/, { message: "A repository URL must not start with '-' or whitespace" })
  .refine((url) => !pointsAtThisMachine(url), {
    message: "A repository URL must not be a path, a file: URL or a host on this machine",
  })
  .refine((url) => !UNSAFE_URL_CHARACTERS.test(url), {
    message: "A repository URL must not contain whitespace or control characters",
  })
  .refine((url) => !hasUrlCredentials(url), {
    message: "A repository URL must not carry a credential",
  })
  // The publish-time secret scan reads the list as written: a token spelled with escapes would
  // pass it. The export leaves such a plugin out with the same predicate (agentPluginBackup.ts).
  .refine((url) => !hasEscapedUnreservedCharacter(url), {
    message: "A repository URL must not escape a letter, a digit or one of - . _ ~",
  });

/**
 * The branch or tag a plugin tracks, which the install review writes back into the installed
 * source. The installer has no syntax rule of its own for a ref: it takes any text, refuses an
 * abbreviated commit id (`resolveRemoteRef`), and asks git for `refs/heads/<ref>` and
 * `refs/tags/<ref>`, so a remote can hold (and Xum installs from) a branch `HEAD`, `refs/team` or
 * `-x`. The list takes the same refs. It refuses only what a remote can never hold, a name that
 * `git check-ref-format` refuses (`a..b`, `x.lock`, `main~1`: the install review would persist it,
 * and every later update check of the plugin would fail), and a ref with whitespace, a control
 * character or a format character such as a bidi mark, which the card shows and which can make
 * one ref read as another. The export leaves such a plugin out and logs it (agentPluginBackup.ts).
 */
const BackupPluginRefSchema = z
  .string()
  .min(1)
  .max(256)
  // The `x/` folder takes the rules of a branch name that do not apply to a ref (`HEAD`, a leading
  // `refs/` or `-`) out of the check: the rest are the rules of any ref name, in `refs/heads/<ref>`.
  .refine((ref) => isValidBackupBranch(`x/${ref}`), {
    message: "A plugin ref must be a name git can hold",
  })
  .refine((ref) => !UNSAFE_URL_CHARACTERS.test(ref), {
    message: "A plugin ref must not contain whitespace, control or format characters",
  })
  .refine((ref) => !isAbbreviatedCommitSha(ref), {
    message: "A plugin ref must not be an abbreviated commit id",
  });

/**
 * The folder of a monorepo plugin, in the form the installer takes (`normalizeAgentPluginSubpath`).
 * A row with another form (`/a`, `../a`, `a//b`, `.git`) would be offered for review and then
 * refused by the preview, and a registry row in that form would back up into a list nobody can use.
 */
const BackupPluginSubpathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isNormalizedAgentPluginSubpath, {
    message: "A plugin subpath must be a folder path inside the repository, like path/to/plugin",
  });

/**
 * One managed Agent Plugin as the backup records it: where it came from and which commit it was
 * pinned to. Only what is needed to offer the install again. Consent, hook trust, approved copies,
 * enabled servers and timestamps are local facts and never travel (the parse drops them): another
 * machine's review is the only thing that can approve a plugin there. The install method does not
 * travel either, so the repository cannot choose how a restore installs a plugin: a list that
 * names one still reads, and the parse drops it. Every field has a cap, because the list is
 * repository-controlled.
 */
export const BackupPluginEntrySchema = z.object({
  name: AgentPluginInstallEntrySchema.shape.name,
  source: AgentPluginGitSourceSchema.extend({
    url: BackupPluginUrlSchema,
    ref: BackupPluginRefSchema,
    subpath: BackupPluginSubpathSchema.optional(),
  }),
  /** Full commit id: a restore previews this exact commit, whatever `source.ref` tracks now. */
  lockedSha: z.string().regex(FULL_COMMIT_SHA_PATTERN, { message: "Not a full commit id" }),
  importedComponents: z
    .object({
      skills: BackupPluginComponentNamesSchema,
      mcpServers: BackupPluginComponentNamesSchema,
    })
    .optional(),
});

/**
 * The `agent-plugins/manifest.json` sidecar of a backup. The reader (agentPluginBackup.ts) checks
 * the envelope and then each row on its own, so one row this build cannot read never hides the
 * others; there is no schema for the whole file.
 */
export interface BackupPluginManifest {
  schemaVersion: 1;
  plugins: BackupPluginEntry[];
}

/**
 * How a listed plugin compares with this machine's managed installs: `missing` (nothing by that
 * name), `installed` (that name at the same commit, repository and folder, with its folder),
 * `folderMissing` (the registry lists that plugin but its folder is gone: not offered, since an
 * install would collide with the row), `conflict` (that name is taken by another commit, another
 * repository or folder, or by a folder the installer does not manage).
 */
export const BackupPluginStatusSchema = z.enum([
  "missing",
  "installed",
  "folderMissing",
  "conflict",
]);

/** A listed plugin with its status. Restoring installs none of these rows. */
export const BackupPluginRowSchema = BackupPluginEntrySchema.extend({
  status: BackupPluginStatusSchema,
});

/** What a preview or restore reports of the backup's plugin list. */
export const BackupPluginReportSchema = z.object({
  /** The backup's listed plugins against this machine's installs. */
  rows: z.array(BackupPluginRowSchema),
  /** The backup carries a plugin list but `includePlugins` is off, so it is skipped. */
  skipped: z.boolean(),
  /** What this build could not read of the list (the list or a row); the rest still shows. */
  warnings: z.array(z.string()),
});

export const EMPTY_BACKUP_PLUGIN_REPORT: BackupPluginReport = {
  rows: [],
  skipped: false,
  warnings: [],
};

/**
 * What a push removes from the backup's plugin list: the listed plugins this machine's export
 * leaves out, `wholeList` when the backup has a list and the push writes none, and `unreadable`
 * when the list has parts this build could not read (a newer Xum's rows), which a push that
 * writes a list replaces without being able to name them. The push refuses until it carries the
 * `approval` of exactly this removal: a different removal asks again.
 */
export const BackupPluginRemovalSchema = z.object({
  names: z.array(z.string()),
  wholeList: z.boolean(),
  unreadable: z.boolean(),
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
        plugins: BackupPluginReportSchema,
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
        plugins: BackupPluginReportSchema,
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
export type BackupPluginStatus = z.infer<typeof BackupPluginStatusSchema>;
export type BackupPluginRow = z.infer<typeof BackupPluginRowSchema>;
export type BackupPluginReport = z.infer<typeof BackupPluginReportSchema>;
export type BackupPluginRemoval = z.infer<typeof BackupPluginRemovalSchema>;
