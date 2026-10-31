import { z } from "zod";

import {
  AgentPluginGitSourceSchema,
  AgentPluginImportedComponentsSchema,
  AgentPluginInstallEntrySchema,
} from "@/common/config/schemas/agentPluginInstalls";

/**
 * oRPC shapes for the managed Agent Plugin installer (agent-plugins
 * experiment). Registry entry + source schemas are shared with the on-disk
 * config schema (single source of truth).
 */

export { AgentPluginGitSourceSchema, AgentPluginInstallEntrySchema };

/** How a Cursor rule applies in Cursor (cursorRules.ts); the review labels the rule skill by it. */
export const AgentPluginRuleTypeSchema = z.enum(["always-apply", "description", "glob", "manual"]);
export type AgentPluginRuleType = z.infer<typeof AgentPluginRuleTypeSchema>;

export const AgentPluginPreviewSkillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /**
   * Commands of the body's directive lines, invisible characters escaped (#6617). They run when
   * the user invokes the skill, so the review shows them. Absent when there are none.
   */
  directives: z.array(z.string()).optional(),
  /** Set only for a skill that Xum made from a Cursor rule file. */
  ruleType: AgentPluginRuleTypeSchema.optional(),
});

/** A part of a plugin that Xum lists but does not load or run (Cursor plugins, RFC Goal 7). */
export const AgentPluginNotAppliedSchema = z.object({
  part: z.enum(["field", "rule", "agent", "hook", "mcp", "command"]),
  name: z.string(),
  reason: z.string(),
});
export type AgentPluginNotApplied = z.infer<typeof AgentPluginNotAppliedSchema>;

export const AgentPluginPreviewMcpServerSchema = z.object({
  serverName: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  /** Human-readable command line (stdio) or URL (remote) shown in the consent preview. */
  summary: z.string(),
});

/** Offline full inventory of the locked installed tree, separate from its saved imports. */
export const AgentPluginComponentsSchema = z.object({
  lockedSha: z.string(),
  /** Full installed-tree content receipt; lockedSha alone does not detect local edits. */
  contentHash: z.string(),
  skills: z.array(AgentPluginPreviewSkillSchema),
  mcpServers: z.array(AgentPluginPreviewMcpServerSchema),
  importedComponents: AgentPluginImportedComponentsSchema.optional(),
});
export type AgentPluginComponents = z.infer<typeof AgentPluginComponentsSchema>;

/**
 * Executable hooks.js disclosure: hooks load automatically after install and
 * can observe/rewrite/block tool calls, so consent must surface them.
 */
export const AgentPluginPreviewHookSchema = z.object({
  /** Plugin-relative path to the hook entry file (e.g. "hooks.js"). */
  path: z.string(),
  /** Tool names the manifest requests visibility into (empty = least privilege, no tools). */
  toolGrants: z.array(z.string()),
});

/**
 * One plugin hook handler (hooks.json). Codex format: only `mcp_tool` can run; `command`, `prompt`
 * and `agent` are parsed and shown, never run. Cursor format: `cursor-command` runs a command on
 * the host (local and worktree workspaces only), `cursor-prompt` never runs.
 */
export const PluginHookHandlerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mcp_tool"),
    server: z.string(),
    tool: z.string(),
    /** Argument templates (`${tool_input.x}`); `{}` when omitted. */
    input: z.record(z.string(), z.unknown()),
    /** Declared `timeout` in seconds; absent means the runner default. */
    timeoutSeconds: z.number().optional(),
    statusMessage: z.string().optional(),
  }),
  z.object({ type: z.enum(["command", "prompt", "agent"]), summary: z.string() }),
  z.object({
    type: z.literal("cursor-command"),
    command: z.string(),
    /** Declared positive `timeout` in seconds; absent means the runner default. */
    timeoutSeconds: z.number().optional(),
    /** The declared `loop_limit`, at most 50 (the per-user-turn ceiling); null: no own limit. */
    loopLimit: z.number().int().nullable().optional(),
    failClosed: z.boolean().optional(),
    /**
     * The entry as declared, as the canonical JSON that the hook hash covers (clamped values and
     * unknown fields included), so the review shows every field the user trusts.
     */
    declared: z.string(),
  }),
  z.object({ type: z.literal("cursor-prompt"), declared: z.string() }),
]);

/**
 * `runnable`: an mcp_tool handler on a mapped Codex event, or a `cursor-command` handler on a mapped
 * Cursor event without a matcher. `unsupported-handler`: a Codex command, prompt or agent handler,
 * or a Cursor prompt hook. `ignored-event`: an event Xum does not map, or a Cursor hook with a
 * matcher. `claude-plugin`: any hook of a Claude Code plugin (Xum lists them and never runs them).
 */
export const PluginHookStatusSchema = z.enum([
  "runnable",
  "unsupported-handler",
  "ignored-event",
  "claude-plugin",
]);

/**
 * Trust review state, keyed by the hook's location and checked against its hash (Codex trust):
 * `new` and `changed` hooks never run until the user trusts them; `disabled` is turned off.
 */
export const PluginHookReviewStateSchema = z.enum(["trusted", "disabled", "new", "changed"]);

export const AgentPluginHookSchema = z.object({
  /** Stable location (file, event, group, handler index): the trust record's key. */
  key: z.string(),
  /** sha256 of the canonical definition; trust applies only to this exact hash. */
  hash: z.string(),
  event: z.string(),
  matcher: z.string().optional(),
  handler: PluginHookHandlerSchema,
  status: PluginHookStatusSchema,
  /** Where it was declared, e.g. `hooks/hooks.json` or `plugin.json#hooks[0]`. */
  source: z.string(),
  review: PluginHookReviewStateSchema,
});

/** Composer slash command declared by the manifest (data-driven expansion). */
export const AgentPluginPreviewSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

/**
 * OpenAI `interface` presentation metadata (validated in openaiExtension.ts).
 * Plain text: render as React text, never as HTML or markdown.
 */
export const AgentPluginInterfaceSummarySchema = z.object({
  displayName: z.string(),
  developerName: z.string(),
  shortDescription: z.string(),
  capabilities: z.array(z.string()).optional(),
  /** https only. */
  websiteURL: z.string().optional(),
  privacyPolicyURL: z.string().optional(),
  termsOfServiceURL: z.string().optional(),
  supportURL: z.string().optional(),
  /** `data:image/...;base64,` read through the contained capped reader; never a path. */
  logoDataUrl: z.string().optional(),
  /** Dark-theme variant (OpenAI `logoDark`/`composerIconDark`), read the same way. */
  logoDarkDataUrl: z.string().optional(),
});
export type AgentPluginInterfaceSummary = z.infer<typeof AgentPluginInterfaceSummarySchema>;

/** Manifest metadata surfaced in the consent preview (UI-safe projection of plugin.json). */
export const AgentPluginManifestSummarySchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  authorName: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  interface: AgentPluginInterfaceSummarySchema.optional(),
});

/**
 * Everything a user consents to before anything is written: the resolved
 * source + SHA, the manifest, every skill, and every MCP server command line.
 */
/** The component kinds with consent records (#6498, #6629). */
export const AgentPluginComponentKindSchema = z.enum([
  "skills",
  "mcpServers",
  "workflows",
  "agents",
  "slashCommands",
]);

/**
 * How Xum reads a repository as a managed plugin. Preview lists every method that fits, in this
 * order, and install must use the method the user previewed. Each member is an object so a method
 * can carry its own fields (a later Claude marketplace method names its entry).
 */
export const AgentPluginInstallMethodSchema = z.discriminatedUnion("kind", [
  /** plugin.json, or .codex-plugin/plugin.json. */
  z.object({ kind: z.literal("agent-plugin") }),
  /** .claude-plugin/plugin.json. */
  z.object({ kind: z.literal("claude-plugin") }),
  /** .cursor-plugin/plugin.json. */
  z.object({ kind: z.literal("cursor-plugin") }),
  /** SKILL.md folders only: Xum writes a plugin.json for them (installMethods.ts). */
  z.object({ kind: z.literal("skills") }),
  /**
   * One entry of a Claude Code marketplace (`.claude-plugin/marketplace.json` at the repository
   * root). A preview with it resolves the entry; install gets it back only when the entry has no
   * plugin.json of its own and Xum writes one from the entry (claudeMarketplace.ts).
   */
  z.object({ kind: z.literal("claude-marketplace"), entry: z.string().min(1) }),
  /**
   * One entry of a Cursor marketplace (`.cursor-plugin/marketplace.json`). A preview selector
   * only: the entry installs through its folder's own manifest, so install never gets it back.
   * No install record stores a method (agentPluginInstalls.ts).
   */
  z.object({ kind: z.literal("cursor-marketplace"), entry: z.string().min(1) }),
]);
export type AgentPluginInstallMethod = z.infer<typeof AgentPluginInstallMethodSchema>;

/**
 * One consent-relevant difference between the installed tree and a staged
 * update (see installService capabilitySurface). `before`/`after` carry the
 * human-readable value on each side so the user can judge the change instead
 * of only being told that something changed; additions have no `before`.
 */
/**
 * One imported skill or MCP server at the consent fingerprint a review showed (#6498). The
 * renderer sends the shown refs back on confirm, and the backend records only refs that still
 * match, so a component that changed after the review never gets consent.
 */
export const AgentPluginComponentRefSchema = z.object({
  kind: AgentPluginComponentKindSchema,
  name: z.string(),
  fingerprint: z.string(),
});

export const AgentPluginCapabilityChangeSchema = z.object({
  summary: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  /** Set for a skill or MCP server change: what confirming the review approves. */
  component: AgentPluginComponentRefSchema.optional(),
});

export const AgentPluginHooksSchema = z.object({
  hooks: z.array(AgentPluginHookSchema),
  warnings: z.array(z.string()),
  /**
   * D30 at the first trust: every file of the plugin, as the install preview lists them. Set
   * while the plugin runs a Cursor command hook and none of its Cursor hooks is trusted: a plugin
   * installed by a build without the file review never showed its files. Trusting a Cursor
   * command hook then needs `digest`, so the trust covers exactly the files shown.
   */
  fileReview: z
    .object({ changes: z.array(AgentPluginCapabilityChangeSchema), digest: z.string() })
    .optional(),
});

export const AgentPluginInstallPreviewSchema = z.object({
  source: AgentPluginGitSourceSchema,
  /** The method this preview used. Install gets it back. */
  method: AgentPluginInstallMethodSchema,
  /** Every method that fits the repository, in order: agent-plugin, claude-plugin, skills. */
  methods: z.array(AgentPluginInstallMethodSchema),
  /**
   * Skill folder names found with the skills CLI rules, for the "Skills CLI" choice (empty when
   * the repository has no SKILL.md files). Independent of `method`.
   */
  skillsCliSkills: z.array(z.string()),
  /**
   * Why Install refuses this method: a plugin or folder of the same name exists. The preview
   * still lists every method and the Skills CLI choice (it creates no managed plugin).
   */
  installBlockedReason: z.string().optional(),
  /** Commit SHA the preview was computed from; install verifies it gets the same tree. */
  lockedSha: z.string(),
  manifest: AgentPluginManifestSummarySchema,
  skills: z.array(AgentPluginPreviewSkillSchema),
  mcpServers: z.array(AgentPluginPreviewMcpServerSchema),
  /** Present when the plugin ships an executable hooks.js (absent = no hooks). */
  hook: AgentPluginPreviewHookSchema.optional(),
  /**
   * Codex-format hooks (hooks.json). Install trusts none of them: each runs only after the user
   * trusts it in Settings (Codex trust per hash).
   */
  codexHooks: z.array(AgentPluginHookSchema.omit({ review: true })),
  /**
   * The first file review (Cursor plugin RFC D30): one added row per file of a plugin with a
   * runnable Cursor command hook, because such a hook can run any file of the plugin. Empty for
   * every other plugin.
   */
  fileChanges: z.array(AgentPluginCapabilityChangeSchema),
  /** Agent definition files (agents/*.md) that become selectable agents. */
  agents: z.array(z.string()),
  /**
   * The files of `agents` with Cursor `readonly: true`: they run on Explore's tools, so the
   * review says file edits are removed and the shell stays.
   */
  readonlyAgents: z.array(z.string()),
  /** Executable workflow scripts (workflows/*.js) invokable after install. */
  workflows: z.array(z.string()),
  /** Composer slash commands the manifest contributes. */
  slashCommands: z.array(AgentPluginPreviewSlashCommandSchema),
  /**
   * The reviewed fields of each component that install records consent for besides skills and MCP
   * servers (#6629), so the preview shows everything the record approves.
   */
  reviewedComponents: z.array(
    z.object({
      kind: AgentPluginComponentKindSchema,
      /** Display form: invisible and bidi controls shown as `<U+XXXX>`, never an identity. */
      name: z.string(),
      detail: z.string(),
    })
  ),
  /** Manifest warnings + component diagnostics from validating the staged clone. */
  warnings: z.array(z.string()),
  /** The parts of the staged plugin that Xum lists but does not apply. */
  notApplied: z.array(AgentPluginNotAppliedSchema),
  /** Final install directory (~/.mux/plugins/<name>). */
  targetPath: z.string(),
  /**
   * Digest of every component fingerprint this preview showed (#6777). Install gets it back and
   * refuses when its own clone reads different components.
   */
  consentDigest: z.string(),
});

/**
 * One marketplace file's entry for a listing row. A row's builds keep their own status, so a
 * broken entry in one file never disables or enables the other file's build.
 */
export const AgentPluginMarketplaceBuildSchema = z.object({
  /** The marketplace file that lists the entry. */
  file: z.enum(["cursor", "claude"]),
  /** The entry `source` kind; "relative" is a folder of the marketplace repository. */
  sourceKind: z.enum([
    "relative",
    "github",
    "git-subdir",
    "url",
    "npm",
    "archive",
    "command",
    "unknown",
  ]),
  /** Display form of the source: a folder ("./" for the root) or a repository URL. */
  source: z.string(),
  /**
   * Absent when the entry lists no `skills` paths. For an entry in the marketplace repository,
   * the skills its preview accepts; for an entry in another repository, the number of paths.
   */
  skillCount: z.number().int().nonnegative().optional(),
  installable: z.boolean(),
  /** Why the entry cannot install (present exactly when `installable` is false). */
  reason: z.string().optional(),
});

/**
 * One plugin name of a marketplace listing. A repository with both marketplace files lists a
 * name once; a name in both files has two builds, Cursor first.
 */
export const AgentPluginMarketplaceEntrySchema = z.object({
  name: z.string(),
  /** The first build's description. */
  description: z.string().optional(),
  builds: z.array(AgentPluginMarketplaceBuildSchema).min(1),
});

/** A repository whose only package is a marketplace: the user picks one entry. */
export const AgentPluginMarketplaceListingSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  owner: z.string().optional(),
  /** The marketplace repository, resolved like a plugin source. */
  source: AgentPluginGitSourceSchema,
  lockedSha: z.string(),
  entries: z.array(AgentPluginMarketplaceEntrySchema),
  /**
   * Other methods that fit the repository root (Skills when it has SKILL.md files), so the user
   * can install the whole repository instead of one entry.
   */
  methods: z.array(AgentPluginInstallMethodSchema),
  warnings: z.array(z.string()),
});

/** What a preview found: a plugin to review, or a marketplace to pick an entry from. */
export const AgentPluginSourcePreviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plugin"), preview: AgentPluginInstallPreviewSchema }),
  z.object({ kind: z.literal("marketplace"), marketplace: AgentPluginMarketplaceListingSchema }),
]);

export const AgentPluginListItemSchema = z.object({
  name: z.string(),
  /** True when a registry entry exists; unmanaged dirs found by discovery are read-only. */
  managed: z.boolean(),
  /** False for managed entries whose directory vanished (registry self-heal display). */
  present: z.boolean(),
  /** Display location, e.g. "~/.mux/plugins/demo". */
  location: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  source: AgentPluginGitSourceSchema.optional(),
  lockedSha: z.string().optional(),
  installedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  importedComponents: AgentPluginImportedComponentsSchema.optional(),
  importedSkillCount: z.number().int().nonnegative().optional(),
  importedMcpServerCount: z.number().int().nonnegative().optional(),
  /**
   * Managed rows: imported skills and MCP servers whose current fingerprint the user has not
   * reviewed (#6498). They do not load until a component review confirms them.
   */
  reviewRequiredCount: z.number().int().nonnegative().optional(),
  interface: AgentPluginInterfaceSummarySchema.optional(),
  /** Available counts include components not yet imported. */
  skillCount: z.number().int().nonnegative(),
  mcpServerCount: z.number().int().nonnegative(),
  /** The installed plugin's not-applied parts; absent when there are none or the folder is gone. */
  notApplied: z.array(AgentPluginNotAppliedSchema).optional(),
});

/**
 * The pending plugin sign-out record (#6122): sign-outs that an update could not finish. While
 * it exists, every discovery gate keeps managed plugins closed. `broken`: the record is corrupt,
 * from another version, or unreadable, and only the user can clear it.
 */
export const AgentPluginPendingSignOutsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("pending"),
    /** Credential URLs still to sign out, for display: without query, fragment or user info. */
    servers: z.array(z.string()),
    /** Why the last attempt left them, when one ran in this process. */
    lastError: z.string().optional(),
  }),
  z.object({ kind: z.literal("broken"), reason: z.string() }),
]);

export const AgentPluginUpdateCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["up-to-date", "update-available", "tag-moved", "pinned", "error"]),
  /** Remote tip SHA for update-available / tag-moved. */
  remoteSha: z.string().optional(),
  /** Error detail when status is "error". */
  message: z.string().optional(),
});

/** Ties an update confirmation to the exact trees the user reviewed. */
export const AgentPluginUpdateConsentSchema = z.object({
  /** lockedSha of the install the review compared against. */
  fromSha: z.string(),
  /** Commit the review staged; update installs exactly this commit. */
  toSha: z.string(),
  /**
   * The component changes the review showed. Only these get consent records. Without it, every
   * changed component needs a component review after the update (fails closed).
   */
  reviewed: z.array(AgentPluginComponentRefSchema).optional(),
});

/**
 * Update review: what applying the pending update would change in the
 * plugin's capability surface. Empty `changes` means the update applies
 * without re-consent.
 */
export const AgentPluginUpdateReviewSchema = z.object({
  name: z.string(),
  fromSha: z.string(),
  toSha: z.string(),
  /** Staged manifest version, when declared. */
  version: z.string().optional(),
  changes: z.array(AgentPluginCapabilityChangeSchema),
  /** Manifest warnings + component diagnostics from validating the staged clone. */
  warnings: z.array(z.string()),
  /**
   * The staged plugin's not-applied parts; absent when there are none, or when the review stages
   * no plugin (no new commit, or a component review).
   */
  notApplied: z.array(AgentPluginNotAppliedSchema).optional(),
});

export type AgentPluginCapabilityChange = z.infer<typeof AgentPluginCapabilityChangeSchema>;
export type AgentPluginComponentRef = z.infer<typeof AgentPluginComponentRefSchema>;
export type AgentPluginUpdateConsent = z.infer<typeof AgentPluginUpdateConsentSchema>;
export type AgentPluginUpdateReview = z.infer<typeof AgentPluginUpdateReviewSchema>;
export type AgentPluginPreviewSkill = z.infer<typeof AgentPluginPreviewSkillSchema>;
export type AgentPluginPreviewMcpServer = z.infer<typeof AgentPluginPreviewMcpServerSchema>;
export type AgentPluginPreviewHook = z.infer<typeof AgentPluginPreviewHookSchema>;
export type PluginHookHandler = z.infer<typeof PluginHookHandlerSchema>;
export type PluginHookStatus = z.infer<typeof PluginHookStatusSchema>;
export type PluginHookReviewState = z.infer<typeof PluginHookReviewStateSchema>;
export type AgentPluginHook = z.infer<typeof AgentPluginHookSchema>;
export type AgentPluginHooks = z.infer<typeof AgentPluginHooksSchema>;
export type AgentPluginManifestSummary = z.infer<typeof AgentPluginManifestSummarySchema>;
export type AgentPluginInstallPreview = z.infer<typeof AgentPluginInstallPreviewSchema>;
export type AgentPluginMarketplaceBuild = z.infer<typeof AgentPluginMarketplaceBuildSchema>;
export type AgentPluginMarketplaceEntry = z.infer<typeof AgentPluginMarketplaceEntrySchema>;
export type AgentPluginMarketplaceListing = z.infer<typeof AgentPluginMarketplaceListingSchema>;
export type AgentPluginSourcePreview = z.infer<typeof AgentPluginSourcePreviewSchema>;
export type AgentPluginListItem = z.infer<typeof AgentPluginListItemSchema>;
export type AgentPluginPendingSignOuts = z.infer<typeof AgentPluginPendingSignOutsSchema>;
export type AgentPluginUpdateCheck = z.infer<typeof AgentPluginUpdateCheckSchema>;

/**
 * Agent Plugins (agent-plugins.org) oRPC schemas: manifest-contributed slash
 * commands and the per-workspace composition inspector payload.
 */

/** Slash command contributed by an Agent Plugin manifest (`contributes.slashCommands`). */
export const PluginSlashCommandDescriptorSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().optional(),
  /** Replacement text inserted into the composer when the command is invoked. */
  expansion: z.string().min(1),
  pluginName: z.string().min(1),
  scope: z.enum(["project", "global"]),
});
export type PluginSlashCommandDescriptor = z.infer<typeof PluginSlashCommandDescriptorSchema>;

/** One artifact row in the workspace composition (effective or shadowed). */
export const WorkspaceCompositionEntrySchema = z.object({
  name: z.string().min(1),
  /** Layer providing the artifact: built-in | global | project | plugin:<name>. */
  source: z.string().min(1),
  description: z.string().optional(),
  /** Source label of the higher-precedence entry overriding this one (absent = effective). */
  shadowedBy: z.string().optional(),
});
export type WorkspaceCompositionEntry = z.infer<typeof WorkspaceCompositionEntrySchema>;

export const WorkspaceCompositionPluginSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["project", "global"]),
  rootPath: z.string().min(1),
  version: z.string().optional(),
  /** Component kinds the plugin contributes (skills, mcp, agents, workflows, hooks, slashCommands). */
  components: z.array(z.string()),
});
export type WorkspaceCompositionPlugin = z.infer<typeof WorkspaceCompositionPluginSchema>;

export const WorkspaceCompositionDiagnosticSchema = z.object({
  path: z.string(),
  scope: z.enum(["project", "global"]),
  severity: z.enum(["warning", "error"]),
  message: z.string(),
});

/**
 * Effective per-workspace composition by artifact kind — the `--dump-config`
 * analog. One bulk structure so the inspector needs a single oRPC call.
 */
export const WorkspaceCompositionSchema = z.object({
  plugins: z.array(WorkspaceCompositionPluginSchema),
  diagnostics: z.array(WorkspaceCompositionDiagnosticSchema),
  skills: z.array(WorkspaceCompositionEntrySchema),
  agents: z.array(WorkspaceCompositionEntrySchema),
  workflows: z.array(WorkspaceCompositionEntrySchema),
  mcpServers: z.array(WorkspaceCompositionEntrySchema),
  slashCommands: z.array(WorkspaceCompositionEntrySchema),
  hooks: z.array(WorkspaceCompositionEntrySchema),
});
export type WorkspaceComposition = z.infer<typeof WorkspaceCompositionSchema>;
