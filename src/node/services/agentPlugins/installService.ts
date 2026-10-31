import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import writeFileAtomic from "@/node/utils/writeFileAtomic";

import {
  AgentPluginInstallEntrySchema,
  AgentPluginComponentConsentSchema,
  AgentPluginImportedComponentsSchema,
  type AgentPluginImportedComponents,
  type AgentPluginGitSource,
  type AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import { isValidAgentPluginName } from "@/common/utils/agentPluginName";
import { getOwn } from "@/common/utils/getOwn";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
  AgentPluginMarketplaceEntry,
  AgentPluginMarketplaceListing,
  AgentPluginSourcePreview,
  AgentPluginComponents,
  AgentPluginHooks,
  AgentPluginInterfaceSummary,
  AgentPluginListItem,
  AgentPluginPendingSignOuts,
  AgentPluginManifestSummary,
  AgentPluginPreviewHook,
  AgentPluginPreviewMcpServer,
  AgentPluginPreviewSkill,
  AgentPluginUpdateCheck,
  AgentPluginCapabilityChange,
  AgentPluginComponentRef,
  AgentPluginUpdateConsent,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import { resolvePluginHookGrants } from "@/node/services/agentPlugins/hookSandbox";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { showInvisibleControls, showOneLineControls } from "@/common/utils/agentPluginReviewText";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";
import type { Config } from "@/node/config";
import {
  SkillNameSchema,
  resolveSkillAdvertise,
  resolveSkillWhenToUse,
} from "@/common/orpc/schemas/agentSkill";
import { resolveSkillPaths } from "@/common/utils/skills/skillPaths";
import {
  parseSkillMarkdown,
  skillConsentFrontmatter,
} from "@/node/services/agentSkills/parseSkillMarkdown";
import { log } from "@/node/services/log";
import type { MCPServerInfo, MCPServerOAuthConfig, MCPStdioServerInfo } from "@/common/types/mcp";
import type { McpOauthService } from "@/node/services/mcpOauthService";
import {
  pluginClientSecretFor,
  readPluginClientSecrets,
  type PluginClientSecret,
} from "./openaiMcpAuth";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import {
  ALL_WORKSPACES_TARGET,
  type WorkspaceMcpOverridesService,
} from "@/node/services/workspaceMcpOverridesService";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { AsyncSemaphore } from "@/node/utils/concurrency/asyncSemaphore";
import { shellQuote } from "@/common/utils/shell";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  readPluginFileWithinRootCapped,
  discoverAgentPluginAt,
  discoverAgentPlugins,
  ensurePluginPathContained,
  journalDerivedDiscoveryGate,
  PluginGitPathError,
  setAgentPluginDiscoveryGate,
  type AgentPluginContainer,
  type AgentPluginDiagnostic,
  type AgentPluginInfo,
  listPluginSkillFolders,
  resolveDeclaredSkillsRoots,
  type PluginSkillsRoot,
} from "./discovery";
import { listPluginSkillScripts, listPluginWorkflowFiles } from "./workflowFiles";
import {
  chooseStagedMethod,
  detectInstallMethods,
  generatesManifest,
  methodLabel,
  installMethodRequest,
  marketplaceManifest,
  readInstalledGeneratedFrom,
  relativeEntryContext,
  writeGeneratedManifest,
  type InstallMethodRequest,
  type MarketplaceEntryContext,
  type SkillsPackageRoot,
} from "./installMethods";
import {
  CLAUDE_MARKETPLACE_RELATIVE_PATH,
  MAX_CLAUDE_MARKETPLACE_BYTES,
  findMarketplaceEntry,
  marketplaceListing,
  parseClaudeMarketplace,
  resolveEntrySource,
  type ClaudeMarketplace,
} from "./claudeMarketplace";
import { pluginSkillMarkdown } from "./claudeCommands";
import { listPluginAgentFiles, type PluginAgentFile } from "./agentFiles";
import { checkLogoImage } from "./imageHeader";
import {
  consentForSelection,
  countUnreviewed,
  isComponentConsented,
  recordReviewedComponents,
  isImportedComponent,
  agentConsentDetail,
  agentConsentFingerprint,
  slashCommandConsentDetail,
  slashCommandConsentFingerprint,
  workflowConsentDetail,
  workflowConsentFingerprint,
  serverConsentDetail,
  serverConsentFingerprint,
  skillConsentDetail,
  skillConsentFingerprint,
  skillReviewDirectives,
  directivesField,
  componentConsentDigest,
  type ComponentConsent,
} from "./componentConsent";
import type { OpenAIPluginInterface } from "./openaiExtension";
import {
  acquirePluginMutationLock,
  bumpContainerMutationEpoch,
  MUTATION_LOCK_FILE,
  containerHasPendingSignOuts,
  pendingSignOutsRecordState,
  isJournalName,
  JOURNAL_PREFIXES,
  MUTATION_EPOCH_FILE,
  PENDING_SIGN_OUTS_FILE_NAME,
  PROMOTION_JOURNAL_PREFIX,
  STAGING_DIR_NAME,
  UNINSTALL_JOURNAL_PREFIX,
  UPDATE_JOURNAL_PREFIX,
} from "./journals";
import { PLUGIN_REGISTRY_FILE_NAME, readPluginRegistryDocument } from "./registry";
import { isPlainObject, type AgentPluginManifest } from "./manifest";
import { hashPluginTree, listPluginTreeRecords, type PluginTreeRecord } from "./treeHash";
import {
  buildPluginServerKey,
  computePluginInstanceId,
  getPluginDataPath,
  isCanonicalPluginServerKeyPrefix,
  loadPluginMcpServers,
} from "./mcpConfig";
import { loadPluginHooks, type PluginHookDefinition } from "./codexHooks";
import {
  readPluginHookTrust,
  removePluginHookTrust,
  reviewStateOf,
  setPluginHookTrust,
  type PluginHookTrustState,
} from "./pluginHookTrust";
import {
  approvedCopiesOutdated,
  noApprovedCopies,
  readApprovedCopies,
  removeApprovedCopies,
  updateApprovedCopies,
  verifiedApprovedCopies,
  type ApprovedCopies,
  type ApprovedCopiesSource,
  type ApprovedCopiesSweep,
  type VerifiedApprovedCopies,
} from "./approvedCopies";
import {
  assertNoAgentPluginUrlCredentials,
  isFullCommitSha,
  normalizeAgentPluginSubpath,
  parseAgentPluginSourceInput,
} from "./sourceInput";

/**
 * Managed Agent Plugin installer (global scope only).
 *
 * Flow: parse input → shallow clone to a staging dir under ~/.mux →
 * validate the STAGED clone with the same manifest/component discovery used
 * at runtime → return a consent preview → on confirm, re-clone the exact SHA,
 * promote into ~/.mux/plugins/<name>, and record a registry entry
 * ({source, ref, lockedSha}) in ~/.mux/plugins.json.
 *
 * The registry is a standalone file (NOT a config.json section): older builds
 * rebuild config.json from known fields on save, so a downgrade would drop an
 * embedded registry — and owning the file lets writes THROW on failure so
 * install/update/uninstall can roll back instead of silently succeeding with
 * an unpersisted registry.
 *
 * Invariants:
 * - The installer NEVER writes into a project checkout (v1 is global-only).
 * - `lockedSha` is what runs; branches are only a tracking channel for the
 *   update badge. Nothing auto-applies.
 * - Update = temp clone + wholesale directory swap (rename-old → promote-new
 *   → delete-old), never in-place `git pull` — local edits to a managed
 *   plugin dir are discarded on update.
 * - Applying an update or uninstalling recycles that plugin's running MCP
 *   servers: content can change behind an unchanged stdio command line, so
 *   the config-signature check cannot notice (correctness, not polish).
 * - Failure paths must leave no partial state: staging dirs are cleaned up,
 *   and promote + registry-write failures roll back.
 */

/*
 * Journal semantics (prefixes and helpers live in ./journals so discovery can
 * derive suppression without an import cycle):
 * - PROMOTION: an install renamed the staged tree into the container but has
 *   not yet written its registry entry. A crash in that window would strand
 *   an orphaned tree that discovery lists as unmanaged, assertNoCollision
 *   blocks, and uninstall refuses — recoverable only by manual deletion.
 * - UPDATE: the OLD live tree moved into staging but the staged replacement
 *   is not yet promoted. The registry then records an install whose path is
 *   missing, and retrying Update cannot self-heal because
 *   assertNoCapabilityIncrease treats the missing tree as an empty surface.
 * - UNINSTALL: the plugin tree (and optionally its data dir) is staged into
 *   trash but the registry write has not committed; the assets would hide
 *   under plugin-staging while the registry still owns the plugin.
 * reconcileJournals resolves all three on startup and on section open.
 */

/**
 * Marker file written into a staged tree just before a promote/swap rename,
 * holding the random nonce also recorded in the promotion or update journal.
 * Recovery touches a tree at the target path only when the nonces match: this
 * proves the tree is the one WE moved there. Filesystem identities (dev/ino)
 * are NOT sufficient — deleting the orphan and recreating a directory at the
 * same path can reuse the inode immediately. The marker is removed once the
 * mutation commits, and validateStagedClone rejects repositories shipping the
 * reserved name so the write can never clobber plugin-owned content.
 */
const PROMOTION_MARKER_FILE = ".mux-promotion-marker";

/** Marketplace entries whose skills a listing scans at once (each scan reads SKILL.md files). */
const MARKETPLACE_SCAN_CONCURRENCY = 8;

/** Staging dirs left behind by crashes are reclaimed after this age. */
const STALE_STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/** How long an acquire waits on a live holder before failing (covers a full clone). */
const MUTATION_LOCK_ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;

/** Bound discovery/settings waits on startup crash-recovery I/O. */
const JOURNAL_RECONCILIATION_TIMEOUT_MS = 30_000;

/**
 * How long the discovery gate waits before it retries a pending sign-out pass that left the
 * record (a failed logout, a corrupt record). Every agent request runs the gate, so without it
 * an offline server is signed out, and a warning logged, once per request (#6627).
 */
const PENDING_SIGN_OUT_RETRY_MS = 30_000;

/** How long a Settings status read waits for the retry it started. */
const STATUS_RETRY_WAIT_MS = 5_000;

const LS_REMOTE_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;

/** Milliseconds on a monotonic clock (wall-clock changes do not move it). */
function monotonicNow(): number {
  return performance.now();
}

/**
 * Why logout() did not succeed before the pass deadline, or undefined when it did. A late or
 * hung logout counts as failed: the URL stays in the record, and a later pass retries it
 * (logout is idempotent).
 *
 * A late logout keeps running. A later pass waits for that same call instead of starting a
 * second one, so the record stays until the original call settles: a second logout could
 * otherwise clear the record while the first one still runs and later deletes a new sign-in.
 */
async function signOutFailure(
  oauth: Pick<McpOauthService, "logout" | "credentialKey">,
  serverUrl: string,
  deadline: number,
  inFlight: Map<string, Promise<Awaited<ReturnType<McpOauthService["logout"]>>>>
): Promise<string | undefined> {
  // Past the pass deadline: start nothing more. The URL stays in the record for the next pass.
  // Under 1 ms counts as past: timers have 1 ms resolution and can fire that much early.
  if (deadline - monotonicNow() < 1) return "The sign-out pass ran out of time before this server.";
  // Keyed by credential: `/mcp` and `/mcp/` are one stored sign-in, so one logout.
  const key = oauth.credentialKey(serverUrl) ?? serverUrl;
  let call = inFlight.get(key);
  if (call === undefined) {
    const started = oauth.logout({ serverUrl });
    call = started;
    inFlight.set(key, started);
    const forget = () => {
      if (inFlight.get(key) === started) inFlight.delete(key);
    };
    started.then(forget, forget);
  }
  const timeoutMs = Math.max(0, deadline - monotonicNow());
  const settled = await raceWithAbortAndTimeout(call, { timeoutMs });
  if (settled.kind === "ok") return settled.value.success ? undefined : settled.value.error;
  log.warn("A pending plugin MCP sign-out timed out", { timeoutMs });
  return `The sign-out did not finish within ${Math.round(timeoutMs / 1000)} s.`;
}

/**
 * Workspace IDs an install-time MCP override error lists. Large configs fail
 * the sweep for hundreds of workspaces at once, and a wall of IDs hid the
 * actual advice; the log keeps one warning per workspace.
 */
const MAX_LISTED_FAILED_WORKSPACES = 5;

/** "812 workspaces (a, b, c, d, e, and 807 more)" for an install error. */
function describeFailedWorkspaces(ids: readonly string[]): string {
  assert(ids.length > 0, "describeFailedWorkspaces: ids must be non-empty");
  const shown = ids.slice(0, MAX_LISTED_FAILED_WORKSPACES);
  const rest = ids.length - shown.length;
  const noun = ids.length === 1 ? "workspace" : "workspaces";
  return `${ids.length} ${noun} (${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""})`;
}

/**
 * The Settings text for a sign-out record Xum cannot use (#6627). The parser's own errors
 * already name the recovery step. A read error gets one here.
 */
function unusableRecordReason(error: unknown, file: string): string {
  // fs errors come from another realm under the Jest VM: read `code` without instanceof.
  const code: unknown =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return getErrorMessage(error);
  return `Xum cannot read the pending plugin sign-out record (${file}): ${code}. Fix its permissions. Or: in Settings → Plugins, choose "Sign out of plugin MCP servers": Xum deletes the file after the sign-outs succeed.`;
}

/**
 * A recorded sign-out URL as Settings shows it (#6627). The query, the fragment and the user info
 * can hold a secret from the plugin manifest, so they are left out. "?…" marks a removed query or
 * fragment.
 */
function displaySignOutUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(an unreadable URL)";
  }
  // Remote MCP servers are HTTP(S). Another scheme (blob:) can nest a URL with user info in its
  // path, so it is shown as unreadable.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "(an unreadable URL)";
  const cut = parsed.search !== "" || parsed.hash !== "";
  return `${parsed.origin}${parsed.pathname}${cut ? "?…" : ""}`;
}

/**
 * The URLs a parsed sign-out record names, for the Settings recovery (#6627). See
 * recordedUrlsForRecovery: a record of another version without readable `urls` throws.
 */
function recoveryUrls(record: unknown, file: string): string[] {
  const fields =
    typeof record === "object" && record !== null ? (record as Record<string, unknown>) : {};
  const urls = fields.urls;
  const current = fields.version === undefined || fields.version === 1;
  if (Array.isArray(urls)) {
    // A damaged current record keeps the URLs it can still name: an uninstalled plugin's URL
    // is in no tree, so the record is its only trace.
    const readable = urls.filter((url): url is string => typeof url === "string");
    if (current || readable.length === urls.length) return readable;
  }
  if (current) return [];
  throw new Error(
    `The pending plugin sign-out record (${file}) is from another Xum version, and this version cannot read its sign-outs. Open Xum in that version to finish them.`
  );
}

/**
 * Throws when a plugin tree's MCP servers can be missing from a scan (#6627): an installed
 * plugin without a readable manifest, or a declared MCP file that is missing (it resolves
 * without a diagnostic). Restored, either loads with the old sign-in. A directory that is not
 * installed and has no manifest is skipped, as discovery skips it (a Codex marketplace dir).
 */
function pluginWithReadableMcp(
  dirName: string,
  scan: { plugin: AgentPluginInfo | null; diagnostics: readonly AgentPluginDiagnostic[] },
  installed: boolean
): AgentPluginInfo | null {
  const { plugin } = scan;
  if (plugin === null) {
    if (installed || scan.diagnostics.some((d) => d.severity === "error"))
      throw new Error(`Xum cannot read the manifest of plugin '${dirName}'.`);
    return null;
  }
  if (plugin.mcpConfigPath === undefined && plugin.manifest.contributes?.mcp !== undefined)
    throw new Error(`Xum cannot read the MCP file that plugin '${dirName}' declares.`);
  return plugin;
}

/** Waits for the startup sign-out pass at most timeoutMs, then lets discovery go on. */
async function waitForPendingSignOuts(
  pass: Promise<void>,
  timeoutMs = JOURNAL_RECONCILIATION_TIMEOUT_MS
): Promise<void> {
  const settled = await raceWithAbortAndTimeout(pass, { timeoutMs });
  if (settled.kind === "timeout") log.warn("Pending plugin sign-outs timed out", { timeoutMs });
}

/** A component review that a pending or an unreadable sign-out record closed (#6627). */
function pendingSignOutError(
  record: { kind: "present" } | { kind: "unreadable"; code: string },
  file: string
): Error {
  if (record.kind === "unreadable")
    return new Error(
      `Xum cannot read the pending plugin sign-out record (${record.code}). Plugin components are unavailable until Xum can read it: ${file}.`
    );
  return new Error(
    "A plugin MCP sign-out from an update has not finished yet. Plugin components are unavailable until Xum finishes it; check the log for the reason."
  );
}

function componentsChangedError(): Error {
  return new Error(
    "Installed plugin files changed during component review. Refresh the component inventory."
  );
}

/** Deterministic JSON with recursively sorted object keys (fingerprinting). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        )
      );
    }
    return val;
  });
}

/** Preview skill row plus the extra model-visible fields (see collectSkills). */
type CollectedPluginSkill = AgentPluginPreviewSkill & {
  /** Load-time consent fingerprint (componentConsent.ts): root-relative dir + frontmatter. */
  consentFingerprint: string;
  /** The fingerprinted fields as text (componentConsent.ts skillConsentDetail), built on demand. */
  consentDetail: () => string;
  /** The raw SKILL.md (an approved copy) and its directory relative to the plugin root. */
  approvedCopy: { relativeDir: string; content: string };
  whenToUse?: string;
  advertise?: boolean;
  paths?: string[];
};

/**
 * EVERY model-visible advertisement field of a plugin skill: description, whenToUse
 * (both interpolate into the agent_skill_read tool description on each request),
 * advertise (a flip from hidden to visible surfaces a previously invisible skill), and
 * paths (which files surface it). Changing any of them is re-consent territory, same as
 * adding a skill. The fingerprint stays JSON (field boundaries are unambiguous); the
 * display rendering is NOT used for comparison because a multi-line description could
 * imitate it.
 */
/**
 * The consent an update journal carries (#6589). Absent in journals from older builds, and a
 * malformed value is not consent: both return undefined, so recovery keeps the old records and
 * the changed components ask for review again (fails closed).
 */
function journalComponentConsent(
  doc: Record<string, unknown> | null
): ComponentConsent | undefined {
  const parsed = AgentPluginComponentConsentSchema.safeParse(doc?.componentConsent);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The raw registry consent with this build's kinds replaced. A newer build may store more kinds,
 * and a save on this build must keep them (downgrade round-trip).
 */
function mergeRawConsent(raw: unknown, consent: ComponentConsent): Record<string, unknown> {
  return { ...(isPlainObject(raw) ? raw : {}), ...consent };
}

/**
 * The registry patch for recovered consent: none when the journal carried none. Records merge per
 * component, and the journal's win (#6698). The registry can gain records between the crash and
 * the recovery (setComponents for a newly selected component), and replacing them would ask for
 * those reviews again. A record for the same name fingerprints the same promoted tree, so it
 * agrees with the journal's.
 */
function recoveredConsentPatch(
  raw: unknown,
  consent: ComponentConsent | undefined
): { componentConsent?: Record<string, unknown> } {
  if (consent === undefined) return {};
  const current = isPlainObject(raw) ? raw : {};
  const merged = Object.entries(consent).map(([kind, records]) => {
    const earlier = current[kind];
    return [kind, { ...(isPlainObject(earlier) ? earlier : {}), ...records }] as const;
  });
  // Like mergeRawConsent: kinds this build does not know stay as stored.
  return { componentConsent: { ...current, ...Object.fromEntries(merged) } };
}

function skillChangeSummary(current: SurfaceSkill, staged: SurfaceSkill, name: string): string {
  return current.fingerprint !== staged.fingerprint
    ? `changes the model-visible advertisement of skill '${name}'`
    : `changes the definition of skill '${name}'`;
}

/** Both consent views of one skill (componentConsent.ts). */
function skillConsentFields(args: Parameters<typeof skillConsentFingerprint>[0]): {
  consentFingerprint: string;
  consentDetail: () => string;
} {
  return {
    consentFingerprint: skillConsentFingerprint(args),
    consentDetail: () => skillConsentDetail(args),
  };
}

/**
 * The review text of a skill or server: its usual summary plus every fingerprinted field. The
 * review records the fingerprint, which covers fields the summary omits (a header, an OAuth scope,
 * a frontmatter key), so the user must see all of them to approve what is recorded.
 */
interface ReviewTextSource {
  display: string;
  consentDetail: () => string;
}

function reviewText(item: ReviewTextSource): string {
  return showInvisibleControls(`${item.display}\n\nReviewed fields: ${item.consentDetail()}`);
}

/**
 * Upper bound on the text of one review. Frontmatter fields have no size limit, so a crafted
 * package could make a review too large to send and render. Over the bound, Xum refuses the review
 * (fails closed) instead of truncating text the user would approve.
 */
const MAX_REVIEW_TEXT_CHARS = 1_000_000;

/**
 * The install preview and the component picker list every directive command, and install records
 * consent for them, so the list is bounded like a review and never cut (#6766). Only responses
 * that list the commands check it: one oversized plugin must not break the plugin list.
 */
function assertDirectivesFit(skills: ReadonlyArray<{ name: string; directives?: string[] }>): void {
  assertReviewFits(
    skills.map((skill) => ({ summary: skill.name, after: (skill.directives ?? []).join("\n") }))
  );
}

function assertReviewFits(changes: readonly AgentPluginCapabilityChange[]): void {
  const size = changes.reduce(
    (total, change) =>
      total + change.summary.length + (change.before?.length ?? 0) + (change.after?.length ?? 0),
    0
  );
  if (size > MAX_REVIEW_TEXT_CHARS) {
    throw new Error(
      "This plugin's review is too large to show, so Xum cannot install or change it. Contact its publisher."
    );
  }
}

/** A file larger than this shows only its row in the file review, like a binary file. */
const FILE_REVIEW_TEXT_MAX_BYTES = 64 * 1024;

/**
 * A Cursor command hook can run or source any file of its plugin, so a plugin with one gets a
 * review of its files (Cursor plugin RFC D1).
 */
function runsCursorCommands(hooks: readonly PluginHookDefinition[]): boolean {
  return hooks.some((hook) => hook.status === "runnable" && hook.handler.type === "cursor-command");
}

/** The text of one side of a file review row: absent for a binary or large file. */
function fileReviewText(record: PluginTreeRecord | undefined): string | undefined {
  if (record?.kind === "symlink") return showOneLineControls(record.target);
  if (record?.kind !== "file" || record.bytes === undefined) return undefined;
  try {
    // ignoreBOM keeps a leading BOM in the text, so the review marks it instead of dropping it.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(record.bytes);
    return showInvisibleControls(text);
  } catch {
    return undefined;
  }
}

function treeEntryContent(record: PluginTreeRecord): string {
  return record.kind === "file" ? record.hash : record.kind === "symlink" ? record.target : "";
}

function sameTreeEntry(a: PluginTreeRecord, b: PluginTreeRecord): boolean {
  return a.kind === b.kind && a.mode === b.mode && treeEntryContent(a) === treeEntryContent(b);
}

/** One file review row: an added row has only `after`, a removed row only `before`. */
function fileReviewRow(
  filePath: string,
  was: PluginTreeRecord | undefined,
  now: PluginTreeRecord | undefined
): AgentPluginCapabilityChange {
  const verb = was === undefined ? "added" : now === undefined ? "removed" : "changed";
  const before = fileReviewText(was);
  const after = fileReviewText(now);
  return {
    summary: `file ${showOneLineControls(filePath)} ${verb}`,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

/**
 * The file review (D1, D30): one row per file or symlink that differs between two plugin trees.
 * `before: null` is the empty tree, so every file is an added row. A directory gets no row; the
 * files under it do.
 */
function fileReviewRows(
  before: readonly PluginTreeRecord[] | null,
  after: readonly PluginTreeRecord[]
): AgentPluginCapabilityChange[] {
  const entries = (records: readonly PluginTreeRecord[]) =>
    new Map(
      records.filter((record) => record.kind !== "directory").map((record) => [record.path, record])
    );
  const old = entries(before ?? []);
  const next = entries(after);
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((filePath) => {
    const was = old.get(filePath);
    const now = next.get(filePath);
    return was !== undefined && now !== undefined && sameTreeEntry(was, now)
      ? []
      : [fileReviewRow(filePath, was, now)];
  });
}

/** List row field: managed rows count imported components that need a review (#6498). */
function reviewRequiredField(
  entry: AgentPluginInstallEntry | undefined,
  fingerprints: ComponentConsent,
  /** Agents two files claim (#6629): they do not load, and the review row says why. */
  ambiguousAgentCount: number
): { reviewRequiredCount?: number } {
  if (entry === undefined) return {};
  return {
    reviewRequiredCount:
      countUnreviewed({
        current: fingerprints,
        selection: entry.importedComponents,
        consent: entry.componentConsent,
      }) + ambiguousAgentCount,
  };
}

/** How many agent IDs of a plugin two files claim (#6629). */
async function countAmbiguousAgents(plugin: Pick<AgentPluginInfo, "agentsDir">): Promise<number> {
  const ambiguous = new Set<string>();
  await listPluginAgentFiles(plugin.agentsDir, [], ambiguous);
  return ambiguous.size;
}

/** Consent after a confirmed review: only the shown refs that still match get records. */
function consentAfterReview(
  entry: AgentPluginInstallEntry,
  changes: readonly AgentPluginCapabilityChange[],
  consent: { reviewed?: readonly AgentPluginComponentRef[] } | undefined
): ComponentConsent {
  return recordReviewedComponents({
    previous: entry.componentConsent,
    current: changes.flatMap((change) => (change.component ? [change.component] : [])),
    reviewed: consent?.reviewed ?? [],
  });
}

/**
 * Component review rows: imported skills and MCP servers whose current consent fingerprint has
 * no matching record. `before` says whether the user ever reviewed the component on this install,
 * and whether its approved copy stays in use until this review (`served`, approvedCopies.ts).
 */
function unreviewedRows(
  entry: AgentPluginInstallEntry,
  surface: {
    skills: Map<string, SurfaceSkill>;
    servers: Map<string, SurfaceServer>;
    workflows: Map<string, SurfaceWhole>;
    agents: Map<string, SurfaceWhole>;
    slashCommands: Map<string, SurfaceWhole>;
  },
  served: VerifiedApprovedCopies
): AgentPluginCapabilityChange[] {
  return [
    ...[...surface.skills].flatMap(([name, item]) =>
      unreviewedRow(entry, "skills", name, item, served.skills.has(name))
    ),
    ...[...surface.servers].flatMap(([name, item]) =>
      unreviewedRow(entry, "mcpServers", name, item)
    ),
    ...[...surface.workflows].flatMap(([name, item]) =>
      unreviewedRow(entry, "workflows", name, item, served.workflows.has(name))
    ),
    ...[...surface.agents].flatMap(([name, item]) => unreviewedRow(entry, "agents", name, item)),
    ...[...surface.slashCommands].flatMap(([name, item]) =>
      unreviewedRow(entry, "slashCommands", name, item)
    ),
  ];
}

const COMPONENT_LABELS: Record<keyof ComponentConsent, string> = {
  skills: "Skill",
  mcpServers: "MCP server",
  workflows: "Workflow",
  agents: "Agent",
  slashCommands: "Slash command",
};

function reviewedBefore(
  consent: ComponentConsent | undefined,
  kind: keyof ComponentConsent,
  name: string
): string {
  return consent !== undefined && getOwn(consent[kind], name) !== undefined
    ? "Changed since you reviewed it"
    : "Not reviewed on this install";
}

/** `before` of a changed skill or workflow script whose approved copy serves meanwhile. */
const APPROVED_COPY_IN_USE =
  "Changed since you reviewed it. Until you approve this version, Xum uses the version you approved.";

function unreviewedRow(
  entry: AgentPluginInstallEntry,
  kind: keyof ComponentConsent,
  name: string,
  item: SurfaceSkill | SurfaceServer | SurfaceWhole,
  approvedCopyInUse = false
): AgentPluginCapabilityChange[] {
  const imported = isImportedComponent(entry.importedComponents, kind, name);
  const fingerprint = item.consentFingerprint;
  if (!imported || isComponentConsented(entry.componentConsent, kind, name, fingerprint)) return [];
  return [
    {
      summary: `${COMPONENT_LABELS[kind]} '${showInvisibleControls(name)}' needs review`,
      before: approvedCopyInUse
        ? APPROVED_COPY_IN_USE
        : reviewedBefore(entry.componentConsent, kind, name),
      after: reviewText(item),
      component: { kind, name, fingerprint },
    },
  ];
}

/**
 * Update rows for workflow scripts and agents (#6629). A script executes and an agent's frontmatter
 * sets its tools and runnability, so a new or changed one needs a review, and confirming the
 * update records it. Removals apply without one.
 */
function wholeComponentChanges(
  kind: "workflows" | "agents" | "slashCommands",
  staged: ReadonlyMap<string, SurfaceWhole>,
  /** The installed tree's components of this kind; absent when the tree is missing or invalid. */
  current: ReadonlyMap<string, SurfaceWhole> | undefined
): AgentPluginCapabilityChange[] {
  const label = COMPONENT_LABELS[kind].toLowerCase();
  return [...staged].flatMap(([name, item]) => {
    const component = { kind, name, fingerprint: item.consentFingerprint };
    const before = current?.get(name);
    if (before === undefined) {
      return [
        {
          summary: `adds ${label} '${showInvisibleControls(name)}'`,
          after: reviewText(item),
          component,
        },
      ];
    }
    if (before.consentFingerprint === item.consentFingerprint) return [];
    return [
      {
        summary: `changes ${label} '${showInvisibleControls(name)}'`,
        before: reviewText(before),
        after: reviewText(item),
        component,
      },
    ];
  });
}

/**
 * The preview rows of the components that install records consent for besides skills and MCP
 * servers (#6629), with the text a component review would show. Bounded like a review: over the
 * bound, the preview fails closed.
 */
function reviewedComponentRows(
  groups: ReadonlyArray<
    readonly [AgentPluginComponentRef["kind"], ReadonlyArray<readonly [string, ReviewTextSource]>]
  >
): AgentPluginInstallPreview["reviewedComponents"] {
  const rows = groups.flatMap(([kind, items]) =>
    items.map(([name, item]) => ({
      kind,
      name: showInvisibleControls(name),
      detail: reviewText(item),
    }))
  );
  assertReviewFits(rows.map((row) => ({ summary: row.name, after: row.detail })));
  return rows;
}

/** Every component of an inventory: what a legacy import-all entry (no selection) imports. */
function fullSelection(
  inventory: Pick<AgentPluginComponents, "skills" | "mcpServers">
): AgentPluginImportedComponents {
  return {
    skills: inventory.skills.map((skill) => skill.name),
    mcpServers: inventory.mcpServers.map((server) => server.serverName),
  };
}

/**
 * The consent fingerprints of every component an inventory shows. The install preview and install
 * both build it from the rows they collected, so the two digests compare like for like (#6777).
 */
function inventoryFingerprints(parts: {
  skills: readonly CollectedPluginSkill[];
  mcpServers: Record<string, string>;
  workflows: ReadonlyArray<{ file: string; consentFingerprint: string }>;
  agents: ReadonlyArray<Parameters<typeof agentConsentFingerprint>[0]>;
  slashCommands: ReadonlyArray<readonly [string, SurfaceWhole]>;
}): ComponentConsent {
  return {
    skills: Object.fromEntries(parts.skills.map((skill) => [skill.name, skill.consentFingerprint])),
    mcpServers: parts.mcpServers,
    workflows: Object.fromEntries(parts.workflows.map((w) => [w.file, w.consentFingerprint])),
    agents: Object.fromEntries(
      parts.agents.map((agent) => [agent.id, agentConsentFingerprint(agent)])
    ),
    slashCommands: Object.fromEntries(
      parts.slashCommands.map(([name, item]) => [name, item.consentFingerprint])
    ),
  };
}

/**
 * Install reads its own clone, so a read that failed only in the preview (a script with no row)
 * would get a consent record nobody saw (#6777). Install refuses then. Same SHA, so a mismatch
 * means a read differed: the user can preview again.
 */
function assertInventoryMatchesPreview(
  expectedDigest: string | undefined,
  fingerprints: ComponentConsent,
  hook: AgentPluginPreviewHook | undefined
): void {
  if (
    expectedDigest === undefined ||
    expectedDigest === componentConsentDigest(fingerprints, hook)
  ) {
    return;
  }
  throw new Error(
    "This plugin's components differ from the preview, so Xum did not install it. Preview the plugin again."
  );
}

/** The consent preview showed every component of the pinned SHA (#6498). */
function consentAtInstall(
  importedComponents: AgentPluginImportedComponents | undefined,
  inventory: Pick<AgentPluginComponents, "skills" | "mcpServers"> & {
    fingerprints: ComponentConsent;
  }
): ComponentConsent {
  return consentForSelection({
    selection: importedComponents ?? fullSelection(inventory),
    shown: inventory.fingerprints,
  });
}

function omitConsentFingerprint(
  skill: CollectedPluginSkill
): Omit<CollectedPluginSkill, "consentFingerprint" | "consentDetail" | "approvedCopy"> {
  const {
    consentFingerprint,
    consentDetail: _consentDetail,
    approvedCopy: _approvedCopy,
    ...rest
  } = skill;
  assert(consentFingerprint.length > 0, "collected skills carry a consent fingerprint");
  return rest;
}

function describeSkillAdvertisement(skill: CollectedPluginSkill): {
  fingerprint: string;
  display: string;
} {
  return {
    fingerprint: JSON.stringify({
      description: skill.description ?? null,
      whenToUse: skill.whenToUse ?? null,
      advertise: skill.advertise ?? null,
      // Only path-scoped skills carry the key, so fingerprints of existing
      // skills stay byte-identical (no spurious re-consent on update). Patterns
      // are OR-ed, so order is irrelevant: sort a copy so a reorder needs no consent.
      ...(skill.paths !== undefined ? { paths: [...skill.paths].sort() } : {}),
    }),
    display: formatSkillAdvertisementDisplay(skill),
  };
}

/** The advertisement as the model sees it, shown in the update review. */
function formatSkillAdvertisementDisplay(skill: CollectedPluginSkill): string {
  return [
    skill.description ?? "(no description)",
    ...(skill.whenToUse !== undefined ? [`When to use: ${skill.whenToUse}`] : []),
    ...(skill.advertise === false ? ["(not advertised to the model)"] : []),
    // Declared scope only: this text makes no claim about how the scope is enforced.
    // JSON quoting keeps entries unambiguous: ["a, b"] and ["a", "b"] render differently.
    ...(skill.paths !== undefined ? [`Declared paths: ${JSON.stringify(skill.paths)}`] : []),
  ].join("\n");
}

/** Result of resolving a user-supplied ref against the remote. */
interface ResolvedRemoteRef {
  ref: string;
  refType: "branch" | "tag" | "commit";
  /** Peeled commit SHA for branch/tag; the ref itself for commit. */
  sha: string;
}

/**
 * The Git environment of every staging clone, fetch and checkout. `ambient` is the environment
 * the Git process inherits: its GIT_SSH_COMMAND (a custom identity, proxy or wrapper) is kept.
 */
function gitEnv(ambient: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Fail fast instead of hanging on credential prompts: installs run from the
  // UI with no terminal attached (acceptance: "private repo without auth" must
  // fail cleanly).
  //
  // SECURITY: disable Git hooks for every staging clone/fetch/checkout. A
  // user with a RELATIVE global core.hooksPath (e.g. ".githooks") would
  // otherwise execute an attacker-controlled repository's post-checkout hook
  // during Preview — before any consent UI appears. GIT_CONFIG_* env config
  // takes precedence over all config files, so this neutralizes hooks
  // regardless of global/system configuration.
  //
  // SECURITY: whitelist transports. Git remote helpers execute arbitrary
  // commands (`ext::touch /pwn` runs before any consent UI when the user's
  // config sets protocol.ext.allow=always), and disabling hooks does not
  // restrict helpers. GIT_ALLOW_PROTOCOL is an env-level whitelist that
  // overrides protocol.*.allow configuration for every staging invocation.
  //
  // SECURITY: ignore system/global Git configuration during ALL staging Git
  // operations. An attacker-controlled repository can assign a user-defined
  // filter through .gitattributes; if the user's global config defines that
  // filter's smudge/process command, Git executes it during clone/checkout —
  // before consent. The staging flow deliberately accepts only the explicit
  // URL/ref plus the numbered safe config below; authentication must come
  // from transport-level mechanisms (SSH agent, URL credentials rejected
  // separately), never executable credential/filter/helper configuration.
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    ...GIT_NO_HOOKS_ENV,
  };
  const sshCommand = ambient.GIT_SSH_COMMAND;
  env.GIT_SSH_COMMAND = sshCommand ?? "ssh -oBatchMode=yes";
  return env;
}

/**
 * True when the aggregate file bytes OR the entry count under `dir` exceed
 * the quota. Counts EVERY entry — files, symlinks, and directories — like
 * assertStagedTreeWithinQuota: each one consumes an inode and filesystem
 * metadata without necessarily moving the byte total (a tiny pack of repeated
 * git tree objects can materialize thousands of directories). Walks with
 * early exit; entries vanishing mid-walk (git renames temp files) are
 * skipped.
 */
async function directoryQuotaExceeded(
  dir: string,
  quota: { maxBytes: number; maxFiles: number }
): Promise<boolean> {
  let bytes = 0;
  let entryCount = 0;
  const pending: string[] = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    assert(current !== undefined, "directoryQuotaExceeded: queue underflow");
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      entryCount += 1;
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        try {
          bytes += (await fsPromises.lstat(entryPath)).size;
        } catch {
          // Entry vanished mid-walk.
        }
      }
      if (bytes > quota.maxBytes || entryCount > quota.maxFiles) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Run `fn` with an AbortSignal that fires when `dir` grows past `maxBytes`
 * or `maxFiles` while fn is pending. Bounds git DURING clone/fetch/checkout:
 * the post-clone quota can only reject a tree git already materialized, so a
 * huge remote would otherwise fill the disk — or exhaust inodes via many
 * empty files — before that check runs. Exported for tests.
 */
export async function withDiskQuotaWatchdog<T>(
  quota: { dir: string; maxBytes: number; maxFiles: number; pollMs?: number },
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let exceeded = false;
  let checking = false;
  const interval = setInterval(() => {
    if (checking || exceeded) {
      return;
    }
    checking = true;
    directoryQuotaExceeded(quota.dir, quota).then(
      (over) => {
        checking = false;
        if (over) {
          exceeded = true;
          controller.abort();
        }
      },
      () => {
        checking = false;
      }
    );
  }, quota.pollMs ?? 500);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (exceeded) {
      throw new Error(
        `The repository is too large to install as a plugin (exceeded ${Math.floor(quota.maxBytes / (1024 * 1024))} MiB or ${quota.maxFiles} files during clone).`
      );
    }
    throw error;
  } finally {
    clearInterval(interval);
  }
}

async function runGit(
  args: string[],
  opts?: {
    timeoutMs?: number;
    diskQuota?: { dir: string; maxBytes: number; maxFiles: number; pollMs?: number };
  }
): Promise<string> {
  const run = async (signal?: AbortSignal): Promise<string> => {
    using proc = execFileAsync("git", args, {
      env: gitEnv(),
      timeoutMs: opts?.timeoutMs ?? CLONE_TIMEOUT_MS,
      // Git spawns SSH/credential-helper children that inherit its pipes; a
      // stalled helper would otherwise keep the promise pending past the
      // timeout because only the direct child gets killed.
      killTreeOnTermination: true,
      // These remotes are untrusted: a malicious or noisy repository can emit
      // unbounded progress/sideband output, and unbounded buffering would
      // exhaust the main process before the timeout fires. 10 MiB is far above
      // anything the plugin-sized clones/ls-remotes here legitimately produce.
      maxOutputBytes: 10 * 1024 * 1024,
      ...(signal !== undefined ? { signal } : {}),
    });
    const { stdout } = await proc.result;
    return stdout;
  };
  if (opts?.diskQuota !== undefined) {
    const diskQuota = opts.diskQuota;
    return withDiskQuotaWatchdog(diskQuota, (signal) => run(signal));
  }
  return run();
}

/**
 * Extra `git clone` flags for a monorepo subpath install: a partial clone
 * (no blobs up front) with no initial checkout. `--sparse` would check out
 * the repository-root files first, and those count toward the clone quota,
 * so a small plugin in a monorepo with large root files could not install.
 * cloneRef checks out after narrowToSubpath has set the sparse pattern.
 */
function sparseCloneFlags(subpath: string | undefined, url: string): string[] {
  // --no-local: for a plain local-path source, git's local-clone shortcut
  // ignores --depth and --filter and copies the whole repository history.
  return subpath === undefined
    ? []
    : ["--filter=blob:none", "--no-checkout", "--no-local", ...localUploadPackFlags(url)];
}

/** `git fetch` counterpart of sparseCloneFlags (the sparse checkout is set before checkout). */
function partialFetchFlags(subpath: string | undefined, url: string): string[] {
  return subpath === undefined ? [] : ["--filter=blob:none", ...localUploadPackFlags(url)];
}

/**
 * For a local source (absolute path or file://), git runs the source's
 * upload-pack on this machine, and that upload-pack ignores --filter unless
 * the SOURCE repository sets uploadpack.allowFilter (off by default). Every
 * blob of the commit would then land in the clone and count toward its quota.
 * Enabling it on the command line needs no change to the user's repository.
 * Remote transports keep their server's own setting.
 */
function localUploadPackFlags(url: string): string[] {
  const isLocal = url.startsWith("file://") || path.isAbsolute(url);
  return isLocal ? ["--upload-pack", "git -c uploadpack.allowFilter=true upload-pack"] : [];
}

/** Git tree-entry modes that are not folders, for the subpath error. Other modes are files. */
const NON_FOLDER_GIT_MODE_KINDS: Readonly<Record<string, string>> = {
  "120000": "a symbolic link",
  "160000": "a git submodule",
};

/** Mode of the entry named exactly `name` in `git ls-tree -z` output, if any. */
function lsTreeEntryMode(output: string, name: string): string | undefined {
  for (const record of output.split("\0")) {
    const match = /^(\d{6}) \S+ [0-9a-f]+\t([\s\S]*)$/.exec(record);
    if (match !== null && match[2] === name) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Subpath for preview(): from the shorthand or the separate API argument
 * (normalized), refusing two different ones (mirrors the ref conflict).
 */
function resolvePreviewSubpath(
  parsedSubpath: string | undefined,
  rawExplicit: string | undefined
): string | undefined {
  const explicit = rawExplicit?.trim() ? normalizeAgentPluginSubpath(rawExplicit) : undefined;
  if (explicit !== undefined && parsedSubpath !== undefined && parsedSubpath !== explicit) {
    throw new Error(
      `Conflicting subpaths: '${parsedSubpath}' in the source and '${explicit}' in the subpath field.`
    );
  }
  return parsedSubpath ?? explicit;
}

/**
 * Ref for preview(): from the `@ref` shorthand or the separate field, refusing two different
 * ones. An empty field is no ref.
 */
function resolvePreviewRef(
  parsedRef: string | undefined,
  rawExplicit: string | undefined
): string | undefined {
  const explicit = rawExplicit?.trim() ?? "";
  if (explicit.length > 0 && parsedRef !== undefined && parsedRef !== explicit) {
    throw new Error(
      `Conflicting refs: '@${parsedRef}' in the source and '${explicit}' in the ref field.`
    );
  }
  return parsedRef ?? (explicit.length > 0 ? explicit : undefined);
}

/** The entry name of a `claude-marketplace` method. */
function marketplaceEntryOf(
  method: AgentPluginInstallMethod | null | undefined
): string | undefined {
  return method?.kind === "claude-marketplace" ? method.entry : undefined;
}

/** The git source that preview returns and install persists. */
function resolvedGitSource(
  url: string,
  resolved: Pick<ResolvedRemoteRef, "ref" | "refType">,
  subpath: string | undefined
): AgentPluginGitSource {
  return {
    type: "git",
    url,
    ref: resolved.ref,
    refType: resolved.refType,
    ...(subpath !== undefined ? { subpath } : {}),
  };
}

/** Throws unless `subpath` is absent or already in normalizeAgentPluginSubpath form. */
function assertNormalizedSubpath(subpath: string | undefined): void {
  if (subpath !== undefined && normalizeAgentPluginSubpath(subpath) !== subpath) {
    throw new Error(`The plugin subpath '${subpath}' is not normalized. Run the preview again.`);
  }
}

/** A plugin subpath that is missing or not a real folder at the staged commit (shown unwrapped). */
class AgentPluginSubpathError extends Error {}

function subpathNotAFolder(
  subpath: string,
  url: string,
  prefix: string,
  kind: string
): AgentPluginSubpathError {
  return new AgentPluginSubpathError(
    `'${subpath}' is not a folder in ${url} ('${prefix}' is ${kind}). Subpath installs need a real folder.`
  );
}

/** Max simultaneous `git ls-remote` processes during an update check. */
const UPDATE_CHECK_CONCURRENCY = 4;

/**
 * Aggregate quota for a staged clone's checkout (excluding .git). Remotes are
 * untrusted: --depth 1 and the subprocess output cap do not bound CHECKOUT
 * bytes, so a malicious repository could otherwise exhaust disk (and the
 * full-file manifest reads that follow) before consent ever appears. Far
 * above any legitimate plugin (skills/agents/workflows are text).
 */
const STAGED_TREE_MAX_BYTES = 100 * 1024 * 1024;
const STAGED_TREE_MAX_FILES = 10_000;

/**
 * Map with a bounded worker pool, preserving input order. Rejections
 * propagate; callers needing per-item error isolation catch inside `fn`
 * (checkUpdates does).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  assert(limit > 0, "mapWithConcurrency: limit must be positive");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fsPromises.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Consent-preview details of a stdio launch beyond its argv: cwd, env and host env. */
function stdioLaunchDetails(
  info: MCPStdioServerInfo,
  rewrite: (value: string) => string,
  finalTargetPath: string
): string[] {
  // Env VALUES are execution-relevant (e.g. NODE_OPTIONS=--require=…
  // auto-loads code the argv never shows), so consent must disclose the
  // full assignment, quoted like the argv so boundaries are unambiguous.
  const envAssignments = Object.entries(info.env ?? {})
    .filter(([key]) => key !== "PLUGIN_ROOT" && key !== "PLUGIN_DATA")
    .map(([key, value]) => `${key}=${shellQuote(rewrite(value))}`);
  const details: string[] = [];
  // cwd is execution-relevant too: prepareStdioLaunch passes it to the
  // runtime, so `node server.js` resolves scripts/configs relative to
  // it — including from WRITABLE persistent plugin data — and the argv
  // alone would imply a different resolution (capabilitySurface treats
  // cwd as consent-relevant for the same reason). The loader defaults
  // cwd to the plugin root; only a DEVIATION from the reviewed tree
  // root needs calling out.
  if (info.cwd !== undefined && rewrite(info.cwd) !== finalTargetPath) {
    details.push(`cwd: ${shellQuote(rewrite(info.cwd))}`);
  }
  if (envAssignments.length > 0) {
    details.push(`env: ${envAssignments.join(" ")}`);
  }
  // Codex `env_vars`: the server receives these host values (often credentials). Only the
  // names are shown, never the values.
  if (info.forwardEnv !== undefined) {
    details.push(`host env: ${info.forwardEnv.map(shellQuote).join(" ")}`);
  }
  return details;
}

/** Preview warning for a skill whose SKILL.md `name` is only a display name. */
function displayNameWarnings(
  label: string,
  dirName: string,
  displayName: string | undefined
): string[] {
  if (displayName === undefined) return [];
  return [
    `${label}: SKILL.md name '${displayName}' is not the directory name; it loads as '${dirName}'`,
  ];
}

/** A preview warning's plugin-relative name for skill `name` of `skillsRoot`. */
/** The `contributes.skills` value of a generated manifest (undefined: the default skills/). */
function declaredSkills(manifest: Record<string, unknown>): string | string[] | undefined {
  const skills = isPlainObject(manifest.contributes) ? manifest.contributes.skills : undefined;
  if (typeof skills === "string") return skills;
  return Array.isArray(skills)
    ? skills.filter((item): item is string => typeof item === "string")
    : undefined;
}

function skillReviewLabel(pluginRoot: string, skillsRoot: PluginSkillsRoot, name: string): string {
  const relativeRoot = path.relative(pluginRoot, skillsRoot.dir);
  // A command or a rule is its file; a single skill folder is the skill itself, and at the plugin root it
  // has no relative path.
  if (skillsRoot.command) return path.join(relativeRoot, `${name}.md`);
  if (skillsRoot.rule !== undefined) return path.join(relativeRoot, skillsRoot.rule);
  if (skillsRoot.single) return relativeRoot === "" ? "." : relativeRoot;
  return `${relativeRoot}/${name}`;
}

function shortenHome(absPath: string): string {
  const home = os.homedir();
  if (absPath === home) {
    return "~";
  }
  return absPath.startsWith(home + path.sep) ? `~${absPath.slice(home.length)}` : absPath;
}

/** Remote-server sign-in as the update review compares it. */
interface SurfaceSignIn {
  url: string;
  oauth?: MCPServerOAuthConfig;
  /** sha256 of the plugin client secret: compared, never shown. */
  secretDigest?: string;
  /** Tokens belong to this: client, endpoints, resource and scopes. */
  identity: string;
}

interface SurfaceSkill {
  fingerprint: string;
  consentFingerprint: string;
  display: string;
  /** The skill directory relative to the plugin root: an approved copy serves only there. */
  relativeDir: string;
  /** Every fingerprinted field as text, built on demand for a review row (see reviewText). */
  consentDetail: () => string;
}

/** The consent views of a plugin's slash commands, by name (#6629). */
function slashCommandSurface(plugin: AgentPluginInfo): Map<string, SurfaceWhole> {
  return new Map(
    (plugin.manifest.contributes?.slashCommands ?? []).map((command) => [
      command.name,
      {
        consentFingerprint: slashCommandConsentFingerprint(command),
        display: `Slash command /${command.name}`,
        consentDetail: () => slashCommandConsentDetail(command),
      },
    ])
  );
}

/**
 * Update rows for agents that stop loading because a second file claims their ID (#6629). The
 * agent drops out of the staged surface, which alone would read as a removal and apply without a
 * review, so the user would never see why the agent is gone.
 */
function ambiguousAgentChanges(
  staged: ReadonlySet<string>,
  current: ReadonlySet<string> | undefined
): AgentPluginCapabilityChange[] {
  return [...staged]
    .filter((agentId) => !(current?.has(agentId) ?? false))
    .map((agentId) => ({
      summary: `agent '${showInvisibleControls(agentId)}' will not load: more than one file claims its ID`,
    }));
}

/** A workflow script's source as the runtime reads it; undefined (with a warning) when unreadable. */
async function readWorkflowScriptForReview(
  pluginRoot: string,
  target: { file: string; filePath: string },
  warnings: string[]
): Promise<string | undefined> {
  try {
    return (
      await readPluginFileWithinRootCapped({
        filePath: target.filePath,
        pluginRoot,
        maxBytes: MAX_FILE_SIZE,
        label: "plugin workflow script",
      })
    ).content;
  } catch (error) {
    warnings.push(
      `Workflow '${showInvisibleControls(target.file)}' cannot be read and will not run: ${getErrorMessage(error)}`
    );
    return undefined;
  }
}

/** The consent view of one plugin agent (#6629). */
function agentSurface(agent: PluginAgentFile): SurfaceWhole {
  return {
    consentFingerprint: agentConsentFingerprint(agent),
    display: `Agent ${agent.id} (agents file ${agent.file})`,
    consentDetail: () => agentConsentDetail(agent),
  };
}

/**
 * A component the picker does not select (#6629): a workflow script, whose review shows all of
 * its source, or an agent, whose review shows its frontmatter.
 */
interface SurfaceWhole {
  consentFingerprint: string;
  display: string;
  consentDetail: () => string;
}

interface SurfaceServer {
  /** Update diff: the consent fingerprint plus the client-secret digest (#6498 review S2). */
  fingerprint: string;
  /** Load-time consent fingerprint (componentConsent.ts). */
  consentFingerprint: string;
  display: string;
  /** Every fingerprinted field as text, built on demand for a review row (see reviewText). */
  consentDetail: () => string;
  signIn?: SurfaceSignIn;
}

/** Per-scan memo: each `.mcp.json` is read and parsed once for all its servers. */
type SecretReader = (
  source: NonNullable<MCPServerOAuthConfig["clientSecretSource"]>,
  clientId: string
) => Promise<string | undefined>;

function createSecretReader(): SecretReader {
  const files = new Map<string, Promise<Map<string, PluginClientSecret>>>();
  return (source, clientId) => {
    let secrets = files.get(source.mcpConfigPath);
    if (secrets === undefined) {
      secrets = readPluginClientSecrets(source).catch(() => new Map<string, PluginClientSecret>());
      files.set(source.mcpConfigPath, secrets);
    }
    // Only the secret of the client this scan captured (#6297).
    return secrets.then((map) => pluginClientSecretFor(map, source.serverName, clientId));
  };
}

/**
 * Throws on a corrupt record or one of another version. SECURITY: it may name sign-outs that never ran, so it keeps the
 * discovery fence until the user repairs or deletes it. Reading it as "nothing pending" would
 * admit the plugin with its old sign-in's tokens.
 */
function parsePendingSignOuts(raw: string, file: string): string[] {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    record = undefined;
  }
  // Another version's record is kept as it is: an upgrade can still finish it.
  const fields =
    typeof record === "object" && record !== null ? (record as Record<string, unknown>) : {};
  const value = fields.version === 1 ? fields.urls : undefined;
  // Sign out first, delete last: every discovery gate checks only that this file exists
  // (containerHasPendingSignOuts), so deleting it first lets an agent load the updated
  // plugin and reuse the old grant before the user signs out.
  if (!Array.isArray(value) || !value.every((url) => typeof url === "string"))
    throw new Error(
      `The pending plugin sign-out record (${shortenHome(file)}) is corrupt or from another Xum version. In Settings → Plugins, choose "Sign out of plugin MCP servers": Xum deletes the file after the sign-outs succeed.`
    );
  return value;
}

async function readSignIn(
  url: string,
  oauth: MCPServerOAuthConfig | undefined,
  readSecret: SecretReader
): Promise<SurfaceSignIn> {
  const secret =
    oauth?.clientSecretSource !== undefined && oauth.clientId !== undefined
      ? await readSecret(oauth.clientSecretSource, oauth.clientId)
      : undefined;
  return {
    url,
    ...(oauth !== undefined ? { oauth: { ...oauth, clientSecretSource: undefined } } : {}),
    ...(secret !== undefined
      ? { secretDigest: createHash("sha256").update(secret).digest("hex") }
      : {}),
    identity: stableStringify({
      clientId: oauth?.clientId ?? null,
      // Tokens were issued by this authorization server (discovery is pointed at it).
      issuer: oauth?.discovery?.authorizationServerBase ?? null,
      registrationUrl: oauth?.discovery?.registrationUrl ?? null,
      resource: oauth?.resource ?? null,
      baseScopes: oauth?.baseScopes ?? null,
      defaultScopes: oauth?.defaultScopes ?? null,
    }),
  };
}

type SignInDiscovery = MCPServerOAuthConfig["discovery"];

function discoveryHosts(discovery: SignInDiscovery): Set<string> {
  return new Set(
    [discovery?.authorizationServerBase, discovery?.registrationUrl]
      .filter((url) => url !== undefined)
      .map((url) => new URL(url).host)
  );
}

/**
 * The line for one discovery URL whose host the host lines do not name: `changed (x → y)` for a
 * move on its host, `added`/`removed` for a URL on a host that both versions use (#6565).
 */
function discoveryFieldLine(
  name: string,
  key: "authorizationServerBase" | "registrationUrl",
  [a, b]: [SignInDiscovery, SignInDiscovery],
  hosts: [Set<string>, Set<string>]
): string[] {
  const [x, y] = [a?.[key], b?.[key]];
  if (x === y) return [];
  if (x === undefined || y === undefined) return addedOrRemovedLine(name, x, y, hosts);
  return new URL(x).host === new URL(y).host ? [`${name} changed (${x} → ${y})`] : [];
}

/** See discoveryFieldLine: exactly one of `x` (before) and `y` (after) is defined. */
function addedOrRemovedLine(
  name: string,
  x: string | undefined,
  y: string | undefined,
  [oldHosts, newHosts]: [Set<string>, Set<string>]
): string[] {
  const url = x ?? y;
  if (url === undefined) return [];
  // The other version must use this host; otherwise its host line names the change.
  const otherHosts = x === undefined ? oldHosts : newHosts;
  if (!otherHosts.has(new URL(url).host)) return [];
  return [`${name} ${x === undefined ? "added" : "removed"} (${url})`];
}

/**
 * Review lines for the sign-in discovery URLs: one per added or removed host, and one per URL
 * that changed on a host both versions use. Tenants share a host (`/tenant-a` → `/tenant-b`), so
 * a path move gets its own line, also when another discovery URL changed host (#6164).
 */
function describeDiscoveryChanges(a: SignInDiscovery, b: SignInDiscovery): string[] {
  const hosts: [Set<string>, Set<string>] = [discoveryHosts(a), discoveryHosts(b)];
  const [oldHosts, newHosts] = hosts;
  const lines = [
    ...[...newHosts]
      .filter((host) => !oldHosts.has(host))
      .map((host) => `Sign-in at ${host} (new)`),
    ...[...oldHosts]
      .filter((host) => !newHosts.has(host))
      .map((host) => `Sign-in at ${host} (removed)`),
    ...discoveryFieldLine("Sign-in server", "authorizationServerBase", [a, b], hosts),
    ...discoveryFieldLine("Client registration", "registrationUrl", [a, b], hosts),
  ];
  if (lines.length === 0 && stableStringify(a ?? null) !== stableStringify(b ?? null))
    lines.push("Sign-in server changed");
  return lines;
}

/** One review line per changed sign-in field. Secrets are named, never shown. */
export function describeSignInChanges(before?: SurfaceSignIn, after?: SurfaceSignIn): string[] {
  const lines: string[] = [];
  const a = before?.oauth;
  const b = after?.oauth;
  const changed = (name: string, x?: string, y?: string): void => {
    if (x === y) return;
    lines.push(
      y === undefined
        ? `${name} removed`
        : x === undefined
          ? `${name} added (${y})`
          : `${name} changed (${x} → ${y})`
    );
  };
  changed("Sign-in client", a?.clientId, b?.clientId);
  changed("Token auth method", a?.tokenEndpointAuthMethod, b?.tokenEndpointAuthMethod);
  lines.push(...describeDiscoveryChanges(a?.discovery, b?.discovery));
  const scopes = (oauth?: MCPServerOAuthConfig): string[] => [
    ...(oauth?.baseScopes ?? []),
    ...(oauth?.defaultScopes ?? []),
  ];
  // Sets: scope lists are plugin-controlled and can be long.
  const [oldScopes, newScopes] = [new Set(scopes(a)), new Set(scopes(b))];
  const added = [...newScopes].filter((scope) => !oldScopes.has(scope));
  const removed = [...oldScopes].filter((scope) => !newScopes.has(scope));
  if (added.length + removed.length > 0)
    lines.push(
      `Scopes changed: ${[...added.map((x) => `+ ${x}`), ...removed.map((x) => `- ${x}`)].join(" ")}`
    );
  else if (
    stableStringify([a?.baseScopes ?? null, a?.defaultScopes ?? null]) !==
    stableStringify([b?.baseScopes ?? null, b?.defaultScopes ?? null])
  )
    lines.push("Scopes changed");
  changed("Resource", a?.resource, b?.resource);
  const [oldSecret, newSecret] = [before?.secretDigest, after?.secretDigest];
  if (oldSecret !== newSecret)
    lines.push(
      oldSecret === undefined
        ? "Client secret added"
        : newSecret === undefined
          ? "Client secret removed"
          : "Client secret changed"
    );
  return lines;
}

const LOGO_MAX_BYTES = 512 * 1024;
// No SVG: a data-URL <img> cannot run script, but raster-only keeps the
// renderer away from markup altogether. No GIF: OpenAI does not list it, and it
// animates (no unrequested UI animation); animated PNG/WebP are refused by header.
const LOGO_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * One manifest image as a data URL, or undefined (with a warning) when it is
 * missing, not a raster type, or refused by the reader or the header check.
 * SECURITY AUDIT: the image crosses to the renderer only as a data URL read
 * through the contained, capped reader (a symlink out of the plugin root fails
 * there); never a file path.
 */
async function readLogoDataUrl(
  rootPath: string,
  logoPath: string | undefined,
  label: string,
  warnings: string[]
): Promise<string | undefined> {
  if (logoPath === undefined) return undefined;
  const mime = getOwn(LOGO_MIME_BY_EXTENSION, path.extname(logoPath).toLowerCase());
  if (mime === undefined) {
    warnings.push(`${label} '${logoPath}' must be a PNG, JPEG or WebP image; ignoring`);
    return undefined;
  }
  try {
    // The contained reader also refuses a link into the staged clone's .git
    // (ensurePluginPathContained, #6161), so no separate check is needed here.
    const { bytes } = await readPluginFileWithinRootCapped({
      filePath: path.join(rootPath, logoPath),
      pluginRoot: rootPath,
      maxBytes: LOGO_MAX_BYTES,
      label,
    });
    // SECURITY AUDIT: bounded decoded size (a tiny compressed file can decode to
    // hundreds of MB in the renderer) and no animation, from the header alone.
    const refusal = checkLogoImage(bytes, mime);
    if (refusal !== null) throw new Error(refusal);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch (error) {
    warnings.push(`${label} '${logoPath}' cannot be shown: ${getErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * The light and dark image paths. OpenAI defines each dark field as the
 * variant of its own light field (`logoDark` of `logo`, `composerIconDark` of
 * `composerIcon`), so the dark path comes from the same family as the light
 * one: a dark composer icon must not replace the listing logo in dark themes.
 * Only with no light image at all does either dark field stand in.
 */
function logoPaths(info: OpenAIPluginInterface): { light?: string; dark?: string } {
  if (info.logo !== undefined) return { light: info.logo, dark: info.logoDark };
  if (info.composerIcon !== undefined) {
    return { light: info.composerIcon, dark: info.composerIconDark };
  }
  return { dark: info.logoDark ?? info.composerIconDark };
}

/**
 * UI projection of the OpenAI `interface`. The renderer picks the logo by
 * theme (`logoDark`/`composerIconDark` are OpenAI's dark-theme variants) and
 * falls back to the other one when a read fails. Budget: at most two
 * LOGO_MAX_BYTES images per plugin (about 1.4 MiB as base64). list() is a local
 * IPC call that Settings makes on open, the installed plugin count is the
 * user's, and nothing here reaches model context, so no shared cap is needed.
 */
async function interfaceSummary(
  plugin: Pick<AgentPluginInfo, "rootPath" | "openai">,
  warnings: string[]
): Promise<AgentPluginInterfaceSummary | undefined> {
  const info = plugin.openai?.interface;
  if (info === undefined) return undefined;
  const paths = logoPaths(info);
  const logoDataUrl = await readLogoDataUrl(plugin.rootPath, paths.light, "Plugin logo", warnings);
  const logoDarkDataUrl = await readLogoDataUrl(
    plugin.rootPath,
    paths.dark,
    "Plugin dark logo",
    warnings
  );
  return {
    displayName: info.displayName,
    developerName: info.developerName,
    shortDescription: info.shortDescription,
    ...(info.capabilities !== undefined ? { capabilities: info.capabilities } : {}),
    ...(info.websiteURL !== undefined ? { websiteURL: info.websiteURL } : {}),
    ...(info.privacyPolicyURL !== undefined ? { privacyPolicyURL: info.privacyPolicyURL } : {}),
    ...(info.termsOfServiceURL !== undefined ? { termsOfServiceURL: info.termsOfServiceURL } : {}),
    ...(info.supportURL !== undefined ? { supportURL: info.supportURL } : {}),
    ...(logoDataUrl !== undefined ? { logoDataUrl } : {}),
    ...(logoDarkDataUrl !== undefined ? { logoDarkDataUrl } : {}),
  };
}

function manifestSummary(manifest: AgentPluginManifest): AgentPluginManifestSummary {
  return {
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.author?.name !== undefined ? { authorName: manifest.author.name } : {}),
    ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
    ...(manifest.repository !== undefined ? { repository: manifest.repository } : {}),
    ...(manifest.license !== undefined ? { license: manifest.license } : {}),
  };
}

/**
 * The repository path of a staged plugin root, for manifest errors (discoverAgentPluginAt
 * `shownRoot`). The staged tree is the "Plugin folder", so errors name e.g.
 * `.codex-plugin/plugin.json`. A marketplace entry's folder sits below it, so its errors keep
 * entry-relative paths.
 */
function shownStagedRoot(
  source: Pick<AgentPluginGitSource, "subpath">,
  marketplace: MarketplaceEntryContext | undefined
): string | undefined {
  return marketplace === undefined ? source.subpath : undefined;
}

export class AgentPluginInstallService {
  private mcpOauthService: Pick<McpOauthService, "logout" | "credentialKey"> | undefined;
  private readonly containerDir: string;
  private readonly stagingRoot: string;
  private readonly registryFile: string;
  /** Serializes mutations (install/update/uninstall) so directory swaps and registry writes cannot interleave. */
  private mutationQueue: Promise<unknown> = Promise.resolve();
  /**
   * Staging paths owned by in-process operations. Stale reclamation must
   * never reap these: a just-renamed trash dir inherits the tree's OLD
   * mtime, so age alone can misclassify an active rollback copy as stale.
   */
  private readonly activeStagingPaths = new Set<string>();

  /** The single underlying recovery pass; timeout callers never start a competing pass. */
  private reconciliationWork: Promise<boolean> | undefined;
  /**
   * Latest bounded journal-reconciliation attempt, resolving to whether it
   * SUCCEEDED. Kicked off at construction because a session can serve agent
   * requests (whose global plugin discovery, MCP config, and hook loading scan
   * the container) without ever opening the Plugins section — an orphaned
   * promotion would load as an unmanaged plugin, hooks included, before
   * list()'s reconciliation ever ran. The discovery gate consumes the status:
   * `false` (timeout, unreadable registry, failed restore/quarantine)
   * suppresses the managed container from scans until a later attempt
   * succeeds. Never rejects (startup must not crash the app).
   */
  private reconciliationState: Promise<boolean>;
  /** The one startup sweep of approved copies (sweepApprovedCopiesAtStartup). */
  private startupApprovedCopiesSweep: Promise<void> | undefined;

  constructor(
    private readonly config: Config,
    private readonly deps: {
      /** Recycles running MCP servers whose config key starts with the given prefix. */
      mcpServerManager?: MCPServerManager;
      /** Revokes global plugin server enablement before uninstall commits. */
      mcpConfigService?: Pick<MCPConfigService, "pruneEnabledPluginServers">;
      /** Used to prune plugin server keys from per-workspace overrides on uninstall. */
      workspaceMcpOverridesService?: WorkspaceMcpOverridesService;
      /** Signs out plugin servers whose sign-in identity an update changes. */
      mcpOauthService?: Pick<McpOauthService, "logout" | "credentialKey">;
      /** Test override for the staged-clone checkout quota. */
      stagingQuota?: { maxBytes: number; maxFiles: number };
      /** Test override for the recovery wait bound. */
      reconciliationTimeoutMs?: number;
    }
  ) {
    assert(path.isAbsolute(config.rootDir), "AgentPluginInstallService: rootDir must be absolute");
    this.mcpOauthService = deps.mcpOauthService;
    this.containerDir = path.join(config.rootDir, "plugins");
    this.stagingRoot = path.join(config.rootDir, STAGING_DIR_NAME);
    this.registryFile = path.join(config.rootDir, PLUGIN_REGISTRY_FILE_NAME);
    // Journals only exist if the feature staged something (a missing staging
    // root makes this a single readdir). Failures retry on the next section open.
    this.reconciliationState = this.attemptReconcileJournals("startup");
    // Every global discovery consumer (MCP config, hooks, skills, workflows,
    // agents) funnels through discoverAgentPlugins; gate those scans on the
    // LATEST reconciliation attempt so an agent request cannot load an
    // orphaned tree while recovery is running — and cannot scan the managed
    // container at all while the latest attempt has FAILED (the journaled
    // tree may still be sitting in it). Health alone is not enough: a live
    // mutation (in this process or a sibling desktop/server process sharing
    // the same mux home) can overlap a scan, so keep the journal+epoch
    // bracket of the default gate and UNION health suppression onto it.
    setAgentPluginDiscoveryGate(async (containerPaths) => {
      // Serialize behind the latest recovery attempt BEFORE snapshotting the
      // journal bracket: recovery consumes journals, and reading them first
      // would suppress the very scan whose recovery just succeeded.
      const unhealthySuppression = (await this.reconciliationState) ? [] : [this.containerDir];
      // The startup pass (setMcpOauthService) is awaited, so the first request sees the plugins.
      await this.pendingSignOutReady;
      const bracket = await journalDerivedDiscoveryGate(containerPaths);
      // The bracket keeps the container closed while a sign-out is pending; start finishing it.
      this.startPendingSignOutPass({ retryNow: false });
      return {
        suppressed: [...new Set([...bracket.suppressed, ...unhealthySuppression])],
        confirm: async () => {
          const stillUnhealthy = (await this.reconciliationState) ? [] : [this.containerDir];
          return [...new Set([...(await bracket.confirm()), ...stillUnhealthy])];
        },
      };
    });
  }

  /**
   * Immediately mark reconciliation unhealthy for the discovery gate. Called
   * when an INLINE mutation path retains a journal for an unremovable tree in
   * the managed container: the next reconcileJournals run would report the
   * retained journal anyway, but the current process's health snapshot is
   * stale until then, and discovery must not load the orphan in the interim.
   */
  private markUnreconciled(): void {
    this.reconciliationState = Promise.resolve(false);
  }

  /**
   * Run reconcileJournals, mapping the outcome to a never-rejecting health
   * flag: false when it threw (unreadable registry) OR when any journal was
   * left unconsumed (failed restore/quarantine, unidentified target tree) —
   * both mean the managed container may hold unreconciled state.
   */
  /**
   * Crash recovery, then starts the pending sign-outs. Pending sign-outs do not make recovery
   * unhealthy: every discovery gate checks the record itself (containerHasPendingSignOuts).
   */
  private async recover(): Promise<boolean> {
    const allConsumed = await this.reconcileJournals();
    // Started, not awaited: a slow or failed sign-out must not latch journal health (a
    // timed-out recovery stores false until the next section open). The record is its own fence.
    this.startPendingSignOutPass({ retryNow: true });
    // Once per process, after a clean recovery (trees are then where the registry says), and not
    // awaited: the discovery gate must not wait for it.
    if (allConsumed) this.startupApprovedCopiesSweep ??= this.sweepApprovedCopiesAtStartup();
    return allConsumed;
  }

  private async attemptReconcileJournals(context: string): Promise<boolean> {
    let work = this.reconciliationWork;
    if (work === undefined) {
      const started = this.recover().then(
        (allConsumed) => {
          if (!allConsumed) {
            log.warn(`Plugin journal reconciliation left unresolved journals (${context})`);
          }
          return allConsumed;
        },
        (error: unknown) => {
          log.warn(`Plugin journal reconciliation failed (${context})`, {
            error: getErrorMessage(error),
          });
          return false;
        }
      );
      work = started.then((result) => {
        // Clear only this pass: a later attempt may already have installed a
        // successor promise by the time an old, delayed pass settles.
        if (this.reconciliationWork === work) {
          this.reconciliationWork = undefined;
        }
        return result;
      });
      this.reconciliationWork = work;
    }

    const timeoutMs = this.deps.reconciliationTimeoutMs ?? JOURNAL_RECONCILIATION_TIMEOUT_MS;
    const settled = await raceWithAbortAndTimeout(work, { timeoutMs });
    if (settled.kind === "ok") {
      return settled.value;
    }
    // The underlying pass remains the sole reconciliationWork. Discovery and
    // settings callers stop waiting and fail closed (managed container
    // suppressed); a later retry races the SAME pass instead of starting a
    // competing filesystem mutation while stalled storage may still recover.
    log.warn(`Plugin journal reconciliation timed out (${context})`, { timeoutMs });
    return false;
  }

  /**
   * Display path of the ACTIVE managed plugin container for UI copy. The
   * root is config-derived (canonically ~/.shux, possibly a custom or
   * legacy-compat root), so the UI must never hardcode it.
   */
  containerLocation(): string {
    return shortenHome(this.containerDir);
  }

  // ---------------------------------------------------------------------
  // Registry persistence (~/.mux/plugins.json)
  // ---------------------------------------------------------------------

  /**
   * The registry document as stored on disk: the top-level ENVELOPE (an
   * object that must hold a `plugins` array, and may hold future top-level
   * fields like a registry version) plus the raw entry list. Mutations
   * operate on the raw entries (matching by their `name` property) and write
   * the envelope back with only `plugins` replaced, so both unknown entry
   * fields and unknown top-level fields written by newer builds survive an
   * install/update/uninstall on this build (upgrade↔downgrade stays
   * lossless).
   *
   * A missing file is an empty registry; corrupted content — unparseable
   * JSON or a structurally invalid envelope like `{}` / `{"plugins": null}`
   * — is not. Reads ("lenient") degrade corruption to an empty list so the
   * section still renders (dirs show as unmanaged), but mutations ("strict")
   * must refuse: treating a corrupted file as empty would let the next
   * install rewrite it with a single entry, permanently orphaning every
   * previously managed install.
   */
  private readRegistryDocument(mode: "lenient" | "strict") {
    return readPluginRegistryDocument(this.registryFile, mode);
  }

  /**
   * Lenient-on-read: entries this build does not recognize degrade to
   * "unmanaged dirs" rather than errors in list views, but stay in the raw
   * file. Discovery independently fails closed on unreadable component imports. Name validation in the schema doubles as a filesystem-safety gate:
   * a traversal name like `..` must never reach targetPathFor.
   */
  private parseRegistryEntries(
    rawEntries: unknown[],
    mode: "lenient" | "strict" = "lenient"
  ): AgentPluginInstallEntry[] {
    // Strict (mutation) mode must detect duplicate names across RAW entries,
    // BEFORE schema filtering: a valid entry can collide with a same-name
    // entry this build cannot parse (written by a newer version). Raw
    // rewrites match by name — update() would patch and uninstall() would
    // delete BOTH rows, silently destroying the newer version's metadata
    // (upgrade↔downgrade rule).
    if (mode === "strict") {
      const seenRawNames = new Set<string>();
      for (const rawEntry of rawEntries) {
        const rawName = this.rawEntryName(rawEntry);
        if (rawName === undefined) {
          continue;
        }
        if (seenRawNames.has(rawName)) {
          throw new Error(
            `The plugin registry (${shortenHome(this.registryFile)}) contains duplicate entries for '${rawName}'. Repair the file, then retry.`
          );
        }
        seenRawNames.add(rawName);
      }
    }
    const entries: AgentPluginInstallEntry[] = [];
    const seenNames = new Set<string>();
    for (const rawEntry of rawEntries) {
      const parsed = AgentPluginInstallEntrySchema.safeParse(rawEntry);
      if (!parsed.success) {
        log.debug("Skipping unrecognized managed plugin registry entry (preserved on disk)", {
          entry: rawEntry,
          error: parsed.error.message,
        });
        continue;
      }
      // Duplicate names are corrupt identity: entry names map 1:1 to
      // container directories and instance IDs, and raw rewrites match by
      // name — a mutation would patch EVERY duplicate from the first entry's
      // source, silently rewriting the others. Mutations (strict) refuse;
      // views (lenient) keep the first (matching find()-based lookups).
      if (seenNames.has(parsed.data.name)) {
        if (mode === "strict") {
          throw new Error(
            `The plugin registry (${shortenHome(this.registryFile)}) contains duplicate entries for '${parsed.data.name}'. Repair the file, then retry.`
          );
        }
        log.warn("Ignoring duplicate managed plugin registry entry", { name: parsed.data.name });
        continue;
      }
      seenNames.add(parsed.data.name);
      entries.push(parsed.data);
    }
    return entries;
  }

  /**
   * In strict mode, an entry this build cannot parse (a newer version's
   * source kind, or corruption) is an error: callers like checkUpdates would
   * otherwise silently skip that managed install and report a false
   * "everything is up to date".
   */
  private async readRegistry(mode: "lenient" | "strict"): Promise<AgentPluginInstallEntry[]> {
    const { rawEntries } = await this.readRegistryDocument(mode);
    const entries = this.parseRegistryEntries(rawEntries, mode);
    if (mode === "strict" && entries.length !== rawEntries.length) {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) contains ${rawEntries.length - entries.length} entr${rawEntries.length - entries.length === 1 ? "y" : "ies"} this version cannot read (written by a newer version of Mux, or corrupted).`
      );
    }
    return entries;
  }

  /** `name` of a raw registry entry, for identity matching during raw rewrites. */
  private rawEntryName(rawEntry: unknown): string | undefined {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      return undefined;
    }
    const name = (rawEntry as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }

  /**
   * Atomic write that THROWS on failure (like Config.saveConfig since #4444)
   * so callers can roll back filesystem changes instead of
   * reporting success with an unpersisted registry. Takes the RAW envelope
   * and entry list so unrecognized top-level fields and entries are written
   * back verbatim (only `plugins` is replaced).
   */
  private async writeRegistry(
    envelope: Record<string, unknown>,
    rawEntries: unknown[]
  ): Promise<void> {
    await writeFileAtomic(
      this.registryFile,
      JSON.stringify({ ...envelope, plugins: rawEntries }, null, 2),
      "utf-8"
    );
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // In-process queue first (cheap), then the cross-process lock: a second
    // process sharing rootDir must not interleave its read-modify-write of
    // plugins.json (or its directory moves) with ours.
    return this.runQueued(() => this.withMutationLock(fn));
  }

  /** This process's mutation queue only: `fn` takes the cross-process lock itself if it must. */
  private runQueued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    // The caller gets a rejection through `run`; the queue only orders the next mutation.
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquirePluginMutationLock(this.config.rootDir, {
      timeoutMs: MUTATION_LOCK_ACQUIRE_TIMEOUT_MS,
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /**
   * Lexical install location — the identity `computePluginInstanceId` hashes
   * for global plugins. The name grammar excludes `.`/`..`/separators, so a
   * malformed registry entry can never resolve outside the container (this
   * path is deleted recursively on uninstall).
   */
  private targetPathFor(name: string): string {
    assert(isValidAgentPluginName(name), `invalid plugin name: ${JSON.stringify(name)}`);
    const target = path.join(this.containerDir, name);
    assert(
      path.dirname(target) === this.containerDir,
      "targetPathFor: resolved path must be an immediate child of the container"
    );
    return target;
  }

  private instanceIdFor(name: string): string {
    return computePluginInstanceId(this.targetPathFor(name));
  }

  // ---------------------------------------------------------------------
  // Staging helpers
  // ---------------------------------------------------------------------

  /**
   * Staging lives under ~/.mux (same filesystem as the container) so promote
   * is a plain rename, and outside ~/.mux/plugins so a staged clone can never
   * be discovered as an installed plugin.
   */
  private async createStagingDir(): Promise<string> {
    await fsPromises.mkdir(this.stagingRoot, { recursive: true });
    await this.purgeStaleStaging();
    const dir = await fsPromises.mkdtemp(path.join(this.stagingRoot, "stage-"));
    this.activeStagingPaths.add(dir);
    return dir;
  }

  /**
   * Rename `sourcePath` into the staging root under in-process ownership so
   * stale reclamation cannot reap it mid-operation. Trash names embed a
   * Date.now() stamp because the rename preserves the tree's OLD mtime — an
   * installed tree older than the stale threshold would otherwise be reaped
   * as "stale" the moment it lands in staging, deleting an active rollback
   * copy out from under uninstall/update.
   */
  private async renameIntoStaging(sourcePath: string, trashDir: string): Promise<void> {
    this.activeStagingPaths.add(trashDir);
    try {
      await fsPromises.rename(sourcePath, trashDir);
    } catch (error) {
      this.activeStagingPaths.delete(trashDir);
      throw error;
    }
  }

  /** Best-effort reclaim of staging dirs orphaned by crashes. */
  private async purgeStaleStaging(): Promise<void> {
    try {
      const now = Date.now();
      const entries = await fsPromises.readdir(this.stagingRoot);
      // Journals pin the staged trash dirs they reference: reclaiming a
      // journaled rollback copy by age before reconcileJournals runs would
      // turn a restorable interrupted uninstall/update into data loss. An
      // UNREADABLE journal pins everything it could reference: its staged
      // paths are unknown, so all trash entries stay until it is repaired.
      const journalProtected = new Set<string>();
      let allJournalsReadable = true;
      for (const entry of entries) {
        if (!isJournalName(entry)) {
          continue;
        }
        try {
          const doc = await this.readJournalDocument(path.join(this.stagingRoot, entry));
          for (const field of ["trashDir", "dataTrashDir"]) {
            const staged = this.journalStagedPath(doc, field);
            if (staged !== undefined) {
              journalProtected.add(staged);
            }
          }
        } catch {
          allJournalsReadable = false;
        }
      }
      for (const entry of entries) {
        const entryPath = path.join(this.stagingRoot, entry);
        // Never touch paths an in-process operation still owns, journals
        // (their lifecycle belongs to reconcileJournals), trash dirs a
        // journal still references (or MIGHT reference, when a journal is
        // unreadable), or the durable staging-root state files: the
        // mutation-epoch token must survive (a scan bracket comparing tokens
        // across a deletion would misread every managed plugin as mutated)
        // and the cross-process lock belongs to its holder.
        if (
          this.activeStagingPaths.has(entryPath) ||
          isJournalName(entry) ||
          journalProtected.has(entryPath) ||
          entry === MUTATION_EPOCH_FILE ||
          entry === MUTATION_LOCK_FILE ||
          (!allJournalsReadable && entry.startsWith("trash"))
        ) {
          continue;
        }
        try {
          // Trash names embed their staging time; renames preserve the
          // tree's old mtime, which says nothing about staging age.
          const stampMatch = /^trash(?:-data)?-(\d+)-/.exec(entry);
          const stagedAt =
            stampMatch !== null
              ? Number(stampMatch[1])
              : (await fsPromises.stat(entryPath)).mtimeMs;
          if (now - stagedAt > STALE_STAGING_MAX_AGE_MS) {
            await fsPromises.rm(entryPath, { recursive: true, force: true });
          }
        } catch {
          // Entry vanished or is unreadable — skip.
        }
      }
    } catch {
      // Missing staging root is fine.
    }
  }

  private async removeDir(dirPath: string): Promise<void> {
    await fsPromises.rm(dirPath, { recursive: true, force: true });
    this.activeStagingPaths.delete(dirPath);
  }

  // ---------------------------------------------------------------------
  // Git plumbing
  // ---------------------------------------------------------------------

  /**
   * Resolve what a preview/install/update should check out, via `git
   * ls-remote` (no fetch). When a branch and a tag share the ref name,
   * `preferredRefType` (a tracked entry's stored kind) wins — a remote
   * ADDING a same-name branch must not make a still-valid tracked tag look
   * like it changed kind. New previews without a stored kind stay
   * branch-first.
   */
  private async resolveRemoteRef(
    url: string,
    ref: string | undefined,
    preferredRefType?: "branch" | "tag"
  ): Promise<ResolvedRemoteRef> {
    if (ref !== undefined && isFullCommitSha(ref)) {
      return { ref: ref.toLowerCase(), refType: "commit", sha: ref.toLowerCase() };
    }
    if (ref === undefined) {
      // Remote default branch: `ls-remote --symref <url> HEAD` prints
      //   ref: refs/heads/<default>\tHEAD
      //   <sha>\tHEAD
      const output = await this.lsRemote(url, ["--symref", url, "HEAD"]);
      const symrefMatch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(output);
      const shaMatch = /^([0-9a-f]{40})\s+HEAD$/m.exec(output);
      if (!symrefMatch || !shaMatch) {
        throw new Error(`Could not determine the default branch of ${url}.`);
      }
      return { ref: symrefMatch[1], refType: "branch", sha: shaMatch[1] };
    }

    if (/^[0-9a-f]{7,39}$/i.test(ref)) {
      // A short SHA can't be fetched shallowly and can't be resolved by ls-remote.
      throw new Error(
        `'${ref}' looks like an abbreviated commit SHA. Use the full 40-character SHA, a branch, or a tag.`
      );
    }

    const output = await this.lsRemote(url, [
      url,
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      `refs/tags/${ref}^{}`,
    ]);
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let branchSha: string | undefined;
    let tagSha: string | undefined;
    let peeledTagSha: string | undefined;
    for (const line of lines) {
      const [sha, refName] = line.split(/\s+/);
      if (!sha || !refName) continue;
      if (refName === `refs/heads/${ref}`) branchSha = sha;
      else if (refName === `refs/tags/${ref}^{}`) peeledTagSha = sha;
      else if (refName === `refs/tags/${ref}`) tagSha = sha;
    }

    // Annotated tags list both the tag object and the peeled commit (^{});
    // lockedSha must be the commit so it can be compared against `rev-parse HEAD`.
    const resolvedTagSha = peeledTagSha ?? tagSha;
    if (preferredRefType === "tag" && resolvedTagSha !== undefined) {
      return { ref, refType: "tag", sha: resolvedTagSha };
    }
    if (branchSha !== undefined) {
      return { ref, refType: "branch", sha: branchSha };
    }
    if (resolvedTagSha !== undefined) {
      return { ref, refType: "tag", sha: resolvedTagSha };
    }
    throw new Error(`Ref '${ref}' was not found on the remote (no matching branch or tag).`);
  }

  private async lsRemote(url: string, args: string[]): Promise<string> {
    try {
      return await runGit(["ls-remote", ...args], { timeoutMs: LS_REMOTE_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`Could not reach ${url}: ${getErrorMessage(error)}`);
    }
  }

  private stagingQuota(): { maxBytes: number; maxFiles: number } {
    return (
      this.deps.stagingQuota ?? { maxBytes: STAGED_TREE_MAX_BYTES, maxFiles: STAGED_TREE_MAX_FILES }
    );
  }

  /** The records a file review compares, with the bytes that their hash read. */
  private fileReviewRecords(dir: string): Promise<PluginTreeRecord[]> {
    return listPluginTreeRecords(dir, this.stagingQuota(), {
      keepBytesUpTo: FILE_REVIEW_TEXT_MAX_BYTES,
      skipRootGit: true,
    });
  }

  /**
   * The file review rows of a staged plugin with a runnable Cursor command hook; none for any
   * other plugin. D30: an installed tree (or none) without such a hook never had a file review,
   * so the staged tree is compared with the empty tree and every file is listed.
   */
  private async fileReviewChanges(
    staged: AgentPluginInfo,
    installed: AgentPluginInfo | null
  ): Promise<AgentPluginCapabilityChange[]> {
    if (!runsCursorCommands((await loadPluginHooks(staged)).hooks)) return [];
    const reviewed =
      installed !== null && runsCursorCommands((await loadPluginHooks(installed)).hooks);
    return fileReviewRows(
      reviewed ? await this.fileReviewRecords(installed.rootPath) : null,
      await this.fileReviewRecords(staged.rootPath)
    );
  }

  /**
   * During-clone disk bound for a staging dir: checkout + pack live in it, so
   * allow twice the checkout quota (bytes AND file count — loose objects can
   * mirror the checkout's file count). The watchdog aborts git mid-transfer —
   * the post-clone assertStagedTreeWithinQuota can only reject a tree git
   * already fully materialized on disk.
   */
  private cloneDiskQuota(dir: string): { dir: string; maxBytes: number; maxFiles: number } {
    const quota = this.stagingQuota();
    return { dir, maxBytes: quota.maxBytes * 2, maxFiles: quota.maxFiles * 2 };
  }

  /**
   * Enforce the staged-checkout quota (bytes + entry count, .git excluded,
   * symlinks not followed). Directories count too: each consumes an inode
   * and filesystem metadata, and repeated git tree objects can amplify a
   * tiny pack into thousands of them. Runs immediately after every staged
   * clone so an oversized tree is deleted by the caller's error path before
   * any validation reads it.
   *
   * The same walk validates SYMLINK final-path semantics: component checks
   * (consent preview, update capability comparison) resolve links against
   * the STAGED location, but the tree executes from the promoted location —
   * a relative link that escapes the staged root, or a link whose target
   * does not exist yet, can resolve to something entirely different after
   * promotion (e.g. `hooks.js -> ../../plugins/<name>/payload.js` resolves
   * to nothing in staging but to an executable hook inside the live root
   * post-install, skipping consent). Links that RESOLVE INSIDE the staged
   * root keep their meaning across the promote rename. Absolute links keep
   * their target STRING, but their CONTAINMENT can still flip: a target
   * under the managed plugins container — this plugin's own final install
   * path — resolves into the CURRENTLY INSTALLED tree during an update's
   * staging (outside the staged root, so component discovery excludes it
   * from the consent preview and the capability comparison) yet inside the
   * promoted root after the swap, auto-loading undisclosed content. Links
   * into the container are therefore rejected, by raw target and by
   * resolution; other absolute links keep their meaning and stay subject to
   * runtime escape containment. Everything else is rejected before any
   * commit.
   */
  private async assertStagedTreeWithinQuota(dir: string): Promise<void> {
    const quota = this.stagingQuota();
    const rootReal = await fsPromises.realpath(dir);
    // Both forms of the container path: the raw-target check must catch the
    // guessable lexical path even when nothing exists there yet, and the
    // resolved check must catch realpath-equivalent routes to it.
    const containerReal = await fsPromises
      .realpath(this.containerDir)
      .catch(() => this.containerDir);
    const withinContainer = (candidate: string): boolean =>
      [this.containerDir, containerReal].some(
        (container) => candidate === container || candidate.startsWith(container + path.sep)
      );
    let bytes = 0;
    let entryCount = 0;
    const pending: string[] = [dir];
    while (pending.length > 0) {
      const current = pending.pop();
      assert(current !== undefined, "assertStagedTreeWithinQuota: queue underflow");
      for (const entry of await fsPromises.readdir(current, { withFileTypes: true })) {
        if (entry.name === ".git" && current === dir) {
          continue;
        }
        const entryPath = path.join(current, entry.name);
        entryCount += 1;
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile()) {
          const stat = await fsPromises.lstat(entryPath);
          bytes += stat.size;
        } else if (entry.isSymbolicLink()) {
          const relative = path.relative(dir, entryPath);
          const resolvedTarget = await fsPromises.realpath(entryPath).catch(() => undefined);
          if (resolvedTarget === undefined) {
            throw new Error(
              `The repository ships a symbolic link that does not resolve (${relative}). Its target could appear at the install location AFTER the consent preview validated the tree, so unresolvable links are rejected.`
            );
          }
          const rawTarget = await fsPromises.readlink(entryPath);
          const withinStagedRoot =
            resolvedTarget === rootReal || resolvedTarget.startsWith(rootReal + path.sep);
          if (!path.isAbsolute(rawTarget) && !withinStagedRoot) {
            throw new Error(
              `The repository ships a relative symbolic link that escapes the plugin folder (${relative}). Such links resolve differently after install than during the consent preview, so they are rejected.`
            );
          }
          if (
            path.isAbsolute(rawTarget) &&
            !withinStagedRoot &&
            (withinContainer(path.resolve(rawTarget)) || withinContainer(resolvedTarget))
          ) {
            throw new Error(
              `The repository ships an absolute symbolic link into the managed plugins directory (${relative}). Such links resolve differently after install than during the consent preview, so they are rejected.`
            );
          }
        }
        if (entryCount > quota.maxFiles || bytes > quota.maxBytes) {
          throw new Error(
            `The repository is too large to install as a plugin (limit: ${quota.maxFiles} files, ${Math.floor(quota.maxBytes / (1024 * 1024))} MiB).`
          );
        }
      }
    }
  }

  /**
   * Shallow-clone `resolved` into a fresh staging dir; returns { dir, sha }
   * with sha = HEAD. With `subpath`, the clone is partial + sparse and the
   * returned dir is ONLY that folder (see extractSubpath).
   */
  private async cloneResolved(
    url: string,
    resolved: ResolvedRemoteRef,
    subpath?: string
  ): Promise<{ dir: string; sha: string }> {
    const dir = await this.createStagingDir();
    try {
      if (resolved.refType === "commit") {
        await this.fetchExactSha(url, resolved.sha, dir, subpath);
      } else {
        await this.cloneRef(url, resolved.ref, dir, subpath);
      }
      const sha = (await runGit(["-C", dir, "rev-parse", "HEAD"])).trim();
      assert(isFullCommitSha(sha), "cloneResolved: rev-parse HEAD must be a full SHA");
      return { dir: await this.stagedPluginRoot(dir, subpath, url, sha), sha };
    } catch (error) {
      await this.removeDir(dir);
      // A missing or non-folder subpath is a clear user-facing error of its
      // own, not a git failure: keep it out of the "Failed to clone" wrapping.
      if (error instanceof AgentPluginSubpathError) {
        throw error;
      }
      throw new Error(`Failed to clone ${url}: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Clone exactly `sha` (what the user consented to). Prefers a direct SHA
   * fetch (GitHub allows it); falls back to cloning the tracking ref and
   * verifying HEAD still matches, so a remote that moved between preview and
   * install fails loudly instead of installing unreviewed content. A
   * `source.subpath` stages only that folder (see extractSubpath).
   */
  private async cloneExactSha(
    source: AgentPluginGitSource,
    sha: string,
    options?: { readMarketplace: true }
  ): Promise<{ dir: string; marketplaceJson: string | undefined }> {
    const subpath = source.subpath;
    const dir = await this.createStagingDir();
    try {
      try {
        await this.fetchExactSha(source.url, sha, dir, subpath);
      } catch (error) {
        // The commit WAS fetched; its tree just lacks the folder. The
        // tracking-ref clone below would only reach the same verdict.
        if (error instanceof AgentPluginSubpathError) {
          throw error;
        }
        if (source.refType === "commit") {
          throw new Error(`Could not fetch commit ${sha} from ${source.url}.`);
        }
        // fetchExactSha left an initialized repo behind; git clone refuses a
        // non-empty destination, so reset the staging dir before falling back.
        await this.removeDir(dir);
        await fsPromises.mkdir(dir, { recursive: true });
        this.activeStagingPaths.add(dir);
        await this.cloneRef(source.url, source.ref, dir, subpath);
      }
      const head = (await runGit(["-C", dir, "rev-parse", "HEAD"])).trim();
      if (head !== sha) {
        throw new Error(
          `The remote moved since the preview (expected ${sha.slice(0, 12)}, got ${head.slice(0, 12)}). Run the preview again.`
        );
      }
      // Before stagedPluginRoot: a subpath clone keeps only the plugin folder, and the
      // marketplace file sits at the repository root.
      const marketplaceJson =
        options?.readMarketplace === true
          ? await this.readMarketplaceAtCommit(dir, sha)
          : undefined;
      return { dir: await this.stagedPluginRoot(dir, subpath, source.url, sha), marketplaceJson };
    } catch (error) {
      await this.removeDir(dir);
      throw error instanceof Error ? error : new Error(getErrorMessage(error));
    }
  }

  /**
   * `.claude-plugin/marketplace.json` at `sha` in a staging clone (which may be partial and
   * sparse), or undefined when the commit has none. Only a regular file counts: a symlink blob
   * would name another path. The blob size is checked before its content is read, and a lazy
   * fetch of the blob runs under the clone's disk quota.
   */
  private async readMarketplaceAtCommit(dir: string, sha: string): Promise<string | undefined> {
    const listing = await runGit([
      "--literal-pathspecs",
      "-C",
      dir,
      "ls-tree",
      "-z",
      sha,
      "--",
      CLAUDE_MARKETPLACE_RELATIVE_PATH,
    ]);
    const record = listing
      .split("\0")
      .map((line) => /^(\d{6}) blob ([0-9a-f]+)\t([\s\S]*)$/.exec(line))
      .find((match) => match?.[3] === CLAUDE_MARKETPLACE_RELATIVE_PATH);
    if (record == null) return undefined;
    const [, mode, oid] = record;
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(`${CLAUDE_MARKETPLACE_RELATIVE_PATH} is not a regular file.`);
    }
    const diskQuota = this.cloneDiskQuota(dir);
    const size = Number((await runGit(["-C", dir, "cat-file", "-s", oid], { diskQuota })).trim());
    if (!Number.isSafeInteger(size) || size > MAX_CLAUDE_MARKETPLACE_BYTES) {
      throw new Error(
        `${CLAUDE_MARKETPLACE_RELATIVE_PATH} is larger than ${MAX_CLAUDE_MARKETPLACE_BYTES / (1024 * 1024)} MiB.`
      );
    }
    return runGit(["-C", dir, "cat-file", "blob", oid], { diskQuota });
  }

  /**
   * cloneExactSha for an install or update, plus the context of marketplace entry `entryName`
   * (a relative entry whose plugin.json Xum writes), read from marketplace.json at `sha`.
   */
  private async cloneWithEntry(
    source: AgentPluginGitSource,
    sha: string,
    entryName: string | undefined
  ): Promise<{ stagedDir: string; marketplace: MarketplaceEntryContext | undefined }> {
    if (entryName === undefined) {
      return { stagedDir: (await this.cloneExactSha(source, sha)).dir, marketplace: undefined };
    }
    const { dir, marketplaceJson } = await this.cloneExactSha(source, sha, {
      readMarketplace: true,
    });
    try {
      return {
        stagedDir: dir,
        marketplace: relativeEntryContext(marketplaceJson, entryName, source),
      };
    } catch (error) {
      await this.removeDir(dir);
      throw error;
    }
  }

  /**
   * The staged plugin root of a verified clone: the whole checkout for a
   * root install, or only `subpath` (see extractSubpath). Both run the
   * staged-tree quota and symlink checks on the tree that gets installed.
   */
  private async stagedPluginRoot(
    dir: string,
    subpath: string | undefined,
    url: string,
    sha: string
  ): Promise<string> {
    if (subpath === undefined) {
      await this.assertStagedTreeWithinQuota(dir);
      return dir;
    }
    return this.extractSubpath(dir, subpath, url, sha);
  }

  /**
   * Shallow-clone branch or tag `ref`. With `subpath`, the clone is partial
   * and sparse and gets narrowed to the folder; callers still verify HEAD
   * against the SHA they expect before using the tree.
   */
  private async cloneRef(url: string, ref: string, dir: string, subpath?: string): Promise<void> {
    await runGit(
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        ...sparseCloneFlags(subpath, url),
        "--branch",
        ref,
        "-c",
        "advice.detachedHead=false",
        url,
        dir,
      ],
      { diskQuota: this.cloneDiskQuota(dir) }
    );
    await this.narrowToSubpath(dir, "HEAD", subpath, url);
    if (subpath !== undefined) {
      // The clone ran with --no-checkout: materialize only the sparse folder.
      await runGit(["-C", dir, "checkout", "--quiet", "HEAD"], {
        diskQuota: this.cloneDiskQuota(dir),
      });
    }
  }

  private async fetchExactSha(
    url: string,
    sha: string,
    dir: string,
    subpath?: string
  ): Promise<void> {
    const diskQuota = this.cloneDiskQuota(dir);
    await runGit(["init", "--quiet", dir]);
    await runGit(["-C", dir, "remote", "add", "origin", url]);
    // `init` + `fetch --filter` configures the promisor remote on its own, so
    // the sparse checkout below can lazy-fetch just the subpath's blobs.
    await runGit(
      ["-C", dir, "fetch", "--depth", "1", ...partialFetchFlags(subpath, url), "origin", sha],
      { diskQuota }
    );
    // Must precede the checkout: a full checkout would materialize (and
    // lazy-fetch) the whole monorepo before narrowing.
    await this.narrowToSubpath(dir, "FETCH_HEAD", subpath, url);
    await runGit(
      ["-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"],
      { diskQuota }
    );
  }

  /**
   * Check that every level of `subpath` is a real folder in `rev`, then
   * narrow the staging clone's sparse checkout to exactly that folder.
   *
   * SECURITY: each level must be a git tree object (mode 040000), checked
   * BEFORE any subpath blob is fetched. `ls-tree` compares exact names, which
   * also defeats case-insensitive filesystem matches (`Pstack` vs `pstack`).
   * Registry entries and direct API sources never passed the parser, so the
   * subpath is re-validated here.
   */
  private async narrowToSubpath(
    dir: string,
    rev: "HEAD" | "FETCH_HEAD",
    subpath: string | undefined,
    url: string
  ): Promise<void> {
    if (subpath === undefined) {
      return;
    }
    assertNormalizedSubpath(subpath);
    const sha = (await runGit(["-C", dir, "rev-parse", rev])).trim();
    const segments = subpath.split("/");
    for (let depth = 1; depth <= segments.length; depth++) {
      const prefix = segments.slice(0, depth).join("/");
      // -z: NUL-terminated, unquoted names. --literal-pathspecs: no `:(magic)`.
      const output = await runGit([
        "--literal-pathspecs",
        "-C",
        dir,
        "ls-tree",
        "-z",
        rev,
        "--",
        prefix,
      ]);
      const mode = lsTreeEntryMode(output, prefix);
      if (mode === undefined) {
        throw new AgentPluginSubpathError(
          `'${subpath}' does not exist in ${url} at ${sha.slice(0, 12)}. The plugin folder may have moved or been removed upstream.`
        );
      }
      if (mode !== "040000") {
        throw subpathNotAFolder(subpath, url, prefix, NON_FOLDER_GIT_MODE_KINDS[mode] ?? "a file");
      }
    }
    // Non-cone pattern `/<subpath>/`: cone mode would also check out every
    // file at the repository root and in each parent folder, and those count
    // toward the clone quota. The pattern is literal: normalization rejects
    // every gitignore special (`* ? [ ] \ ! #`, outer whitespace).
    await runGit(["-C", dir, "sparse-checkout", "set", "--no-cone", "--", `/${subpath}/`], {
      diskQuota: this.cloneDiskQuota(dir),
    });
  }

  /**
   * Turn a sparse monorepo clone into a staged plugin root that holds ONLY
   * `subpath` (already checked by narrowToSubpath). Every later step
   * (validation, consent preview, update capability diff, promote,
   * receipts) treats the staged dir as the plugin root, so consent and
   * update reviews cover exactly this folder: upstream commits that only
   * touch files outside it stage an identical tree and need no consent.
   *
   * The lstat walk on the checkout is a second guard behind the git tree
   * check. The quota/symlink walk runs on the EXTRACTED dir after the clone
   * is gone, so a relative link that escapes the subtree (even if it stays
   * inside the repo) is rejected like a link escaping the repo root.
   * Always consumes `cloneDir`: it is removed on every path.
   */
  private async extractSubpath(
    cloneDir: string,
    subpath: string,
    url: string,
    sha: string
  ): Promise<string> {
    const pluginDir = `${cloneDir}-plugin`;
    try {
      const segments = subpath.split("/");
      for (let depth = 1; depth <= segments.length; depth++) {
        const prefix = segments.slice(0, depth).join("/");
        const stat = await fsPromises.lstat(path.join(cloneDir, prefix)).catch(() => undefined);
        if (stat === undefined) {
          throw new AgentPluginSubpathError(
            `'${subpath}' was not checked out from ${url} at ${sha.slice(0, 12)}. Try again.`
          );
        }
        if (!stat.isDirectory()) {
          throw subpathNotAFolder(
            subpath,
            url,
            prefix,
            stat.isSymbolicLink() ? "a symbolic link" : "a file"
          );
        }
      }
      await this.renameIntoStaging(path.join(cloneDir, subpath), pluginDir);
    } catch (error) {
      await this.removeDir(cloneDir);
      throw error;
    }
    try {
      // The clone goes first: the symlink check must not resolve into it.
      await this.removeDir(cloneDir);
      await this.assertStagedTreeWithinQuota(pluginDir);
      return pluginDir;
    } catch (error) {
      // The caller only knows cloneDir, so pluginDir must not outlive this
      // failure. If even its removal fails (e.g. a Windows file lock), drop
      // the in-process claim so stale-staging reclamation can reap it later.
      await this.removeDir(pluginDir).catch(() => this.activeStagingPaths.delete(pluginDir));
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Staged-clone validation + preview assembly
  // ---------------------------------------------------------------------

  /**
   * Pick the install method (installMethods.ts), write the generated plugin.json of a `skills`
   * or marketplace-entry install, then run the exact runtime validation (manifest + component
   * discovery) against the staged clone. Throws user-facing errors for non-plugins. `marketplace`:
   * the staged tree is the folder of that marketplace entry (entryInstallMethods).
   */
  private async validateStagedClone(
    stagedDir: string,
    source: Pick<AgentPluginGitSource, "url" | "subpath">,
    request: InstallMethodRequest,
    marketplace?: MarketplaceEntryContext
  ): Promise<{
    plugin: AgentPluginInfo;
    warnings: string[];
    method: AgentPluginInstallMethod;
    methods: AgentPluginInstallMethod[];
    skillsCliSkills: string[];
  }> {
    // Every manifest candidate, and the generated plugin.json, lives in the staged tree the
    // consent receipt hashes.
    const detected = await detectInstallMethods(stagedDir);
    const choice = await chooseStagedMethod(stagedDir, detected, request, source, marketplace);
    const method = choice.method;

    // The crash-recovery marker name is RESERVED: install/update write a
    // nonce file at this path just before their promote rename, which would
    // silently replace repository-shipped content (and the commit path then
    // deletes it), leaving the installed tree different from the consented
    // commit. Reject up front instead of corrupting the plugin. lstat, not
    // access: a DANGLING symlink at this path reads as "absent" to
    // access-style checks, and the later nonce writeFile would then follow
    // the attacker-controlled target OUTSIDE the staged tree (e.g. creating
    // ../../plugins.json with nonce content).
    const markerEntry = await fsPromises
      .lstat(path.join(stagedDir, PROMOTION_MARKER_FILE))
      .catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
    if (markerEntry !== undefined) {
      throw new Error(
        `The repository contains a reserved file name (${PROMOTION_MARKER_FILE}) used by the installer's crash recovery. Remove or rename it upstream to install this plugin.`
      );
    }

    // After the marker check, so a refused tree never gets a generated file.
    const generatedWarnings = generatesManifest(method)
      ? await writeGeneratedManifest(stagedDir, method, source, marketplace)
      : [];
    const { plugin, diagnostics } = await discoverAgentPluginAt({
      pluginDir: stagedDir,
      scope: "global",
      shownRoot: shownStagedRoot(source, marketplace),
    });
    if (!plugin) {
      const reasons = diagnostics.map((d) => d.message);
      const problem =
        reasons.length > 0 ? `Invalid plugin: ${reasons.join("; ")}` : "Invalid plugin manifest.";
      // A preview without a method must still reach the "Install as" choice: when the first
      // method's manifest is invalid (a broken .claude-plugin/plugin.json next to valid skill
      // folders), preview the next method and name the problem. No file was written: of a
      // repository's methods only `skills` generates one, and it is always the last method.
      // A marketplace entry has its own methods (entryInstallMethods) and gets no fallback.
      const next =
        marketplace === undefined ? choice.methods[choice.methods.indexOf(method) + 1] : undefined;
      if (request.mode === "first" && next !== undefined) {
        assert(!generatesManifest(method), "validateStagedClone: a generated manifest is last");
        const fallback = await this.validateStagedClone(stagedDir, source, {
          mode: "exact",
          method: next,
        });
        return {
          ...fallback,
          warnings: [`${methodLabel(method)}: ${problem}`, ...fallback.warnings],
        };
      }
      throw new Error(problem);
    }
    return {
      plugin,
      warnings: [...choice.warnings, ...generatedWarnings, ...diagnostics.map((d) => d.message)],
      method,
      methods: choice.methods,
      skillsCliSkills: await this.acceptedSkillsCliNames(
        stagedDir,
        detected.skillsRoots,
        choice.skillsCliSkills
      ),
    };
  }

  /**
   * The Skills CLI names whose SKILL.md the preview accepts (collectSkills): the CLI would copy
   * a rejected skill, for example one with a description over the limit, but Xum never loads it.
   */
  private async acceptedSkillsCliNames(
    stagedDir: string,
    roots: SkillsPackageRoot[],
    names: string[]
  ): Promise<string[]> {
    if (names.length === 0) return names;
    // A root SKILL.md makes the repository one skill, and its frontmatter name
    // (skillsCliSkillNames) is then the only name. The other roots never use pluginName. A skill
    // whose frontmatter name is not its folder name drops out here: Xum knows it by the folder.
    const accepted = await this.acceptedSkillNames(stagedDir, {
      declared: roots.map((root) => root.root),
      pluginName: names[0],
    });
    return names.filter((name) => accepted.has(name));
  }

  /** The skills that the preview accepts from a manifest `skills` value in `pluginDir`. */
  private async acceptedSkillNames(
    pluginDir: string,
    skills: { declared: string | string[] | undefined; pluginName: string }
  ): Promise<Set<string>> {
    const rootPath = await fsPromises.realpath(pluginDir);
    const skillsDirs = await resolveDeclaredSkillsRoots({ pluginDir: rootPath, ...skills });
    // Warnings belong to a preview of these skills, not to this count.
    const collected = await this.collectSkillsFromRoots({ rootPath, skillsDirs }, []);
    return new Set(collected.map((skill) => skill.name));
  }

  /**
   * Executable hooks.js disclosure for the consent preview: hooks load
   * automatically before request assembly and can observe/rewrite/block tool
   * calls, so installing one without disclosure would consent to less than
   * what activates. toolGrants mirrors resolvePluginHookGrants — the exact
   * grants the runtime will honor.
   */
  private collectHook(
    plugin: Pick<AgentPluginInfo, "rootPath" | "hooksPath" | "manifest">
  ): AgentPluginPreviewHook | undefined {
    if (plugin.hooksPath === undefined) {
      return undefined;
    }
    const grants = resolvePluginHookGrants(plugin.manifest);
    assert(grants.bridgeTools.allow !== "all", "plugin hook grants must enumerate tools");
    return {
      path: path.relative(plugin.rootPath, plugin.hooksPath),
      toolGrants: [...grants.bridgeTools.allow],
    };
  }

  /**
   * Security-relevant capability surface of a plugin tree, mirroring what the
   * install consent preview disclosed:
   * - the auto-loading hook (entry path + tool grants) and MCP servers
   *   (transport + exact argv/env/url, root-path-normalized so staged and
   *   installed trees compare equal) — any change is gated, because both
   *   auto-execute behind stable identities;
   * - skill advertisements (name + description): these are NOT inert — every
   *   request interpolates them into the model-visible skill index
   *   (agent_skill_read's tool description), so a new or reworded skill can
   *   steer the agent without any user action;
   * - agent, workflow, and slash-command NAMES: the preview consented to a
   *   specific component set, so additions are gated. Their bodies were never
   *   part of the preview (they load on explicit invocation), so content
   *   changes ride the normal tree replacement.
   */
  private async capabilitySurface(
    plugin: AgentPluginInfo,
    instanceId: string,
    finalTargetPath: string,
    /** Receives component-loader diagnostics (skills that will not load, mcp.json problems). */
    warnings: string[]
  ): Promise<{
    hook: AgentPluginPreviewHook | undefined;
    /** serverName → { fingerprint (compared), display (shown in the update review), remote sign-in }. */
    servers: Map<string, SurfaceServer>;
    /**
     * skillName → { fingerprint (the advertisement), consentFingerprint (path + frontmatter,
     * compared), display (the advertisement as the model sees it) }.
     */
    skills: Map<string, SurfaceSkill>;
    /** agent ID → consent view (#6629): any frontmatter or file name change is a change. */
    agents: Map<string, SurfaceWhole>;
    /** IDs that two agent files claim: such an agent does not load (#6629). */
    ambiguousAgents: Set<string>;
    /** file → consent view (#6629): any byte change of a script is a change. */
    workflows: Map<string, SurfaceWhole>;
    /** name → consent view (#6629): the expansion is what the command inserts. */
    slashCommands: Map<string, SurfaceWhole>;
  }> {
    const hook = this.collectHook(plugin);
    const readSecret = createSecretReader();
    const skills = new Map<string, SurfaceSkill>();
    for (const skill of await this.collectSkillsFromRoots(plugin, warnings)) {
      skills.set(skill.name, {
        ...describeSkillAdvertisement(skill),
        consentFingerprint: skill.consentFingerprint,
        consentDetail: skill.consentDetail,
        relativeDir: skill.approvedCopy.relativeDir,
      });
    }
    const ambiguousAgents = new Set<string>();
    const agents = new Map(
      (await listPluginAgentFiles(plugin.agentsDir, warnings, ambiguousAgents)).map((agent) => [
        agent.id,
        agentSurface(agent),
      ])
    );
    const workflows = new Map(
      (await this.collectWorkflowScripts(plugin, warnings)).map((w) => [w.file, w] as const)
    );
    const servers = new Map<string, SurfaceServer>();
    if (plugin.mcpConfigPath !== undefined) {
      const { servers: infos, diagnostics } = await loadPluginMcpServers(plugin, {
        xumHome: this.config.rootDir,
        instanceId,
      });
      warnings.push(...diagnostics.map((d) => d.message));
      const rewrite = (value: string): string => value.split(plugin.rootPath).join(finalTargetPath);
      // A staged update review normalizes the final path too (see collectMcpServers).
      const paths = {
        rootPaths: [plugin.rootPath, finalTargetPath],
        dataPaths: [getPluginDataPath(this.config.rootDir, instanceId)],
      };
      for (const info of Object.values(infos)) {
        assert(info.plugin !== undefined, "plugin server info must carry provenance");
        const signIn =
          info.transport === "stdio"
            ? undefined
            : await readSignIn(info.url, info.oauth, readSecret);
        // The whole normalized server (componentConsent.ts) so a parser widening shows here too,
        // plus the secret digest so a secret-only change still needs review.
        const consentFingerprint = serverConsentFingerprint(info, paths);
        const fingerprint = JSON.stringify({
          consentFingerprint,
          secretDigest: signIn?.secretDigest ?? null,
        });
        servers.set(info.plugin.serverName, {
          fingerprint,
          consentFingerprint,
          consentDetail: () => serverConsentDetail(info, paths),
          display: this.describeMcpServer(info, rewrite, finalTargetPath).summary,
          ...(signIn !== undefined ? { signIn } : {}),
        });
      }
    }
    return {
      hook,
      servers,
      skills,
      agents,
      ambiguousAgents,
      workflows,
      slashCommands: slashCommandSurface(plugin),
    };
  }

  /**
   * Update gate input: every capability increase/change between the installed
   * tree and the staged new tree, with the consented and staged values so
   * the user can review them in place. A missing or invalid installed tree
   * yields an empty surface, so everything staged counts as an addition
   * (conservative: nothing inspectable was consented to at this path).
   * Capability REMOVALS and grant reductions are not changes here: they
   * apply without re-consent.
   *
   * `stagedWarnings` receives the staged tree's component-loader diagnostics
   * (a skill or MCP entry that will stop loading): the review must disclose
   * them alongside the capability changes, exactly like the install preview
   * does, or a consent could silently accept a broken component.
   */
  private async collectCapabilityChanges(
    name: string,
    installedPath: string,
    stagedPlugin: AgentPluginInfo,
    stagedWarnings: string[],
    /** Receives server URLs whose sign-in identity changes (stored tokens must go). */
    signInResets?: string[]
  ): Promise<AgentPluginCapabilityChange[]> {
    const instanceId = this.instanceIdFor(name);
    const { plugin: currentPlugin } = await discoverAgentPluginAt({
      pluginDir: installedPath,
      scope: "global",
    });
    const staged = await this.capabilitySurface(
      stagedPlugin,
      instanceId,
      installedPath,
      stagedWarnings
    );
    // Diagnostics of the CURRENT tree are not news to the user; discard them.
    const current =
      currentPlugin === null
        ? undefined
        : await this.capabilitySurface(currentPlugin, instanceId, installedPath, []);

    const changes: AgentPluginCapabilityChange[] = [];
    const describeGrants = (grants: string[]): string =>
      grants.length > 0 ? grants.join(", ") : "(no tool visibility granted)";
    if (staged.hook !== undefined) {
      const currentHook = current?.hook;
      if (currentHook === undefined) {
        const grantSuffix =
          staged.hook.toolGrants.length > 0
            ? ` with tool grants: ${staged.hook.toolGrants.join(", ")}`
            : "";
        changes.push({
          summary: `adds executable hooks (${staged.hook.path}${grantSuffix})`,
          after: `${staged.hook.path} — tool grants: ${describeGrants(staged.hook.toolGrants)}`,
        });
      } else {
        if (staged.hook.path !== currentHook.path) {
          changes.push({
            summary: `moves its hook entry (${currentHook.path} → ${staged.hook.path})`,
            before: currentHook.path,
            after: staged.hook.path,
          });
        }
        const newGrants = staged.hook.toolGrants.filter(
          (grant) => !currentHook.toolGrants.includes(grant)
        );
        if (newGrants.length > 0) {
          changes.push({
            summary: `expands hook tool grants: ${newGrants.join(", ")}`,
            before: describeGrants(currentHook.toolGrants),
            after: describeGrants(staged.hook.toolGrants),
          });
        }
      }
    }
    for (const [serverName, server] of staged.servers) {
      const currentServer = current?.servers.get(serverName);
      const component = {
        kind: "mcpServers" as const,
        name: serverName,
        fingerprint: server.consentFingerprint,
      };
      if (currentServer === undefined) {
        changes.push({
          summary: `adds MCP server '${serverName}'`,
          after: reviewText(server),
          component,
        });
      } else if (currentServer.fingerprint !== server.fingerprint) {
        const authLines = describeSignInChanges(currentServer.signIn, server.signIn);
        changes.push({
          summary: [`changes MCP server '${serverName}'`, ...authLines].join(": "),
          before: reviewText(currentServer),
          after: reviewText(server),
          component,
        });
      }
    }
    // Stored credentials are keyed by the normalized server URL, not the
    // server name: match sign-ins by that key, so a renamed server or a
    // respelled URL (`/mcp` vs `/mcp/`) with a new identity still resets.
    const credentialKey = (url: string): string | null =>
      this.mcpOauthService?.credentialKey(url) ?? null;
    // Compare each entry with its own previous identity (same name, same key): when two
    // servers share a URL, another entry already using the new identity must not mask the
    // change. A renamed (or added) entry has no previous self, and the stored credentials
    // cannot be traced to one entry: reset whenever any identity at the key differs. A
    // needless sign-out is acceptable; stale credentials offered under a new identity are not.
    const currentIdentities = new Map<string, Set<string>>();
    const currentEntryIdentity = new Map<string, string>();
    for (const [serverName, server] of current?.servers ?? []) {
      const key = server.signIn && credentialKey(server.signIn.url);
      if (!key || !server.signIn) continue;
      const identities = currentIdentities.get(key) ?? new Set<string>();
      identities.add(server.signIn.identity);
      currentIdentities.set(key, identities);
      currentEntryIdentity.set(`${serverName}\0${key}`, server.signIn.identity);
    }
    for (const [serverName, server] of staged.servers) {
      const key = server.signIn && credentialKey(server.signIn.url);
      if (!key || !server.signIn) continue;
      const previous = currentEntryIdentity.get(`${serverName}\0${key}`);
      const identity = server.signIn.identity;
      const changed =
        previous !== undefined
          ? previous !== identity
          : [...(currentIdentities.get(key) ?? [])].some((other) => other !== identity);
      if (changed) signInResets?.push(server.signIn.url);
    }
    // Skill advertisements interpolate into the model-visible skill index on
    // every request, so a new skill — or a reworded description — can inject
    // instructions without the user ever invoking it. Gate both.
    for (const [skillName, skill] of staged.skills) {
      const currentSkill = current?.skills.get(skillName);
      const component = {
        kind: "skills" as const,
        name: skillName,
        fingerprint: skill.consentFingerprint,
      };
      if (currentSkill === undefined) {
        changes.push({ summary: `adds skill '${skillName}'`, after: reviewText(skill), component });
      } else if (currentSkill.consentFingerprint !== skill.consentFingerprint) {
        // The skill's location and whole frontmatter count (#6498), so a moved skill or a new
        // frontmatter field shows here. The summary names an advertisement change when there is one.
        changes.push({
          summary: skillChangeSummary(currentSkill, skill, skillName),
          before: reviewText(currentSkill),
          after: reviewText(skill),
          component,
        });
      }
    }
    // Agent definitions: the description injects into the task tool's
    // model-visible prompt and runnable/base/policy change execution
    // privileges, so a changed definition behind an unchanged filename is
    // gated exactly like an addition.
    changes.push(...wholeComponentChanges("agents", staged.agents, current?.agents));
    changes.push(...ambiguousAgentChanges(staged.ambiguousAgents, current?.ambiguousAgents));
    changes.push(...wholeComponentChanges("workflows", staged.workflows, current?.workflows));
    changes.push(
      ...wholeComponentChanges("slashCommands", staged.slashCommands, current?.slashCommands)
    );
    changes.push(...(await this.fileReviewChanges(stagedPlugin, currentPlugin)));
    assertReviewFits(changes);
    return changes;
  }

  /**
   * Executable workflow scripts, read as the runtime resolver reads them (the shared lister, the
   * root-checked capped read) so the consent fingerprint matches what can run (#6629): the
   * top-level `workflows/*.js`, keyed by file name, and each skill's `workflow.js` (the `skill://`
   * entry), keyed by its plugin-relative path. A script the runtime cannot read is reported and
   * skipped.
   */
  private async collectWorkflowScripts(
    plugin: AgentPluginInfo,
    warnings: string[]
  ): Promise<Array<SurfaceWhole & { file: string; source: string }>> {
    const targets = [
      ...(await listPluginWorkflowFiles(plugin.workflowsDir)).map((file) => ({
        file,
        // listPluginWorkflowFiles lists nothing without a workflows dir.
        filePath: path.join(plugin.workflowsDir ?? "", file),
        display: `Workflow script workflows/${file}`,
      })),
      ...(await listPluginSkillScripts(plugin)).map((script) => ({
        ...script,
        display: `Skill workflow script ${script.file}`,
      })),
    ];
    const scripts: Array<SurfaceWhole & { file: string; source: string }> = [];
    for (const target of targets) {
      const source = await readWorkflowScriptForReview(plugin.rootPath, target, warnings);
      if (source === undefined || source.length === 0) continue;
      const input = { file: target.file, source };
      scripts.push({
        file: target.file,
        source,
        consentFingerprint: workflowConsentFingerprint(input),
        display: target.display,
        consentDetail: () => workflowConsentDetail(input),
      });
    }
    return scripts;
  }

  /**
   * Preview skill rows enriched with the remaining MODEL-VISIBLE frontmatter:
   * whenToUse interpolates into the agent_skill_read tool description and
   * advertise gates that visibility entirely, so the update capability
   * fingerprint must cover them (the oRPC preview schema strips the extras).
   */
  private async collectSkillsFromRoots(
    plugin: Pick<AgentPluginInfo, "rootPath" | "skillsDirs">,
    warnings: string[]
  ): Promise<CollectedPluginSkill[]> {
    const skills: CollectedPluginSkill[] = [];
    for (const skillsRoot of plugin.skillsDirs ?? []) {
      for (const { skill, label } of await this.collectSkills(
        plugin.rootPath,
        skillsRoot,
        warnings
      )) {
        // Runtime discovery keeps the first skill of a name (roots in declared order), so the
        // preview must not promise the later one (#6121).
        if (skills.some((earlier) => earlier.name === skill.name)) {
          warnings.push(
            `${label}: an earlier skills root has a skill with this name; it will not load`
          );
          continue;
        }
        skills.push(skill);
      }
    }
    return skills;
  }

  /**
   * One skills root of collectSkillsFromRoots. Warnings name the root by its plugin-relative path;
   * `label` names each skill's real folder (a snake_case folder has a kebab-case skill name).
   */
  private async collectSkills(
    pluginRoot: string,
    skillsRoot: PluginSkillsRoot,
    warnings: string[]
  ): Promise<Array<{ skill: CollectedPluginSkill; label: string }>> {
    const skills: Array<{ skill: CollectedPluginSkill; label: string }> = [];
    // Includes symlinked skill dirs, matching runtime discovery: a symlinked
    // skill activates after install, so it MUST appear in the consent preview.
    for (const {
      name: skillName,
      folder,
      dir: skillDir,
      file: skillPath,
    } of await listPluginSkillFolders(skillsRoot)) {
      const label = skillReviewLabel(pluginRoot, skillsRoot, folder);
      // Spec §4.1 containment anchored at the plugin root, mirroring runtime
      // component checks: a symlink escaping the plugin is surfaced as a
      // warning instead of silently ignored.
      let containedSkillPath: string;
      try {
        // allowMissing (matching runtime assertSkillDirValid): resolve through
        // the symlinked dir even when SKILL.md is absent, so an escaping
        // symlink fails containment instead of hiding behind ENOENT.
        containedSkillPath = await ensurePluginPathContained(pluginRoot, skillPath, {
          allowMissing: true,
        });
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          warnings.push(
            `${label}: ${error instanceof PluginGitPathError ? "resolves into the plugin's .git directory" : "resolves outside the plugin root"}; it will not load`
          );
        }
        // ENOENT (unresolvable path) → not a skill dir; skip silently.
        continue;
      }
      let stat;
      try {
        stat = await fsPromises.stat(containedSkillPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // Mirror runtime discovery's directory-name validation: an invalid dir
      // name never loads, and a frontmatter name that mismatches the dir name
      // is rejected at load time. Without both checks here the consent
      // preview (and the update capability surface built from it) would
      // promise a skill that disappears after installation — or classify a
      // never-loading skill as a capability addition.
      const skillNameParsed = SkillNameSchema.safeParse(skillName);
      if (!skillNameParsed.success) {
        warnings.push(`${label}: invalid skill directory name; it will not load`);
        continue;
      }
      // Size-check BEFORE reading (mirroring runtime discovery): the parse
      // enforces the same cap, but only after the full read+decode — see the
      // identical guard in collectAgentFiles.
      if (stat.size > MAX_FILE_SIZE) {
        warnings.push(
          `${label}: SKILL.md is too large (${stat.size} bytes; max ${MAX_FILE_SIZE}); it will not load`
        );
        continue;
      }
      try {
        // A Claude command or a Cursor rule becomes SKILL.md text first, so its review, fingerprint and approved
        // copy are a skill's (the copy is that text, which the runtime check parses as is).
        const content = pluginSkillMarkdown(
          skillName,
          await fsPromises.readFile(containedSkillPath, "utf8"),
          skillsRoot
        );
        const parsed = parseSkillMarkdown({
          content,
          byteSize: stat.size,
          directoryName: skillNameParsed.data,
          // Mirror runtime discovery: a display name loads under the dir name.
          allowDisplayName: true,
        });
        warnings.push(...displayNameWarnings(label, skillName, parsed.displayName));
        const relativeDir = path.relative(pluginRoot, skillDir);
        skills.push({
          label,
          skill: {
            name: parsed.frontmatter.name,
            ...skillConsentFields({
              relativeDir,
              frontmatter: skillConsentFrontmatter(parsed),
              body: parsed.body,
            }),
            approvedCopy: { relativeDir, content },
            // The commands the skill can run when invoked (#6617): shown, then fingerprinted.
            ...directivesField(skillReviewDirectives(parsed.body)),
            ...(parsed.frontmatter.description !== undefined
              ? { description: parsed.frontmatter.description }
              : {}),
            // Model-visible beyond name/description: whenToUse interpolates
            // into the agent_skill_read tool description, and advertise
            // controls whether the skill appears there at all. Both feed the
            // update capability fingerprint (capabilitySurface), resolved with
            // the same helpers the runtime uses.
            whenToUse: resolveSkillWhenToUse(parsed.frontmatter),
            advertise: resolveSkillAdvertise(parsed.frontmatter),
            // paths moves the skill from the static index to file-tool pointers.
            paths: resolveSkillPaths(parsed.frontmatter),
          },
        });
      } catch (error) {
        warnings.push(`${label}: ${getErrorMessage(error)}`);
      }
    }
    return skills;
  }

  /**
   * Normalize the staged plugin's mcp.json into the preview list. Uses the
   * FINAL instance identity so `PLUGIN_DATA` paths shown to the user match
   * what will run; staged-root path fragments are rewritten to the final
   * install path for readability.
   */
  private async collectMcpServers(
    plugin: AgentPluginInfo,
    finalTargetPath: string,
    instanceId: string,
    warnings: string[]
  ): Promise<{ previews: AgentPluginPreviewMcpServer[]; fingerprints: Record<string, string> }> {
    if (plugin.mcpConfigPath === undefined) {
      return { previews: [], fingerprints: {} };
    }
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, {
      xumHome: this.config.rootDir,
      instanceId,
    });
    warnings.push(...diagnostics.map((d) => d.message));

    const rewrite = (value: string): string => value.split(plugin.rootPath).join(finalTargetPath);
    // A staged review must also normalize the final path: a manifest can name it literally.
    const paths = {
      rootPaths: [plugin.rootPath, finalTargetPath],
      dataPaths: [getPluginDataPath(this.config.rootDir, instanceId)],
    };
    const entries = Object.values(servers).map((info) => {
      const preview = this.describeMcpServer(info, rewrite, finalTargetPath);
      return [preview, serverConsentFingerprint(info, paths)] as const;
    });
    return {
      previews: entries
        .map(([preview]) => preview)
        .sort((a, b) => a.serverName.localeCompare(b.serverName)),
      // From entries, never by assignment: a server named `__proto__` must stay an own key.
      fingerprints: Object.fromEntries(
        entries.map(([preview, fingerprint]) => [preview.serverName, fingerprint])
      ),
    };
  }

  /**
   * Human-readable disclosure of one plugin MCP server, shared by the install
   * consent preview and the update review (so "before"/"after" render exactly
   * like the line the user originally consented to).
   */
  private describeMcpServer(
    info: MCPServerInfo,
    rewrite: (value: string) => string,
    finalTargetPath: string
  ): AgentPluginPreviewMcpServer {
    assert(info.plugin !== undefined, "plugin server info must carry provenance");
    if (info.transport !== "stdio") {
      // SECURITY AUDIT: the user consents to the server URL, so each auth host
      // that differs from its host gets its own line. Exact host comparison:
      // no public-suffix list exists here to make parent-domain matching safe.
      const serverHost = new URL(info.url).host;
      const discovery = info.oauth?.discovery;
      const authHosts = new Set(
        [discovery?.authorizationServerBase, discovery?.registrationUrl]
          .filter((url) => url !== undefined)
          .map((url) => new URL(url).host)
          .filter((host) => host !== serverHost)
      );
      return {
        serverName: info.plugin.serverName,
        transport: info.transport === "http" ? "http" : "sse",
        summary: [
          info.url,
          ...[...authHosts].map((host) => `Sign-in at ${host}`),
          // The token audience, when the plugin narrows or widens it.
          ...(info.oauth?.resource !== undefined &&
          new URL(info.oauth.resource).href !== new URL(info.url).href
            ? [`Token resource: ${info.oauth.resource}`]
            : []),
        ].join("\n"),
      };
    }
    // Mirror the runtime's rendering (MCPServerManager shell-quotes every
    // token): the consent preview must show the exact argument boundaries
    // that will run — an arg containing whitespace/quotes could otherwise
    // masquerade as several args or hide a boundary.
    const commandLine =
      info.args !== undefined
        ? [info.command, ...info.args].map(rewrite).map(shellQuote).join(" ")
        : rewrite(info.command);
    const details = stdioLaunchDetails(info, rewrite, finalTargetPath);
    return {
      serverName: info.plugin.serverName,
      transport: "stdio",
      summary: details.length > 0 ? `${commandLine} (${details.join("; ")})` : commandLine,
    };
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Stage + validate an install without writing anything permanent. The
   * staged clone is deleted before returning (stateless preview): install
   * re-fetches the exact consented SHA, so cancelling leaves no state.
   */
  private async captureResult<T>(operation: () => Promise<T>) {
    try {
      return { success: true as const, data: await operation() };
    } catch (error) {
      return { success: false as const, error: getErrorMessage(error) };
    }
  }

  previewResult(args: Parameters<AgentPluginInstallService["previewSource"]>[0]) {
    return this.captureResult(() => this.previewSource(args));
  }

  installResult(args: Parameters<AgentPluginInstallService["install"]>[0]) {
    return this.captureResult(() => this.install(args));
  }

  getHooksResult(args: { name: string }) {
    return this.captureResult(() => this.getHooks(args));
  }

  setHookTrustResult(args: Parameters<AgentPluginInstallService["setHookTrust"]>[0]) {
    return this.captureResult(() => this.setHookTrust(args));
  }

  getComponentsResult(args: { name: string }) {
    return this.captureResult(() => this.getComponents(args));
  }

  async setComponentsResult(args: Parameters<AgentPluginInstallService["setComponents"]>[0]) {
    const result = await this.captureResult(() => this.setComponents(args));
    return result.success ? { success: true as const, ...result.data } : result;
  }

  listResult() {
    return this.captureResult(() => this.list());
  }

  signOutPluginServersResult() {
    return this.captureResult(() => this.signOutPluginServers());
  }

  uninstallResult(args: Parameters<AgentPluginInstallService["uninstall"]>[0]) {
    return this.captureResult(() => this.uninstall(args));
  }

  checkUpdatesResult() {
    return this.captureResult(() => this.checkUpdates());
  }

  updateResult(args: Parameters<AgentPluginInstallService["update"]>[0]) {
    return this.captureResult(() => this.update(args));
  }

  previewUpdateResult(args: Parameters<AgentPluginInstallService["previewUpdate"]>[0]) {
    return this.captureResult(() => this.previewUpdate(args));
  }

  previewComponentReviewResult(
    args: Parameters<AgentPluginInstallService["previewComponentReview"]>[0]
  ) {
    return this.captureResult(() => this.previewComponentReview(args));
  }

  confirmComponentReviewResult(
    args: Parameters<AgentPluginInstallService["confirmComponentReview"]>[0]
  ) {
    return this.captureResult(() => this.confirmComponentReview(args));
  }

  /** The plugin preview of a source; a marketplace repository is refused (see previewSource). */
  async preview(
    args: Parameters<AgentPluginInstallService["previewSource"]>[0]
  ): Promise<AgentPluginInstallPreview> {
    const result = await this.previewSource(args);
    if (result.kind === "marketplace") {
      throw new Error(
        `This repository is the Claude Code marketplace '${result.marketplace.name}'. Preview one of its plugins.`
      );
    }
    return result.preview;
  }

  /**
   * Preview a source: a plugin to review, or the entries of a Claude Code marketplace. A root
   * clone without a plugin manifest but with `.claude-plugin/marketplace.json` lists the
   * marketplace, unless a method was asked for (Skills installs the whole repository). Xum
   * never looks for a marketplace under a subpath. With a `claude-marketplace` method, the
   * preview resolves that entry's source and previews its plugin.
   */
  async previewSource(args: {
    input: string;
    ref?: string | undefined;
    subpath?: string | undefined;
    /** Absent: the first method that fits. */
    method?: AgentPluginInstallMethod | null | undefined;
  }): Promise<AgentPluginSourcePreview> {
    const parsed = parseAgentPluginSourceInput(args.input);
    const ref = resolvePreviewRef(parsed.ref, args.ref);
    const subpath = resolvePreviewSubpath(parsed.subpath, args.subpath);
    const entryName = marketplaceEntryOf(args.method);
    if (entryName !== undefined && subpath !== undefined) {
      throw new Error("A marketplace entry is picked at the repository root. Remove the folder.");
    }

    const resolved = await this.resolveRemoteRef(parsed.url, ref);
    const staged = await this.cloneResolved(parsed.url, resolved, subpath);
    const source = resolvedGitSource(parsed.url, resolved, subpath);
    let stagedDir = staged.dir;
    try {
      if (entryName !== undefined) {
        const entry = await this.stageMarketplaceEntry(staged, source, entryName);
        stagedDir = entry.staged.dir;
        return {
          kind: "plugin",
          preview: await this.previewStaged({ ...entry, request: { mode: "first" } }),
        };
      }
      const listing = await this.marketplaceListingAt(staged, source, args.method);
      if (listing !== undefined) return { kind: "marketplace", marketplace: listing };
      return {
        kind: "plugin",
        preview: await this.previewStaged({
          staged,
          source,
          resolved,
          request: installMethodRequest(args.method),
        }),
      };
    } finally {
      await this.removeDir(stagedDir);
    }
  }

  /**
   * The listing when a root clone has a marketplace file and no plugin manifest. Xum looks only
   * at the root, and only when no method was asked for (Skills installs the whole repository).
   */
  private async marketplaceListingAt(
    staged: { dir: string; sha: string },
    source: AgentPluginGitSource,
    method: AgentPluginInstallMethod | null | undefined
  ): Promise<AgentPluginMarketplaceListing | undefined> {
    if (method != null || source.subpath !== undefined) return undefined;
    const content = await this.readMarketplaceAtCommit(staged.dir, staged.sha);
    if (content === undefined) return undefined;
    const { methods } = await detectInstallMethods(staged.dir);
    if (
      methods.some((method) => method.kind === "agent-plugin" || method.kind === "claude-plugin")
    ) {
      return undefined;
    }
    const listing = marketplaceListing({ content, source, lockedSha: staged.sha, methods });
    const marketplace = parseClaudeMarketplace(content);
    // A catalog can list hundreds of entries that share one folder: scan at most
    // MARKETPLACE_SCAN_CONCURRENCY at once, and each distinct folder + skills list once.
    const semaphore = new AsyncSemaphore(MARKETPLACE_SCAN_CONCURRENCY);
    const scans = new Map<string, Promise<Set<string>>>();
    const entries = await Promise.all(
      listing.entries.map(async (row) => {
        const slot = await semaphore.acquire();
        try {
          return await this.withAcceptedSkillCount(staged.dir, marketplace, source, row, scans);
        } finally {
          slot.release();
        }
      })
    );
    return { ...listing, entries };
  }

  /**
   * A relative entry's skill count: the skills its preview accepts (collectSkills), not the
   * paths it lists. An entry in another repository keeps the count of paths: Xum has not cloned it.
   */
  private async withAcceptedSkillCount(
    stagedDir: string,
    marketplace: ClaudeMarketplace,
    source: AgentPluginGitSource,
    row: AgentPluginMarketplaceEntry,
    /** Scans of this listing by folder, skills list and plugin name. */
    scans: Map<string, Promise<Set<string>>>
  ): Promise<AgentPluginMarketplaceEntry> {
    if (row.skillCount === undefined || !row.installable || row.sourceKind !== "relative") {
      return row;
    }
    const entry = findMarketplaceEntry(marketplace, row.name);
    const resolved = resolveEntrySource(marketplace, source.url, entry);
    assert(resolved.kind === "relative", "withAcceptedSkillCount: a relative entry resolves here");
    const folder = path.join(stagedDir, resolved.subpath ?? "");
    let entryDir: string;
    try {
      entryDir = await ensurePluginPathContained(stagedDir, folder);
    } catch (error) {
      // A missing or escaping folder would fail the entry's preview, so the listing does not
      // offer it. The reason names the folder, not the staging path.
      const why = hasErrorCode(error, "ENOENT") ? "it does not exist" : getErrorMessage(error);
      return {
        ...row,
        installable: false,
        reason: `Xum cannot install the entry's folder '${resolved.subpath ?? "."}': ${why}`,
      };
    }
    let manifest: Record<string, unknown>;
    try {
      ({ manifest } = marketplaceManifest({
        entry,
        relative: true,
        rootSource: resolved.subpath === undefined,
      }));
    } catch {
      // No plugin name fits the entry name: its own preview fails with the reason.
      return row;
    }
    const declared = declaredSkills(manifest);
    const pluginName = typeof manifest.name === "string" ? manifest.name : entry.name;
    // The plugin name names only a skill at the plugin root itself (a declared "."), so
    // entries that share a folder and skills list share one scan otherwise.
    const namesRootSkill =
      declared === undefined ||
      [declared].flat().some((root) => path.posix.normalize(`${root}/`) === "./");
    const key = JSON.stringify([entryDir, declared, namesRootSkill ? pluginName : null]);
    let scan = scans.get(key);
    if (scan === undefined) {
      scan = this.acceptedSkillNames(entryDir, { declared, pluginName });
      scans.set(key, scan);
    }
    return { ...row, skillCount: (await scan).size };
  }

  /**
   * Stage the plugin of marketplace entry `entryName` from a root clone of the marketplace. A
   * root-source entry is that clone. A folder of the same repository is cloned at the same commit
   * (so the entry and its folder match), and another repository is resolved like a typed source.
   * Consumes `marketplace` when it returns a different folder.
   */
  private async stageMarketplaceEntry(
    marketplace: { dir: string; sha: string },
    marketplaceSource: AgentPluginGitSource,
    entryName: string
  ): Promise<{
    staged: { dir: string; sha: string };
    source: AgentPluginGitSource;
    resolved: ResolvedRemoteRef;
    marketplace: MarketplaceEntryContext;
  }> {
    const content = await this.readMarketplaceAtCommit(marketplace.dir, marketplace.sha);
    if (content === undefined) {
      throw new Error(`This repository has no ${CLAUDE_MARKETPLACE_RELATIVE_PATH}.`);
    }
    const parsed = parseClaudeMarketplace(content);
    const entry = findMarketplaceEntry(parsed, entryName);
    const target = resolveEntrySource(parsed, marketplaceSource.url, entry);
    const marketplaceResolved: ResolvedRemoteRef = {
      ref: marketplaceSource.ref,
      refType: marketplaceSource.refType,
      sha: marketplace.sha,
    };
    if (target.kind === "relative" && target.subpath === undefined) {
      return {
        staged: marketplace,
        source: marketplaceSource,
        resolved: marketplaceResolved,
        marketplace: { entry, relative: true, rootSource: true },
      };
    }
    await this.removeDir(marketplace.dir);
    if (target.kind === "relative") {
      const source = { ...marketplaceSource, subpath: target.subpath };
      const { dir } = await this.cloneExactSha(source, marketplace.sha);
      return {
        staged: { dir, sha: marketplace.sha },
        source,
        resolved: marketplaceResolved,
        marketplace: { entry, relative: true, rootSource: false },
      };
    }
    const resolved = await this.resolveRemoteRef(target.url, target.ref);
    const staged = await this.cloneResolved(target.url, resolved, target.subpath);
    return {
      staged,
      source: resolvedGitSource(target.url, resolved, target.subpath),
      resolved,
      marketplace: { entry, relative: false, rootSource: false },
    };
  }

  /** The consent preview of a staged clone (removed by the caller). */
  private async previewStaged(args: {
    staged: { dir: string; sha: string };
    source: AgentPluginGitSource;
    resolved: ResolvedRemoteRef;
    request: InstallMethodRequest;
    marketplace?: MarketplaceEntryContext;
  }): Promise<AgentPluginInstallPreview> {
    const { source, resolved } = args;
    const { dir: stagedDir, sha } = args.staged;
    const { plugin, warnings, method, methods, skillsCliSkills } = await this.validateStagedClone(
      stagedDir,
      source,
      args.request,
      args.marketplace
    );
    const targetPath = this.targetPathFor(plugin.name);
    // A name collision blocks only the managed install of this method: the preview still lists
    // the other methods and the Skills CLI choice, which creates no managed plugin.
    const installBlockedReason = await this.collisionReason(plugin.name);

    const skills = await this.collectSkillsFromRoots(plugin, warnings);
    assertDirectivesFit(skills);
    const { previews: mcpServers, fingerprints: mcpFingerprints } = await this.collectMcpServers(
      plugin,
      targetPath,
      this.instanceIdFor(plugin.name),
      warnings
    );
    const hook = this.collectHook(plugin);
    const codexHooks = await loadPluginHooks(plugin);
    warnings.push(...codexHooks.warnings);
    const fileChanges = await this.fileReviewChanges(plugin, null);
    assertReviewFits(fileChanges);
    const openaiInterface = await interfaceSummary(plugin, warnings);
    const agentFiles = await listPluginAgentFiles(plugin.agentsDir, warnings);
    // Display only: the names a user reads before Install show invisible controls (#6629).
    const agents = agentFiles.map((agent) => showInvisibleControls(agent.file));
    const workflows = (await listPluginWorkflowFiles(plugin.workflowsDir)).map(
      showInvisibleControls
    );
    const workflowScripts = await this.collectWorkflowScripts(plugin, warnings);
    const slashSurface = [...slashCommandSurface(plugin)];
    const reviewedComponents = reviewedComponentRows([
      ["workflows", workflowScripts.map((w) => [w.file, w])],
      ["agents", agentFiles.map((agent) => [agent.id, agentSurface(agent)])],
      ["slashCommands", slashSurface],
    ]);
    // Built from the rows above, never a second read, so it covers exactly what was shown.
    const consentDigest = componentConsentDigest(
      inventoryFingerprints({
        skills,
        mcpServers: mcpFingerprints,
        workflows: workflowScripts,
        agents: agentFiles,
        slashCommands: slashSurface,
      }),
      hook
    );
    const slashCommands = (plugin.manifest.contributes?.slashCommands ?? []).map((command) => ({
      name: command.name,
      ...(command.description !== undefined ? { description: command.description } : {}),
    }));

    if (resolved.refType === "tag" && sha !== resolved.sha) {
      warnings.push(
        `Tag '${resolved.ref}' moved between resolution and clone — installing ${sha.slice(0, 12)}.`
      );
    }

    return {
      source,
      method,
      methods,
      skillsCliSkills,
      installBlockedReason,
      lockedSha: sha,
      manifest: {
        ...manifestSummary(plugin.manifest),
        ...(openaiInterface !== undefined ? { interface: openaiInterface } : {}),
      },
      // Fingerprints stay in the backend: the preview shows what the components do.
      skills: skills.map((skill) => omitConsentFingerprint(skill)),
      mcpServers,
      ...(hook !== undefined ? { hook } : {}),
      codexHooks: codexHooks.hooks,
      fileChanges,
      agents,
      workflows,
      slashCommands,
      reviewedComponents,
      warnings,
      targetPath: shortenHome(targetPath),
      consentDigest,
    };
  }

  private async assertNoCollision(name: string): Promise<void> {
    const reason = await this.collisionReason(name);
    if (reason !== undefined) throw new Error(reason);
  }

  /** Why a managed install of `name` cannot proceed (a name or folder collision), if it cannot. */
  private async collisionReason(name: string): Promise<string | undefined> {
    // Strict: a corrupted registry must fail installs up front (with the
    // repair message) instead of letting a later strict read fail mid-flow.
    // Collide on RAW entry names, not just parsed ones: an entry this build
    // cannot parse (written by a newer build) still owns its name — the
    // install rewrite would otherwise filter it out and replace it.
    const { rawEntries } = await this.readRegistryDocument("strict");
    if (rawEntries.some((rawEntry) => this.rawEntryName(rawEntry) === name)) {
      return `A managed plugin named '${name}' is already installed. Uninstall it first.`;
    }
    if (await pathExists(this.targetPathFor(name))) {
      // Never overwrite: an unmanaged dir may hold local work.
      return `${shortenHome(this.targetPathFor(name))} already exists. Remove the directory first — the installer never overwrites.`;
    }
    return undefined;
  }

  /** Fetch the consented SHA, validate again, promote into the container, and record the registry entry. */
  async install(args: {
    source: AgentPluginGitSource;
    /**
     * The preview's `method`; install refuses a clone it does not fit. The API always sends it;
     * tests may omit it (the first method that fits).
     */
    method?: AgentPluginInstallMethod;
    expectedSha: string;
    /** The preview's `consentDigest`. The renderer always sends it; tests may omit it. */
    expectedConsentDigest?: string;
    importedComponents?: AgentPluginImportedComponents;
  }): Promise<AgentPluginInstallEntry> {
    assert(isFullCommitSha(args.expectedSha), "install: expectedSha must be a full commit SHA");
    // Re-checked here (not just in source-input parsing): a direct API
    // request can hand install() a source that never went through the
    // parser, and this URL is persisted to plugins.json and rendered in
    // Settings.
    assertNoAgentPluginUrlCredentials(args.source.url);
    // Same reasoning for the subpath: it is persisted and decides which
    // folder becomes the plugin root, so a direct API source must already be
    // in the normalized form preview() returns.
    assertNormalizedSubpath(args.source.subpath);

    return this.runExclusive(async () => {
      // A marketplace entry without its own plugin.json is read again from the marketplace file
      // of the consented commit, so install writes the plugin.json that the preview showed.
      const { stagedDir, marketplace } = await this.cloneWithEntry(
        args.source,
        args.expectedSha,
        marketplaceEntryOf(args.method)
      );
      try {
        const { plugin } = await this.validateStagedClone(
          stagedDir,
          args.source,
          installMethodRequest(args.method),
          marketplace
        );
        const name = plugin.name;
        const inventory = await this.collectComponents(plugin, this.targetPathFor(name));
        // Install records consent for every directive command, so it bounds them like the
        // preview does. A direct API call without the preview's digest would skip that (#6816).
        assertDirectivesFit(inventory.skills);
        assertInventoryMatchesPreview(
          args.expectedConsentDigest,
          inventory.fingerprints,
          this.collectHook(plugin)
        );
        const importedComponents =
          args.importedComponents === undefined
            ? undefined
            : this.validateComponentImports(args.importedComponents, inventory);
        const componentConsent = consentAtInstall(importedComponents, inventory);
        await this.assertNoCollision(name);
        await this.assertNoPendingOverridePrune(name);
        await this.assertNoResidualInstanceState(name);
        // A retained uninstall journal means a previous uninstall of this
        // name still has unfinished recovery (staged assets to restore or
        // delete). Block the reinstall until it resolves: with a fresh
        // registry entry present, recoverInterruptedUninstall could no longer
        // tell that old journal from an uncommitted uninstall of THIS install
        // and would restore the old data over it. Recovery runs at startup
        // and on section open, so this self-heals.
        if (await pathExists(this.journalPath(UNINSTALL_JOURNAL_PREFIX, name))) {
          throw new Error(
            `A previous uninstall of '${name}' has unfinished cleanup. Open Settings → Plugins to let recovery complete, then try again.`
          );
        }
        const targetPath = this.targetPathFor(name);

        // The installed tree is a plain content snapshot: the registry holds
        // all provenance, and updates replace the directory wholesale, so a
        // .git dir would only invite in-place edits that updates discard.
        await this.removeDir(path.join(stagedDir, ".git"));

        // Journal the promotion BEFORE the rename: a process crash between
        // the rename and the registry write would otherwise strand a tree
        // that discovery lists as unmanaged, assertNoCollision blocks, and
        // uninstall refuses — reconcileJournals uses this record to clean it
        // up on startup or the next section open. The marker nonce (riding
        // inside the tree through the rename) proves the tree recovery finds
        // at the target is the one WE promoted: a user could delete the
        // orphan while the app is stopped and place their own unmanaged
        // plugin at the same path, which cleanup must never delete.
        const promotionNonce = randomBytes(16).toString("hex");
        await fsPromises.writeFile(path.join(stagedDir, PROMOTION_MARKER_FILE), promotionNonce);
        const journalPath = this.journalPath(PROMOTION_JOURNAL_PREFIX, name);
        await this.writeJournalFile(journalPath, {
          name,
          stagedAt: Date.now(),
          nonce: promotionNonce,
        });

        await fsPromises.mkdir(this.containerDir, { recursive: true });
        await fsPromises.rename(stagedDir, targetPath);

        const entry: AgentPluginInstallEntry = {
          name,
          scope: "global",
          source: args.source,
          lockedSha: args.expectedSha,
          installedAt: new Date().toISOString(),
          ...(importedComponents !== undefined ? { importedComponents } : {}),
          componentConsent,
          manifest: {
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
        try {
          const { envelope, rawEntries } = await this.readRegistryDocument("strict");
          await this.writeRegistry(envelope, [
            ...rawEntries.filter((rawEntry) => this.rawEntryName(rawEntry) !== name),
            entry,
          ]);
        } catch (error) {
          // No partial state: a promote without a registry entry would look
          // like an unmanaged dir and block reinstall. Each cleanup step is
          // isolated so a failure (e.g. a locked file on Windows) cannot
          // skip the others or mask the registry error.
          const cleanupNotes: string[] = [];
          let promotedTreeHandled = true;
          let treeRemoved = false;
          try {
            await this.removeDir(targetPath);
            treeRemoved = true;
          } catch {
            // Retried below after the plugin's processes are stopped — a
            // running server can be exactly what holds the lock.
          }
          // A getToolsForWorkspace running during the promote↔rollback window
          // can have discovered the briefly-visible tree and be starting a
          // server from it; invalidate the prefix (same as update/uninstall)
          // so it is closed instead of surviving the failed install. Must run
          // even when the rollback deletion above failed.
          try {
            await this.deps.mcpServerManager?.stopServersWithKeyPrefix(
              `plugin:${this.instanceIdFor(name)}:`
            );
          } catch (cleanupError) {
            cleanupNotes.push(
              `the plugin's MCP servers could not be stopped (${getErrorMessage(cleanupError)})`
            );
          }
          if (!treeRemoved) {
            // Retry now that the lock-holding processes are gone; if the tree
            // still cannot be deleted, QUARANTINE it into the staging root so
            // the globally scanned plugins container cannot rediscover and
            // load it as an unmanaged plugin (stale-dir reclamation cleans
            // staging leftovers).
            try {
              await this.removeDir(targetPath);
            } catch {
              const quarantineDir = path.join(this.stagingRoot, `trash-${Date.now()}-${name}`);
              try {
                await this.renameIntoStaging(targetPath, quarantineDir);
                await this.removeDir(quarantineDir).catch(() => undefined);
              } catch (cleanupError) {
                // The tree is stuck in the container (marker still inside):
                // the journal must SURVIVE as the recovery record — the next
                // reconciliation identifies the orphan by nonce and retries
                // the quarantine once the lock clears; without it the failed
                // install permanently blocks reinstalls via assertNoCollision.
                promotedTreeHandled = false;
                cleanupNotes.push(
                  `the promoted plugin tree could not be removed — it will be cleaned up automatically, or delete ${shortenHome(targetPath)} manually (${getErrorMessage(cleanupError)})`
                );
              }
            }
            // Re-invalidate AFTER the retry/quarantine: a workspace startup
            // that began after the stop above snapshots the newer epoch, can
            // still have discovered the then-visible tree, and would publish
            // after it disappears with no later invalidation covering it
            // (update/uninstall do the same second post-removal stop).
            try {
              await this.deps.mcpServerManager?.stopServersWithKeyPrefix(
                `plugin:${this.instanceIdFor(name)}:`
              );
            } catch (cleanupError) {
              cleanupNotes.push(
                `the plugin's MCP servers could not be re-stopped after removal (${getErrorMessage(cleanupError)})`
              );
            }
          }
          if (!promotedTreeHandled) {
            // Keep the discovery gate closed NOW: the orphan is discoverable
            // in the container until reconciliation quarantines it, and the
            // current process's health snapshot predates this failure.
            this.markUnreconciled();
          } else {
            // Rollback handled the tree: the journal's crash-recovery job is
            // done.
            await this.consumeJournalFile(journalPath).catch(() => undefined);
          }
          const notes = cleanupNotes.length > 0 ? ` Additionally, ${cleanupNotes.join("; ")}.` : "";
          throw new Error(
            `Failed to persist the plugin registry: ${getErrorMessage(error)}${notes}`
          );
        }
        // Registry write committed (entry recorded): the journal's
        // crash-recovery job is done.
        await this.consumeJournalFile(journalPath).catch(() => undefined);
        // Committed: the marker did its crash-recovery job (a failed removal
        // leaves a stray dotfile the next update swap discards — harmless).
        await fsPromises
          .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
          .catch(() => undefined);
        await this.sweepApprovedCopies(entry);
        log.info(`Installed agent plugin '${name}' at ${args.expectedSha.slice(0, 12)}`);
        return entry;
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }

  private journalPath(prefix: string, name: string): string {
    // Names are grammar-validated (no separators/traversal), so this join is safe.
    return path.join(this.stagingRoot, `${prefix}${name}.json`);
  }

  /**
   * Publish a journal atomically (temp + rename, like the epoch file):
   * readJournalForRecovery deliberately retains any unparseable journal and
   * the discovery gate then suppresses the whole managed container, so a
   * crash mid-writeFile must never leave truncated JSON at the journal path.
   * The temp name keeps the `.json` suffix off, so journal enumeration
   * (isJournalName + `.json`) can never pick up a half-written file.
   */
  private async writeJournalFile(
    journalPath: string,
    document: Record<string, unknown>
  ): Promise<void> {
    // writeFileAtomic fsyncs the temp file before the rename and the directory after it, so after
    // a power loss the journal is the old one or the whole new one, never empty (#6698).
    await writeFileAtomic(journalPath, JSON.stringify(document));
  }

  /**
   * Consume a journal whose transaction/recovery job finished: bump the
   * container mutation epoch FIRST, then delete the file. The epoch bump is
   * what lets a discovery-gate bracket (pre/post scan reads, in this or any
   * sibling process) detect a mutation whose whole journal lifetime fit
   * inside its scan window. A bump failure keeps the journal — callers treat
   * that as a failed consumption — rather than deleting the last visible
   * trace of the mutation.
   */
  private async consumeJournalFile(journalPath: string): Promise<void> {
    await bumpContainerMutationEpoch(this.stagingRoot);
    await fsPromises.rm(journalPath, { force: true });
  }

  /**
   * Parse a journal file into its raw object. Returns null when the file is
   * MISSING (ENOENT). THROWS on any other read/parse failure (truncated
   * write, transient I/O, permissions): an unreadable journal's recovery
   * instructions are unknown, so callers must treat it as UNRESOLVED — keep
   * the journal and its discovery suppression for a later repair attempt —
   * rather than consume it. Degrading the failure to "field absent" would
   * let recovery leave an orphaned promotion live as an unmanaged plugin
   * (unreadable nonce) or abandon an interrupted update's staged original
   * while the registry points at a missing tree (unreadable trashDir).
   */
  private async readJournalDocument(journalPath: string): Promise<Record<string, unknown> | null> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(journalPath, "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown; // Malformed JSON throws (fail closed).
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Plugin journal has a non-object root: ${journalPath}`);
    }
    return parsed as Record<string, unknown>;
  }

  /** A string field from a parsed journal document, or undefined when absent. */
  private journalStringField(
    doc: Record<string, unknown> | null,
    field: string
  ): string | undefined {
    const value = doc?.[field];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * A staged path recorded in a journal, or undefined when absent/invalid.
   * Defensive: recovery renames/deletes these paths, so a corrupted journal
   * must never aim them anywhere but a direct trash child of the staging root.
   */
  private journalStagedPath(
    doc: Record<string, unknown> | null,
    field: string
  ): string | undefined {
    const value = this.journalStringField(doc, field);
    if (value === undefined) {
      return undefined;
    }
    if (path.dirname(value) !== this.stagingRoot || !path.basename(value).startsWith("trash-")) {
      return undefined;
    }
    return value;
  }

  /**
   * Read a recovery journal's document for a recover* helper. Returns
   * `{ unreadable: true }` when the journal cannot be read/parsed — the
   * caller must return false (journal retained, discovery stays suppressed).
   */
  private async readJournalForRecovery(
    journalPath: string,
    name: string
  ): Promise<{ doc: Record<string, unknown> | null; unreadable: false } | { unreadable: true }> {
    try {
      return { doc: await this.readJournalDocument(journalPath), unreadable: false };
    } catch (error) {
      log.warn("Plugin recovery journal is unreadable; keeping it for a later repair attempt", {
        name,
        journalPath,
        error: getErrorMessage(error),
      });
      return { unreadable: true };
    }
  }

  /**
   * Crash recovery for mutations that died between their directory moves and
   * the registry write. Each journal proves WE created the referenced state
   * from a registry-owned tree or a staged clone (it is not user-authored
   * work), so it is safe to restore or clear. Runs at service startup (a
   * session can serve agent requests — global discovery, MCP config, hooks —
   * without ever opening the Plugins section) and again on section open,
   * under the mutation queue so it cannot interleave with a live mutation.
   */
  private async reconcileJournals(): Promise<boolean> {
    let journalNames: string[];
    try {
      journalNames = (await fsPromises.readdir(this.stagingRoot)).filter(
        (entry) => isJournalName(entry) && entry.endsWith(".json")
      );
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return true; // No staging root: nothing was ever staged.
      }
      // A staging root we cannot ENUMERATE (transient I/O, permissions) may
      // hold journals for unreconciled trees; reporting healthy here would
      // open the discovery gate over them. Fail closed and retry later.
      log.warn("Failed to enumerate the plugin staging root for journal recovery", {
        stagingRoot: this.stagingRoot,
        error: getErrorMessage(error),
      });
      return false;
    }
    if (journalNames.length === 0) {
      return true;
    }
    return this.runExclusive(async () => {
      // STRICT read: a temporarily unreadable or corrupted registry must not
      // degrade to an empty entry list here — reconciliation would then treat
      // committed installs as orphans and delete their trees, turning a
      // recoverable read problem into data loss. Throwing retains every
      // journal for a later retry; callers log and continue.
      const registryNames = new Set(
        (await this.readRegistryDocument("strict")).rawEntries
          .map((rawEntry) => this.rawEntryName(rawEntry))
          .filter((name): name is string => name !== undefined)
      );
      // Health result: every journal must end CONSUMED (its recovery job
      // done and the file gone). A retained journal — failed restore or
      // quarantine, unidentified tree at the target, or even a failed
      // journal deletion — means unreconciled state may still sit in the
      // managed container, so the discovery gate must keep suppressing it;
      // resolving successfully here would open the gate over that state.
      let allConsumed = true;
      for (const journalName of journalNames) {
        const journalPath = path.join(this.stagingRoot, journalName);
        const prefix = JOURNAL_PREFIXES.find((candidate) => journalName.startsWith(candidate));
        assert(prefix !== undefined, "reconcileJournals: filtered journal lost its prefix");
        const name = journalName.slice(prefix.length, -".json".length);
        if (!isValidAgentPluginName(name)) {
          await this.consumeJournalFile(journalPath).catch(() => undefined);
          continue;
        }
        const consumed =
          prefix === PROMOTION_JOURNAL_PREFIX
            ? await this.recoverOrphanedPromotion(name, journalPath, registryNames)
            : prefix === UPDATE_JOURNAL_PREFIX
              ? await this.recoverInterruptedUpdateSwap(name, journalPath, registryNames)
              : await this.recoverInterruptedUninstall(name, journalPath, registryNames);
        if (!consumed) {
          allConsumed = false;
          continue;
        }
        try {
          await this.consumeJournalFile(journalPath);
        } catch (error) {
          allConsumed = false;
          log.warn("Failed to delete a consumed plugin journal; will retry", {
            journalPath,
            error: getErrorMessage(error),
          });
        }
      }
      return allConsumed;
    });
  }

  /**
   * Install crashed between the promote rename and the registry write: the
   * orphan would be listed as unmanaged, block reinstalling the same name,
   * and refuse uninstall (not managed). Returns true when the journal's
   * recovery job is done.
   */
  private async recoverOrphanedPromotion(
    name: string,
    journalPath: string,
    registryNames: Set<string>
  ): Promise<boolean> {
    const journal = await this.readJournalForRecovery(journalPath, name);
    if (journal.unreadable) {
      return false;
    }
    const targetPath = this.targetPathFor(name);
    if (registryNames.has(name)) {
      // The install committed and only the journal deletion was lost; sweep
      // the marker the commit path would have removed — but only when the
      // marker is OURS (nonce match). A LATER mutation may own the live tree
      // by now: if an update crashed after promoting its replacement, the
      // marker at the target carries the UPDATE journal's nonce, and blindly
      // deleting it would make update recovery misread the live tree as an
      // unrecognized user replacement (staged old tree + markerless target)
      // and suppress the container forever.
      const journalNonce = this.journalStringField(journal.doc, "nonce");
      const treeNonce = await fsPromises
        .readFile(path.join(targetPath, PROMOTION_MARKER_FILE), "utf-8")
        .catch(() => undefined);
      if (journalNonce !== undefined && treeNonce === journalNonce) {
        await fsPromises
          .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
          .catch(() => undefined);
      }
      return true;
    }
    // Only an ORPHAN (tree without registry entry) needs cleanup.
    if (await pathExists(targetPath)) {
      // Verify the tree is the one WE promoted before deleting anything: the
      // user can delete the orphan while the app is stopped and place their
      // own unmanaged plugin at the same path (a supported use of the
      // globally scanned container). The marker nonce is non-reusable —
      // unlike dev/ino, which the filesystem can hand right back to a
      // recreated directory. A mismatch or missing marker means our orphan
      // is already gone, so consume the journal WITHOUT touching the
      // replacement.
      const journalNonce = this.journalStringField(journal.doc, "nonce");
      const treeNonce = await fsPromises
        .readFile(path.join(targetPath, PROMOTION_MARKER_FILE), "utf-8")
        .catch(() => undefined);
      const isPromotedTree =
        journalNonce !== undefined && treeNonce !== undefined && treeNonce === journalNonce;
      if (!isPromotedTree) {
        log.warn(
          "Skipping orphaned-promotion cleanup: the tree at the plugin path is not the promoted one",
          { name }
        );
        return true;
      }
      log.warn("Cleaning up plugin promotion orphaned by a crash", { name });
      const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(name), "");
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
      const quarantineDir = path.join(this.stagingRoot, `trash-${Date.now()}-${name}`);
      try {
        await this.renameIntoStaging(targetPath, quarantineDir);
        await this.removeDir(quarantineDir).catch(() => undefined);
      } catch (error) {
        // Keep the journal so the next reconciliation retries.
        log.warn("Failed to clean up orphaned plugin promotion", {
          name,
          error: getErrorMessage(error),
        });
        return false;
      }
      // Re-invalidate AFTER the tree left the container: a workspace startup
      // that began after the stop above can have discovered the then-visible
      // tree and would otherwise publish a server from the removed tree.
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
    }
    return true;
  }

  /**
   * Update crashed between renaming the OLD live tree into staging and
   * promoting the staged replacement: the registry records an install whose
   * path is missing, and retrying Update self-rejects (the missing tree reads
   * as an empty capability surface). Restore the old tree from staging.
   */
  private async recoverInterruptedUpdateSwap(
    name: string,
    journalPath: string,
    registryNames: Set<string>
  ): Promise<boolean> {
    const journal = await this.readJournalForRecovery(journalPath, name);
    if (journal.unreadable) {
      return false;
    }
    const targetPath = this.targetPathFor(name);
    const trashDir = this.journalStagedPath(journal.doc, "trashDir");
    if (await pathExists(targetPath)) {
      const journalNonce = this.journalStringField(journal.doc, "nonce");
      const treeNonce = await fsPromises
        .readFile(path.join(targetPath, PROMOTION_MARKER_FILE), "utf-8")
        .catch(() => undefined);
      if (journalNonce !== undefined && treeNonce === journalNonce) {
        // OUR promoted replacement landed. Two states reach here: the live
        // update failed only its journal DELETION (registry already updated)
        // — or the process died between the promote and the registry write,
        // leaving the registry claiming the OLD commit while the (already
        // capability-reviewed) replacement runs. The recorded newSha
        // distinguishes them: reconcile provenance FIRST, before the journal
        // is consumed, so lockedSha/manifest can never silently keep
        // describing a tree that no longer exists (a forced branch move back
        // to the stale SHA would even hide the update badge).
        const newSha = this.journalStringField(journal.doc, "newSha");
        if (newSha !== undefined && isFullCommitSha(newSha)) {
          try {
            const reconciled = await this.reconcilePromotedUpdateProvenance(
              name,
              targetPath,
              newSha,
              journalComponentConsent(journal.doc)
            );
            if (!reconciled) {
              return false; // Keep the journal; retried next reconciliation.
            }
          } catch (error) {
            log.warn("Failed to reconcile registry provenance for a promoted update", {
              name,
              error: getErrorMessage(error),
            });
            return false;
          }
        }
        // Finish the lost cleanup. Journal FIRST, and ENFORCED (mirrors the
        // update path): removing the marker while the journal survives would
        // strand a markerless target that the next recovery misclassifies as
        // a user replacement, deadlocking updates — so a failed journal
        // deletion must abort cleanup and keep the marker as the tree's
        // identity.
        try {
          await this.consumeJournalFile(journalPath);
        } catch (error) {
          log.warn("Failed to delete the update journal; keeping the tree marker for retry", {
            name,
            error: getErrorMessage(error),
          });
          return false;
        }
        // Journal gone: a stray marker or trash dir is harmless if these
        // best-effort removals fail (nothing references them anymore).
        await fsPromises
          .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
          .catch(() => undefined);
        if (trashDir !== undefined) {
          await this.removeDir(trashDir).catch(() => undefined);
        }
        return true;
      }
      if (trashDir === undefined || !(await pathExists(trashDir))) {
        // Nothing recoverable is staged: the swap never moved the old tree
        // (or it was already restored), so the live tree is the install.
        return true;
      }
      // The target holds a tree WITHOUT our nonce while the old tree is
      // still staged: a user created an unmanaged plugin at the then-empty
      // target while the app was stopped. The registry would wrongly claim
      // it (a later Update/Uninstall could overwrite or delete it) — keep
      // the journal, which also pins the staged original against
      // reclamation and blocks further updates until resolved.
      log.warn(
        "Update recovery found an unrecognized tree at the plugin path; keeping the staged original",
        { name }
      );
      return false;
    }
    if (trashDir === undefined || !(await pathExists(trashDir))) {
      log.warn("Update swap journal has no recoverable tree", { name });
      return true;
    }
    if (!registryNames.has(name)) {
      // The entry was since removed (e.g. a registry-only uninstall while
      // recovery kept failing): restoring would recreate an unmanaged orphan.
      await this.removeDir(trashDir).catch(() => undefined);
      return true;
    }
    log.warn("Restoring plugin tree after an update swap interrupted by a crash", { name });
    try {
      await fsPromises.mkdir(this.containerDir, { recursive: true });
      await fsPromises.rename(trashDir, targetPath);
    } catch (error) {
      log.warn("Failed to restore plugin tree from an interrupted update swap", {
        name,
        error: getErrorMessage(error),
      });
      return false;
    }
    return true;
  }

  /**
   * Commit a promoted-but-unrecorded update's provenance into the registry:
   * lockedSha from the journal, version/description re-read from the promoted
   * tree's own plugin.json (the tree IS the source of truth for its manifest;
   * its .git was stripped, so the SHA must ride in the journal). No-ops when
   * the entry is gone (registry-only uninstall raced recovery) or already
   * records the new SHA (the live update only lost its journal deletion).
   * Returns false when the promoted tree's manifest cannot be read — the
   * journal must survive so a transient read failure is retried rather than
   * committing a SHA whose manifest summary silently stays stale.
   */
  private async reconcilePromotedUpdateProvenance(
    name: string,
    targetPath: string,
    newSha: string,
    /** The consent the interrupted update meant to record; undefined keeps the old one. */
    componentConsent: ComponentConsent | undefined
  ): Promise<boolean> {
    const { envelope, rawEntries } = await this.readRegistryDocument("strict");
    const rawEntry = rawEntries.find((entry) => this.rawEntryName(entry) === name);
    if (rawEntry === undefined) {
      return true;
    }
    const currentSha = (rawEntry as Record<string, unknown>).lockedSha;
    if (currentSha === newSha) {
      return true;
    }
    const { plugin } = await discoverAgentPluginAt({ pluginDir: targetPath, scope: "global" });
    if (!plugin) {
      log.warn("Promoted update tree has an unreadable manifest; keeping the journal", { name });
      return false;
    }
    await this.writeRegistry(
      envelope,
      rawEntries.map((entry) => {
        if (this.rawEntryName(entry) !== name) {
          return entry;
        }
        const rawRecord = entry as Record<string, unknown>;
        const rawManifest =
          typeof rawRecord.manifest === "object" &&
          rawRecord.manifest !== null &&
          !Array.isArray(rawRecord.manifest)
            ? (rawRecord.manifest as Record<string, unknown>)
            : {};
        // Same raw-patch rules as the update path: only the fields this
        // reconciliation owns are replaced; unknown keys pass through.
        const {
          version: _staleVersion,
          description: _staleDescription,
          ...preservedManifest
        } = rawManifest;
        return {
          ...rawRecord,
          lockedSha: newSha,
          updatedAt: new Date().toISOString(),
          ...recoveredConsentPatch(rawRecord.componentConsent, componentConsent),
          manifest: {
            ...preservedManifest,
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
      })
    );
    log.info(
      `Reconciled registry provenance for '${name}' after an interrupted update (→ ${newSha.slice(0, 12)})`
    );
    return true;
  }

  /**
   * Uninstall crashed between staging the plugin's assets into trash and the
   * registry commit (registry still owns the plugin → restore everything), or
   * between the commit and the trash cleanup (entry gone → finish deleting).
   */
  private async recoverInterruptedUninstall(
    name: string,
    journalPath: string,
    registryNames: Set<string>
  ): Promise<boolean> {
    const journal = await this.readJournalForRecovery(journalPath, name);
    if (journal.unreadable) {
      return false;
    }
    const trashDir = this.journalStagedPath(journal.doc, "trashDir");
    const dataTrashDir = this.journalStagedPath(journal.doc, "dataTrashDir");
    if (!registryNames.has(name)) {
      // Committed: the staged assets are trash. Delete them now — the user
      // may have explicitly requested the data deletion, and stale-staging
      // reclamation only runs during a later staging operation. A failed
      // deletion (e.g. a Windows file lock) RETAINS the journal as the
      // durable retry record; that also keeps same-name reinstalls blocked
      // (install()'s journal gate), so this branch stays the only reachable
      // one for this journal.
      let cleaned = true;
      for (const staged of [trashDir, dataTrashDir]) {
        if (staged === undefined) {
          continue;
        }
        await this.removeDir(staged).catch((error: unknown) => {
          cleaned = false;
          log.warn("Failed to delete staged assets of a committed uninstall; will retry", {
            staged,
            error: getErrorMessage(error),
          });
        });
      }
      return cleaned;
    }
    log.warn("Restoring plugin assets after an uninstall interrupted by a crash", { name });
    let restored = true;
    const targetPath = this.targetPathFor(name);
    if (trashDir !== undefined && (await pathExists(trashDir))) {
      if (await pathExists(targetPath)) {
        // The container path is occupied (e.g. the user manually recreated
        // it): renaming over it would clobber that tree. Leave the staged
        // copy and the journal for manual/later resolution.
        log.warn("Uninstall recovery found the plugin path occupied; keeping the staged tree", {
          name,
        });
        restored = false;
      } else {
        try {
          await fsPromises.mkdir(this.containerDir, { recursive: true });
          await fsPromises.rename(trashDir, targetPath);
        } catch (error) {
          log.warn("Failed to restore plugin tree from an interrupted uninstall", {
            name,
            error: getErrorMessage(error),
          });
          restored = false;
        }
      }
    }
    if (dataTrashDir !== undefined && (await pathExists(dataTrashDir))) {
      const dataPath = getPluginDataPath(this.config.rootDir, this.instanceIdFor(name));
      // A server launch since restart can have recreated a fresh dataPath
      // (prepareStdioLaunch mkdirs it): stop the plugin's servers and clear
      // it so the ORIGINAL data slides back (mirrors the inline rollback).
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(
        buildPluginServerKey(this.instanceIdFor(name), "")
      );
      if (await pathExists(dataPath)) {
        await this.removeDir(dataPath).catch(() => undefined);
      }
      try {
        await fsPromises.mkdir(path.dirname(dataPath), { recursive: true });
        await fsPromises.rename(dataTrashDir, dataPath);
      } catch (error) {
        log.warn("Failed to restore plugin data from an interrupted uninstall", {
          name,
          error: getErrorMessage(error),
        });
        restored = false;
      }
    }
    return restored;
  }

  /** Full inventory deliberately ignores saved imports: package update consent stays unchanged. */
  /**
   * `finalTargetPath` is where the plugin is (or will be) installed. A staged clone passes it so
   * PLUGIN_DATA and the consent fingerprints match what the installed tree loads.
   */
  private async collectComponents(
    plugin: AgentPluginInfo,
    finalTargetPath = path.join(plugin.containerPath, plugin.dirName)
  ) {
    const warnings: string[] = [];
    const skills = await this.collectSkillsFromRoots(plugin, warnings);
    const workflows = await this.collectWorkflowScripts(plugin, warnings);
    const { previews: mcpServers, fingerprints } = await this.collectMcpServers(
      { ...plugin, importedComponents: undefined },
      finalTargetPath,
      computePluginInstanceId(finalTargetPath),
      warnings
    );
    return {
      skills: skills.map(({ name, description, directives }) => ({
        name,
        ...(description !== undefined ? { description } : {}),
        ...directivesField(directives),
      })),
      mcpServers,
      /** What this review showed, as consent fingerprints (#6498). Never sent to the renderer. */
      fingerprints: inventoryFingerprints({
        skills,
        mcpServers: fingerprints,
        workflows,
        agents: await listPluginAgentFiles(plugin.agentsDir, warnings),
        slashCommands: [...slashCommandSurface(plugin)],
      }),
    };
  }

  private validateComponentImports(
    input: AgentPluginImportedComponents,
    inventory: Pick<AgentPluginComponents, "skills" | "mcpServers">
  ): AgentPluginImportedComponents {
    const selection = AgentPluginImportedComponentsSchema.parse(input);
    for (const name of selection.skills) {
      if (!inventory.skills.some((skill) => skill.name === name))
        throw new Error(`Unknown plugin skill '${name}'. Refresh the component inventory.`);
    }
    for (const name of selection.mcpServers) {
      if (!inventory.mcpServers.some((server) => server.serverName === name))
        throw new Error(`Unknown plugin MCP server '${name}'. Refresh the component inventory.`);
    }
    return {
      skills: [...new Set(selection.skills)].sort(),
      mcpServers: [...new Set(selection.mcpServers)].sort(),
    };
  }

  private async readInstalledComponents(
    entry: AgentPluginInstallEntry
  ): Promise<AgentPluginComponents & { fingerprints: ComponentConsent }> {
    const pluginDir = this.targetPathFor(entry.name);
    // Pin reads to one tree even if the installed symlink changes A → B → A
    // between the receipt hashes. Only keys/data paths retain the logical identity.
    const canonicalPluginDir = await fsPromises.realpath(pluginDir);
    const contentHash = await hashPluginTree(canonicalPluginDir, this.stagingQuota());
    const { plugin } = await discoverAgentPluginAt({
      pluginDir: canonicalPluginDir,
      scope: "global",
    });
    if (plugin === null || plugin.name !== entry.name || plugin.rootPath !== canonicalPluginDir)
      throw new Error(`Installed plugin '${entry.name}' is missing or invalid.`);
    const components = await this.collectComponents({
      ...plugin,
      containerPath: path.dirname(pluginDir),
      dirName: entry.name,
    });
    if ((await hashPluginTree(pluginDir, this.stagingQuota())) !== contentHash) {
      throw new Error(
        "Installed plugin files changed during component review. Refresh the component inventory."
      );
    }
    return {
      lockedSha: entry.lockedSha,
      contentHash,
      ...components,
      ...(entry.importedComponents !== undefined
        ? { importedComponents: entry.importedComponents }
        : {}),
    };
  }

  /**
   * The managed plugin's Codex-format hooks (hooks.json) with their trust review state. Read
   * fresh on each call: the review must show what would run now.
   */
  async getHooks(args: { name: string }): Promise<AgentPluginHooks> {
    // The hook load and the trust read are two reads: an update from another process between
    // them could show the old hook as trusted. Bracket both with discovery's journal/epoch gate,
    // as getComponents does (Codex PRRT_kwDOPxxmWM6rb4Tz).
    const { hooks, warnings, trust } = await this.readInsideDiscoveryGate(
      "Plugin files changed during hook review. Refresh the hook review.",
      async () => ({
        ...(await this.loadManagedPluginHooks(args.name)),
        trust: await readPluginHookTrust(this.config.rootDir, this.instanceIdFor(args.name)),
      })
    );
    return {
      hooks: hooks.map((hook) => ({ ...hook, review: reviewStateOf(trust, hook) })),
      warnings,
    };
  }

  /**
   * Trust or turn off one hook definition (or clear the decision with `state: null`). The caller
   * passes the hash it reviewed: if the hook changed since, nothing is recorded, so a trust can
   * never apply to a definition the user did not see.
   */
  async setHookTrust(args: {
    name: string;
    key: string;
    hash: string;
    state: PluginHookTrustState | null;
  }): Promise<void> {
    // Under the plugin mutation lock: an overlapping uninstall (in any process) must not delete
    // the trust file between this check and the write, which would recreate it.
    return this.runExclusive(async () => {
      const { hooks } = await this.loadManagedPluginHooks(args.name);
      const hook = hooks.find((candidate) => candidate.key === args.key);
      if (hook?.hash !== args.hash) {
        throw new Error("This hook changed since you reviewed it. Review it again.");
      }
      if (args.state === "trusted" && hook.status !== "runnable") {
        throw new Error("Xum does not run this hook, so it cannot be trusted.");
      }
      await setPluginHookTrust(this.config.rootDir, this.instanceIdFor(args.name), args);
    });
  }

  /**
   * `name`'s registry row. Strict only for this row: one unparseable row of another plugin (after
   * a downgrade) must not fail hook review and trust for every plugin (Codex
   * PRRT_kwDOPxxmWM6rb4T6). A duplicate or unreadable row for this name still fails.
   */
  private async findOwnRegistryEntry(name: string): Promise<AgentPluginInstallEntry> {
    const { rawEntries } = await this.readRegistryDocument("strict");
    const rows = rawEntries.filter((raw) => this.rawEntryName(raw) === name);
    if (rows.length > 1) {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) contains duplicate entries for '${name}'. Repair the file, then retry.`
      );
    }
    const [entry] = this.parseRegistryEntries(rows, "strict");
    if (rows.length === 1 && entry === undefined) {
      throw new Error(
        `The plugin registry entry for '${name}' cannot be read by this version of Xum (written by a newer version, or corrupted).`
      );
    }
    if (entry === undefined) throw new Error(`No managed plugin named '${name}'.`);
    return entry;
  }

  /** Run `read` inside discovery's journal/epoch bracket; an overlapping installer move throws. */
  private async readInsideDiscoveryGate<T>(changedMessage: string, read: () => Promise<T>) {
    const gate = await journalDerivedDiscoveryGate([this.containerDir]);
    if (gate.suppressed.length > 0) throw new Error(changedMessage);
    const value = await read();
    if ((await gate.confirm()).length > 0) throw new Error(changedMessage);
    return value;
  }

  private async loadManagedPluginHooks(name: string) {
    await this.findOwnRegistryEntry(name);
    const { plugin } = await discoverAgentPluginAt({
      pluginDir: this.targetPathFor(name),
      scope: "global",
    });
    if (plugin === null) throw new Error(`Plugin '${name}' is not readable.`);
    return loadPluginHooks(plugin);
  }

  async getComponents(args: { name: string }): Promise<AgentPluginComponents> {
    // Inventory must not hold the writer lock over full-tree hashes and deny
    // live MCP admission. Reuse discovery's journal/epoch bracket to reject
    // overlapping installer moves, including a complete rollback or reinstall.
    const gate = await journalDerivedDiscoveryGate([this.containerDir]);
    if (gate.suppressed.length > 0) throw await this.closedComponentReviewError();
    const entry = (await this.readRegistry("strict")).find((entry) => entry.name === args.name);
    if (entry === undefined) throw new Error(`No managed plugin named '${args.name}'.`);
    const { fingerprints, ...inventory } = await this.readInstalledComponents(entry);
    assert(fingerprints !== undefined, "installed inventory carries consent fingerprints");
    if ((await gate.confirm()).length > 0) throw componentsChangedError();
    assertDirectivesFit(inventory.skills);
    return inventory;
  }

  /**
   * Why the bracket closed a component review. A pending sign-out also closes it, but then no
   * file changed, and a refresh fails the same way until the sign-out finishes (#6627).
   */
  private async closedComponentReviewError(): Promise<Error> {
    const record = await pendingSignOutsRecordState(this.containerDir);
    return record.kind === "absent"
      ? componentsChangedError()
      : pendingSignOutError(record, shortenHome(this.pendingSignOutsFile));
  }

  async setComponents(args: {
    name: string;
    expectedLockedSha: string;
    expectedContentHash: string;
    expectedImportedComponents: AgentPluginImportedComponents | null;
    importedComponents: AgentPluginImportedComponents;
  }): Promise<{ data: AgentPluginInstallEntry; cleanupWarning?: string }> {
    const selectionKey = (selection: AgentPluginImportedComponents | null) =>
      selection === null
        ? null
        : JSON.stringify([
            [...new Set(selection.skills)].sort(),
            [...new Set(selection.mcpServers)].sort(),
          ]);
    const { data, changed } = await this.runExclusive(async () => {
      const { envelope, rawEntries } = await this.readRegistryDocument("strict");
      const entry = this.parseRegistryEntries(rawEntries, "strict").find(
        (entry) => entry.name === args.name
      );
      if (entry === undefined) throw new Error(`No readable managed plugin named '${args.name}'.`);
      if (entry.lockedSha !== args.expectedLockedSha)
        throw new Error("Plugin changed since component review. Refresh the component inventory.");
      if (
        selectionKey(entry.importedComponents ?? null) !==
        selectionKey(args.expectedImportedComponents)
      )
        throw new Error(
          "Plugin selection changed since component review. Refresh the component inventory."
        );
      const inventory = await this.readInstalledComponents(entry);
      if (inventory.contentHash !== args.expectedContentHash) {
        throw new Error(
          "Plugin files changed since component review. Refresh the component inventory."
        );
      }
      const importedComponents = this.validateComponentImports(args.importedComponents, inventory);
      // An unchanged legacy import-all selection must keep following future package inventory.
      const previous = entry.importedComponents ?? fullSelection(inventory);
      if (selectionKey(importedComponents) === selectionKey(previous))
        return { data: entry, changed: false };
      // Only newly added components were shown for consent (#6498 review B1).
      const componentConsent = consentForSelection({
        selection: importedComponents,
        shown: inventory.fingerprints,
        previous: { selection: previous, consent: entry.componentConsent },
      });
      await this.writeRegistry(
        envelope,
        rawEntries.map((raw) => {
          if (this.rawEntryName(raw) !== entry.name) return raw;
          const record = raw as Record<string, unknown>;
          return {
            ...record,
            importedComponents: {
              ...(record.importedComponents as Record<string, unknown>),
              ...importedComponents,
            },
            componentConsent: mergeRawConsent(record.componentConsent, componentConsent),
          };
        })
      );
      const saved = { ...entry, importedComponents, componentConsent };
      await this.sweepApprovedCopies(saved);
      return { data: saved, changed: true };
    });
    if (!changed) return { data };
    // Persist first and release the mutation lock: reconciliation rediscovers current policy.
    // Never recycle the tree or prune workspace preferences for reversible selections.
    try {
      await this.deps.mcpServerManager?.reconcilePluginComponents();
      return { data };
    } catch (error) {
      const cleanupWarning = `Components saved, but MCP cleanup needs retry: ${getErrorMessage(error)}`;
      log.warn(cleanupWarning, { name: args.name });
      return { data, cleanupWarning };
    }
  }

  /** The bound of startup crash-recovery waits and of each sign-out pass. */
  private get recoveryTimeoutMs(): number {
    return this.deps.reconciliationTimeoutMs ?? JOURNAL_RECONCILIATION_TIMEOUT_MS;
  }

  private get pendingSignOutsFile(): string {
    return path.join(this.config.rootDir, PENDING_SIGN_OUTS_FILE_NAME);
  }

  private async readPendingSignOuts(): Promise<string[]> {
    try {
      const file = this.pendingSignOutsFile;
      // Callers hold the plugin lock: a blocking read of a FIFO would hang the pass and the
      // update. Open without blocking and check the opened file, so a swap between the check
      // and the read cannot slip a FIFO in.
      const handle = await fsPromises.open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile())
          throw new Error(unusableRecordReason({ code: "not a regular file" }, shortenHome(file)));
        return parsePendingSignOuts(await handle.readFile("utf-8"), file);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  private async writePendingSignOuts(urls: string[]): Promise<void> {
    if (urls.length === 0) {
      await fsPromises.rm(this.pendingSignOutsFile, { force: true });
      return;
    }
    await writeFileAtomic(this.pendingSignOutsFile, JSON.stringify({ version: 1, urls }), "utf-8");
  }

  /**
   * Adds `urls` to the pending sign-outs and returns the ones this call added. Callers hold the
   * plugin mutation lock. Throws when the write fails: nothing changed yet, and an unrecorded
   * sign-out would be lost on a crash.
   */
  private async recordPendingSignOuts(urls: string[]): Promise<string[]> {
    if (urls.length === 0) return [];
    const pending = await this.readPendingSignOuts();
    const added = urls.filter((url) => !pending.includes(url));
    if (added.length > 0) await this.writePendingSignOuts([...pending, ...added]);
    return added;
  }

  /**
   * Removes `urls` from the pending sign-outs: they finished, or the update rolled back before
   * the new tree was live. Best effort: a leftover URL only signs the server out once more.
   */
  private async forgetPendingSignOuts(urls: readonly string[]): Promise<void> {
    if (urls.length === 0) return;
    try {
      const pending = await this.readPendingSignOuts();
      await this.writePendingSignOuts(pending.filter((url) => !urls.includes(url)));
    } catch (error) {
      log.warn("Could not update the pending plugin sign-outs", { error: getErrorMessage(error) });
    }
  }

  /** Signs out `urls` after an update; the ones that failed stay pending. */
  private async signOutAndSettle(name: string, urls: string[]): Promise<void> {
    const done: string[] = [];
    // One deadline for every wait of this update: N hung logouts must not hold the lock N times.
    const deadline = monotonicNow() + this.recoveryTimeoutMs;
    for (const serverUrl of urls) {
      if (await this.signOutAfterInFlight(name, serverUrl, deadline)) done.push(serverUrl);
    }
    await this.forgetPendingSignOuts(done);
  }

  /**
   * A timed-out recovery logout can still run: let it settle first, so two logouts never
   * overlap and the earlier one cannot delete a sign-in made after the later one (#6627).
   */
  private async settleInFlightSignOut(
    name: string,
    serverUrl: string,
    deadline: number
  ): Promise<boolean> {
    const key = this.mcpOauthService?.credentialKey(serverUrl) ?? serverUrl;
    const call = this.inFlightSignOuts.get(key);
    if (call === undefined) return true;
    // Bounded: the update holds the plugin lock here, so a hung logout must not hold it forever.
    // On timeout this sign-out counts as failed, and its URL stays in the pending record.
    const settled = await raceWithAbortAndTimeout(
      call.catch(() => undefined),
      { timeoutMs: Math.max(0, deadline - monotonicNow()) }
    );
    if (settled.kind === "ok") return true;
    log.warn("A plugin MCP sign-out waits for an earlier one that has not finished", {
      plugin: name,
    });
    return false;
  }

  /** A sign-out that waits too long for an earlier one fails: its URL stays pending. */
  private async signOutAfterInFlight(
    name: string,
    serverUrl: string,
    deadline: number
  ): Promise<boolean> {
    if (!(await this.settleInFlightSignOut(name, serverUrl, deadline))) return false;
    return this.signOutPluginServer(name, serverUrl, deadline);
  }

  private async signOutPluginServer(
    name: string,
    serverUrl: string,
    deadline: number
  ): Promise<boolean> {
    const oauth = this.mcpOauthService;
    // Bounded and registered like a pass's logout (#6627): a hung one must not hold the plugin
    // lock, and a later pass waits for it instead of starting a second logout.
    const failure =
      oauth === undefined
        ? "sign-in service unavailable"
        : await signOutFailure(oauth, serverUrl, deadline, this.inFlightSignOuts);
    if (failure === undefined) return true;
    log.warn("Could not sign out a plugin MCP server after its sign-in changed", {
      plugin: name,
      error: failure,
    });
    return false;
  }

  /**
   * Finishes the sign-outs that an update recorded but could not complete (#6122). Runs with
   * crash recovery and from the discovery gate. Without the sign-in service it does nothing.
   * Returns true when it tried, and sign-outs are left.
   *
   * The pass holds the plugin mutation lock, so it is bounded like journal recovery: a logout
   * that does not settle in time counts as failed (#6627). Its URL stays in the record, and the
   * lock is released, so a section open, an install or an update does not hang behind it.
   */
  private async completePendingSignOuts(): Promise<boolean> {
    const oauth = this.mcpOauthService;
    if (oauth === undefined || !(await this.hasPendingSignOuts())) return false;
    return this.runExclusive(async () => {
      const deadline = monotonicNow() + this.recoveryTimeoutMs;
      const left: string[] = [];
      const failures: string[] = [];
      for (const serverUrl of await this.readPendingSignOuts()) {
        const failure = await signOutFailure(oauth, serverUrl, deadline, this.inFlightSignOuts);
        if (failure === undefined) continue;
        left.push(serverUrl);
        failures.push(failure);
      }
      await this.writePendingSignOuts(left);
      this.pendingSignOutLastError = failures[0];
      return left.length > 0;
    });
  }

  private hasPendingSignOuts(): Promise<boolean> {
    return containerHasPendingSignOuts(this.containerDir);
  }

  /**
   * Starts a pass that finishes the pending sign-outs, when none runs. The discovery gate never
   * waits for it: it takes the plugin mutation lock, which an update holds while it stops MCP
   * servers. The journal bracket keeps the container closed meanwhile.
   *
   * The slot is set before any await, so callers that overlap share one pass (#6627). The gate
   * passes `retryNow: false`: after a pass that left the record it waits
   * PENDING_SIGN_OUT_RETRY_MS. Startup and section open pass `retryNow: true`: they retry at
   * once, and when a pass already runs they get one more pass after it, because the running
   * pass can have read the record before the user's retry.
   */
  private startPendingSignOutPass(options: { retryNow: boolean }): void {
    if (this.signOutPassRunning(options.retryNow) || this.signOutRetryWaits(options.retryNow))
      return;
    const pass: Promise<void> = this.runPendingSignOutPass().finally(() =>
      this.endPendingSignOutPass(pass)
    );
    this.pendingSignOutPass = pass;
  }

  /** True when a pass runs. A `retryNow` caller then asks for one more pass after it. */
  private signOutPassRunning(retryNow: boolean): boolean {
    if (this.pendingSignOutPass === undefined) return false;
    if (retryNow) this.pendingSignOutRerun = true;
    return true;
  }

  /** True while the gate's wait after a pass that left the record runs. */
  private signOutRetryWaits(retryNow: boolean): boolean {
    return !retryNow && monotonicNow() < this.pendingSignOutRetryAtMs;
  }

  /** Resolves once no pass runs, the passes that `retryNow` callers asked for included. */
  private async settledSignOutPasses(): Promise<void> {
    // endPendingSignOutPass starts a requested pass before the settled one resolves.
    while (this.pendingSignOutPass !== undefined) await this.pendingSignOutPass;
  }

  /** Clears the slot of a settled pass, and starts the pass a `retryNow` caller asked for. */
  private endPendingSignOutPass(pass: Promise<void>): void {
    if (this.pendingSignOutPass !== pass) return;
    this.pendingSignOutPass = undefined;
    if (!this.pendingSignOutRerun) return;
    this.pendingSignOutRerun = false;
    this.startPendingSignOutPass({ retryNow: true });
  }

  /** One pass: finishes the record, and schedules the next gate retry when it is left. */
  private async runPendingSignOutPass(): Promise<void> {
    // A pass before the sign-in service is wired tries nothing, so it sets no wait.
    const left = await this.completePendingSignOuts().catch((error: unknown) => {
      // An unreadable record stays: it keeps discovery closed until the user deletes it.
      this.pendingSignOutLastError = getErrorMessage(error);
      log.warn("Could not finish pending plugin sign-outs", {
        error: this.pendingSignOutLastError,
      });
      return true;
    });
    this.pendingSignOutRetryAtMs = left ? monotonicNow() + PENDING_SIGN_OUT_RETRY_MS : 0;
  }

  private pendingSignOutPass: Promise<void> | undefined;
  /** Why the last pass left the record; shown in Settings (pendingSignOutStatus). */
  private pendingSignOutLastError: string | undefined;

  /**
   * The pending sign-out record for Settings → Plugins (#6627). While it exists, managed plugins
   * are unavailable to agents, so Settings names it and the recovery step. Never throws.
   */
  async pendingSignOutStatus(): Promise<AgentPluginPendingSignOuts> {
    // Settings re-reads this while the notice shows: retry like the discovery gate does (at most
    // once per PENDING_SIGN_OUT_RETRY_MS), so a fixed cause clears without an agent request.
    this.startPendingSignOutPass({ retryNow: false });
    // Report the retry's result when it is quick; a slow logout is reported on the next read.
    await waitForPendingSignOuts(this.settledSignOutPasses(), STATUS_RETRY_WAIT_MS);
    return this.currentSignOutStatus();
  }

  /**
   * The plugin list and the pending sign-out record for Settings → Plugins, in one call (#6627).
   * The record reads start no sign-out pass: only the list's section-open recovery retries, so
   * one refresh makes at most one attempt. When the record existed before the list and is gone
   * after it, the list may hold the rows the record hid during its scan: list once more.
   */
  async listForSettings(): Promise<{
    list: Awaited<ReturnType<AgentPluginInstallService["listResult"]>>;
    pendingSignOuts: AgentPluginPendingSignOuts;
  }> {
    const before = await this.currentSignOutStatus();
    // A failed list must not hide the record: its notice holds the recovery control.
    let list = await this.listResult();
    // Report the list's retry when it is quick; a slow logout shows on the next refresh.
    await waitForPendingSignOuts(this.settledSignOutPasses(), STATUS_RETRY_WAIT_MS);
    const pendingSignOuts = await this.currentSignOutStatus();
    if (before.kind !== "none" && pendingSignOuts.kind === "none") list = await this.listResult();
    return { list, pendingSignOuts };
  }

  /** The record as it is now, without starting a pass. Never throws. */
  private async currentSignOutStatus(): Promise<AgentPluginPendingSignOuts> {
    const record = await pendingSignOutsRecordState(this.containerDir);
    if (record.kind === "absent") {
      // An old record's failure must not describe the next one.
      this.pendingSignOutLastError = undefined;
      return { kind: "none" };
    }
    return this.readPendingSignOutStatus(record);
  }

  /** The status of an existing record (see pendingSignOutStatus). */
  private async readPendingSignOutStatus(
    record: { kind: "present" } | { kind: "unreadable"; code: string }
  ): Promise<AgentPluginPendingSignOuts> {
    const file = shortenHome(this.pendingSignOutsFile);
    // A special file (a FIFO would block the read) is reported without reading it.
    if (record.kind === "unreadable")
      return { kind: "broken", reason: unusableRecordReason({ code: record.code }, file) };
    let servers: string[];
    try {
      servers = await this.readPendingSignOuts();
    } catch (error) {
      return { kind: "broken", reason: unusableRecordReason(error, file) };
    }
    // An empty record still fences discovery while it exists (the next pass deletes it).
    const lastError = this.pendingSignOutLastError;
    return {
      kind: "pending",
      servers: servers.map(displaySignOutUrl),
      ...(lastError !== undefined ? { lastError } : {}),
    };
  }

  /**
   * Signs out of every remote MCP server of every installed managed plugin and of every URL the
   * record names, then deletes the record (#6627). This is the recovery for a corrupt, newer or
   * unreadable record: it fences discovery, so Settings → MCP shows no plugin server to sign out
   * of, and deleting the file first would let an agent load a plugin with its old sign-in.
   *
   * The servers come from the plugin trees, not from discovery: only a plugin's own servers can
   * use its stored sign-ins, so signing all of them out covers every URL the record can name for
   * a plugin that still loads. Holds the plugin lock like a pass (no update can add a record
   * meanwhile) and shares its deadline and in-flight logouts. Throws, and keeps the record, when
   * any sign-out fails.
   */
  async signOutPluginServers(): Promise<void> {
    const oauth = this.mcpOauthService;
    if (oauth === undefined) throw new Error("The MCP sign-in service is not ready yet.");
    await this.runExclusive(async () => {
      const record = await pendingSignOutsRecordState(this.containerDir);
      if (record.kind === "absent") return;
      // Read only a regular file: readFile on a FIFO blocks while this holds the lock.
      const recorded = record.kind === "present" ? await this.recordedUrlsForRecovery() : [];
      await this.signOutEach(oauth, [...recorded, ...(await this.installedPluginServerUrls())]);
      // Sign out first, delete last (see parsePendingSignOuts). A non-regular record (a
      // directory) is Xum's own path too: remove it whole, or the fence never opens.
      if (record.kind === "unreadable")
        await fsPromises.rm(this.pendingSignOutsFile, { recursive: true, force: true });
      else await this.writePendingSignOuts([]);
      this.pendingSignOutLastError = undefined;
      this.pendingSignOutRetryAtMs = 0;
    });
  }

  /**
   * The URLs a regular-file record names, for the recovery. A corrupt record names none. A record
   * of another version still names its `urls` when they read as strings. One that does not keeps
   * the fence: it can name a URL that no current plugin tree has (an update changed it), and
   * deleting it would leave that sign-in in place.
   */
  private async recordedUrlsForRecovery(): Promise<string[]> {
    const file = this.pendingSignOutsFile;
    let record: unknown;
    try {
      record = JSON.parse(await fsPromises.readFile(file, "utf-8"));
    } catch (error) {
      if (error instanceof SyntaxError) return [];
      throw error;
    }
    return recoveryUrls(record, shortenHome(file));
  }

  /** Signs out of each credential once, within one pass deadline; throws on the first failure. */
  private async signOutEach(
    oauth: Pick<McpOauthService, "logout" | "credentialKey">,
    urls: readonly string[]
  ): Promise<void> {
    const deadline = monotonicNow() + this.recoveryTimeoutMs;
    const done = new Set<string>();
    for (const serverUrl of urls) {
      const key = oauth.credentialKey(serverUrl) ?? serverUrl;
      if (done.has(key)) continue;
      const failure = await signOutFailure(oauth, serverUrl, deadline, this.inFlightSignOuts);
      if (failure !== undefined)
        throw new Error(`Could not sign out of ${displaySignOutUrl(serverUrl)}: ${failure}`);
      done.add(key);
    }
  }

  /** The URLs of the remote MCP servers in every plugin tree of the managed container. */
  private async installedPluginServerUrls(): Promise<string[]> {
    const dirs = await fsPromises.readdir(this.containerDir).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    });
    // Every registry name, unreadable entries included: their trees are installed plugins.
    const { rawEntries } = await this.readRegistryDocument("strict");
    const installed = new Set(rawEntries.map((entry) => this.rawEntryName(entry)));
    const urls: string[] = [];
    for (const dirName of dirs)
      urls.push(...(await this.pluginTreeServerUrls(dirName, installed.has(dirName))));
    return urls;
  }

  /** One plugin tree's remote MCP server URLs; throws when the tree's servers cannot be read. */
  private async pluginTreeServerUrls(dirName: string, installed: boolean): Promise<string[]> {
    // Plugin trees are directories (or links to one), dot-prefixed names included, as discovery
    // scans them. Skip stray files such as .DS_Store and dangling links: neither loads. Any other
    // stat failure (EACCES, EIO) can hide a tree that loads after a repair: it keeps the record.
    const pluginDir = path.join(this.containerDir, dirName);
    const stat = await fsPromises.stat(pluginDir).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (stat?.isDirectory() !== true) return [];
    // A server this scan cannot read can load later, after a repair, with its old sign-in:
    // the list must be complete before the record goes.
    const scan = await discoverAgentPluginAt({ pluginDir, scope: "global" });
    const { diagnostics } = scan;
    const plugin = pluginWithReadableMcp(dirName, scan, installed);
    if (plugin === null) return [];
    // Without an MCP file, a discovery error can be the MCP path itself. With one, a discovery
    // error names another component (a skill, a hook), and only the MCP diagnostics decide.
    const loaded =
      plugin.mcpConfigPath === undefined
        ? { servers: {}, diagnostics }
        : await loadPluginMcpServers(plugin, {
            xumHome: this.config.rootDir,
            // From the lexical path, as discovery does: an unmanaged tree's directory name need
            // not be a valid managed-plugin name.
            instanceId: computePluginInstanceId(pluginDir),
          });
    const error = loaded.diagnostics.find((d) => d.severity === "error");
    if (error !== undefined)
      throw new Error(`Xum cannot read the MCP servers of plugin '${dirName}': ${error.message}`);
    return Object.values(loaded.servers).flatMap((info) =>
      info.transport === "stdio" ? [] : [info.url]
    );
  }

  /** Logouts a pass started that have not settled yet (see signOutFailure). */
  private readonly inFlightSignOuts = new Map<
    string,
    Promise<Awaited<ReturnType<McpOauthService["logout"]>>>
  >();
  /** See startPendingSignOutPass. On the monotonic clock: a wall-clock jump must not move it. */
  private pendingSignOutRetryAtMs = 0;
  /** See signOutPassRunning. */
  private pendingSignOutRerun = false;

  /** Managed registry entries merged with unmanaged plugins found by global discovery. */
  /** The OAuth service is built in a later DI layer than this service. */
  setMcpOauthService(service: Pick<McpOauthService, "logout" | "credentialKey">): void {
    this.mcpOauthService = service;
    // The startup pass ran without this service: finish pending sign-outs now, before the
    // first agent request scans the container.
    // Bounded like journal recovery: a hung logout (stalled store I/O) must not hang every
    // discovery request. On timeout discovery goes on, and the journal bracket keeps the
    // container closed while the sign-out is still pending.
    this.startPendingSignOutPass({ retryNow: true });
    this.pendingSignOutReady = waitForPendingSignOuts(
      this.settledSignOutPasses(),
      this.deps.reconciliationTimeoutMs
    );
  }

  /** Started by setMcpOauthService. */
  private pendingSignOutReady: Promise<void> = Promise.resolve();

  async list(): Promise<AgentPluginListItem[]> {
    // Section open re-runs crash recovery (the startup pass may have failed
    // or predates recent journals) BEFORE discovery scans the container, so
    // an orphaned promotion never renders as an unmanaged row and interrupted
    // update/uninstall swaps are restored before their rows would look wrong.
    // Reassigning the state BEFORE awaiting lets a concurrent discovery gate
    // wait on this fresh attempt (reconcileJournals serializes internally via
    // runExclusive); a success here re-opens a previously suppressed
    // container.
    await this.pendingSignOutReady;
    await this.reconciliationState;
    this.reconciliationState = this.attemptReconcileJournals("section open");
    await this.reconciliationState;

    // Section open is the natural retry moment for override-prune tombstones
    // left by uninstalls whose workspaces were temporarily unreachable.
    await this.retryPendingOverridePrunes().catch((error: unknown) => {
      log.warn("Failed to retry pending override prunes", { error: getErrorMessage(error) });
    });

    const registry = await this.readRegistry("lenient");
    const containers: AgentPluginContainer[] = [
      { path: this.containerDir, scope: "global", registryPath: this.registryFile },
      { path: path.join(os.homedir(), ".agents", "plugins"), scope: "global" },
    ];
    const { plugins } = await discoverAgentPlugins(containers);

    const items: AgentPluginListItem[] = [];
    const managedByName = new Map(registry.map((entry) => [entry.name, entry]));

    for (const plugin of plugins) {
      const isManagedLocation =
        plugin.containerPath === this.containerDir && managedByName.has(plugin.dirName);
      const entry = isManagedLocation ? managedByName.get(plugin.dirName) : undefined;
      if (entry) {
        managedByName.delete(plugin.dirName);
      }

      const inventory = await this.collectComponents(plugin);
      const skillCount = inventory.skills.length;
      const mcpServerCount = inventory.mcpServers.length;
      const selection = plugin.importedComponents;

      // Managed rows keep their REGISTRY identity: update/uninstall look
      // entries up by this name, so a locally edited/corrupted manifest name
      // must not make the row unrepairable from Settings. The drift is still
      // surfaced in the description.
      const manifestNameDrift =
        entry !== undefined && plugin.name !== entry.name
          ? `plugin.json names itself '${plugin.name}' — the installed name '${entry.name}' stays authoritative.`
          : undefined;
      const description = manifestNameDrift ?? plugin.manifest.description;
      // The install preview already disclosed logo problems; the row only shows what loads.
      const openaiInterface = await interfaceSummary(plugin, []);
      items.push({
        name: entry?.name ?? plugin.name,
        managed: entry !== undefined,
        present: true,
        location: shortenHome(path.join(plugin.containerPath, plugin.dirName)),
        ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(openaiInterface !== undefined ? { interface: openaiInterface } : {}),
        ...(entry !== undefined
          ? {
              source: entry.source,
              lockedSha: entry.lockedSha,
              installedAt: entry.installedAt,
              ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
            }
          : {}),
        skillCount,
        mcpServerCount,
        ...(entry?.importedComponents !== undefined
          ? { importedComponents: entry.importedComponents }
          : {}),
        importedSkillCount: inventory.skills.filter(
          (skill) => selection === undefined || selection.skills.includes(skill.name)
        ).length,
        importedMcpServerCount: inventory.mcpServers.filter(
          (server) => selection === undefined || selection.mcpServers.includes(server.serverName)
        ).length,
        ...reviewRequiredField(entry, inventory.fingerprints, await countAmbiguousAgents(plugin)),
      });
    }

    // Registry entries whose directory vanished (self-heal display; uninstall still works).
    for (const entry of managedByName.values()) {
      items.push({
        name: entry.name,
        managed: true,
        present: false,
        location: shortenHome(this.targetPathFor(entry.name)),
        ...(entry.manifest?.version !== undefined ? { version: entry.manifest.version } : {}),
        ...(entry.manifest?.description !== undefined
          ? { description: entry.manifest.description }
          : {}),
        source: entry.source,
        lockedSha: entry.lockedSha,
        installedAt: entry.installedAt,
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        skillCount: 0,
        mcpServerCount: 0,
        importedSkillCount: 0,
        importedMcpServerCount: 0,
        ...(entry.importedComponents !== undefined
          ? { importedComponents: entry.importedComponents }
          : {}),
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Uninstall: delete dir + registry entry + prune that plugin's per-workspace
   * MCP overrides (reinstall re-attaches the same instanceId, so stale
   * overrides would silently re-enable servers — violating default-disabled).
   * PLUGIN_DATA is preserved unless `deletePluginData` is set.
   */
  async uninstall(args: { name: string; deletePluginData: boolean }): Promise<void> {
    return this.runExclusive(async () => {
      const { envelope, rawEntries: rawRegistry } = await this.readRegistryDocument("strict");
      const registry = this.parseRegistryEntries(rawRegistry, "strict");
      const entry = registry.find((e) => e.name === args.name);
      if (!entry) {
        throw new Error(`'${args.name}' is not a managed plugin install.`);
      }

      // An unresolved update journal means the tree at the target may be a
      // USER-PLACED replacement (recovery refused to identify it), not the
      // managed install: uninstalling would stage and delete the user's tree,
      // and the next reconciliation would discard the recoverable original
      // because its registry entry is gone. Refuse until recovery resolves.
      if (await pathExists(this.journalPath(UPDATE_JOURNAL_PREFIX, args.name))) {
        throw new Error(
          `A previous update of '${args.name}' has unfinished recovery. Open Settings → Plugins to let recovery complete, then try again.`
        );
      }
      // Same for an unresolved UNINSTALL journal (a previous uninstall's
      // restore failed while the registry still owns the plugin): the
      // unconditional journal write below would replace the only references
      // to the original trashDir/dataTrashDir, orphaning the recoverable
      // assets for stale reclamation while this retry commits against a
      // missing or replaced target.
      if (await pathExists(this.journalPath(UNINSTALL_JOURNAL_PREFIX, args.name))) {
        throw new Error(
          `A previous uninstall of '${args.name}' has unfinished cleanup. Open Settings → Plugins to let recovery complete, then try again.`
        );
      }

      const targetPath = this.targetPathFor(entry.name);
      const instanceId = this.instanceIdFor(entry.name);
      const serverKeyPrefix = buildPluginServerKey(instanceId, "");

      // Enumerate pruning targets BEFORE committing anything: if this fails,
      // the uninstall aborts with the install fully intact (retryable from
      // Settings) instead of leaving stale overrides behind post-commit.
      const workspaceIdsToPrune = await this.listWorkspaceIdsForOverridePruning();

      // A newer build's pendingOverridePrunes shape is opaque to this build,
      // so the pessimistic tombstone below could only clobber it. Refuse
      // up-front (install fully intact) rather than destroy that build's
      // cleanup metadata — or silently skip recording our own.
      if (workspaceIdsToPrune.length > 0 && this.hasOpaquePendingPrunes(envelope)) {
        throw new Error(
          `The plugin registry (${shortenHome(this.registryFile)}) contains pending cleanup state written by a newer version of Mux. Run the uninstall with that version, or let it finish its cleanup first.`
        );
      }

      // Stop running servers before deleting the tree out from under them.
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);

      // Stage the tree — and, when requested, the plugin-data dir — out
      // BEFORE touching the registry so every step can fail without partial
      // state: a failed rename (e.g. a locked file on Windows) leaves the
      // install fully intact, and a failed registry write renames everything
      // back. Deleting the staged dirs afterwards is best-effort — they sit
      // under the staging root, where stale-dir reclamation cleans up
      // leftovers, so a locked dir cannot strand the user in a state where
      // the Settings row is gone but their requested cleanup never happens.
      await fsPromises.mkdir(this.stagingRoot, { recursive: true });
      const trashDir = path.join(this.stagingRoot, `trash-${Date.now()}-${entry.name}`);
      const dataTrashDir = path.join(this.stagingRoot, `trash-data-${Date.now()}-${entry.name}`);

      // Journal the transaction BEFORE anything moves: a crash between the
      // renames below and the registry commit would otherwise leave the
      // registry owning a plugin whose tree (and optionally its data) is
      // hidden under plugin-staging with nothing to restore it — the next
      // list shows a missing install and a retried uninstall commits on
      // ENOENT while the staged assets linger. reconcileJournals restores
      // them while the registry entry still exists, and finishes the trash
      // cleanup once the commit landed.
      const uninstallJournalPath = this.journalPath(UNINSTALL_JOURNAL_PREFIX, entry.name);
      await this.writeJournalFile(uninstallJournalPath, {
        name: entry.name,
        trashDir,
        dataTrashDir,
        stagedAt: Date.now(),
      });
      const consumeJournal = async (): Promise<void> => {
        await this.consumeJournalFile(uninstallJournalPath).catch(() => undefined);
      };

      let stagedTree = false;
      try {
        await this.renameIntoStaging(targetPath, trashDir);
        stagedTree = true;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          await consumeJournal(); // Nothing moved: no recovery needed.
          throw new Error(`Failed to remove the plugin directory: ${getErrorMessage(error)}`);
        }
        // Missing tree (present:false row): registry-only uninstall.
      }

      /** Returns true when nothing remained staged (safe to consume the journal). */
      const restoreTree = async (context: string): Promise<boolean> => {
        if (!stagedTree) {
          return true;
        }
        return fsPromises.rename(trashDir, targetPath).then(
          () => {
            this.activeStagingPaths.delete(trashDir);
            return true;
          },
          (rollbackError: unknown) => {
            // Keep the journal: reconcileJournals restores the staged tree
            // on the next startup/section open.
            log.error(`Failed to restore plugin dir after ${context}`, {
              targetPath,
              rollbackError,
            });
            return false;
          }
        );
      };

      // Stage out before the serialized prune: a toggle validated against the
      // old tree finishes before pruning, while later toggles cannot discover it.
      // Rollback never restores old consent: a successful write followed by a
      // lock-release failure may already have revoked global enablement.
      try {
        await this.deps.mcpConfigService?.pruneEnabledPluginServers(serverKeyPrefix);
      } catch (error) {
        if (await restoreTree("failed global MCP enablement prune")) {
          await consumeJournal();
        }
        throw new Error(`Failed to prune global MCP enablement: ${getErrorMessage(error)}`);
      }

      const dataPath = getPluginDataPath(this.config.rootDir, instanceId);
      let stagedData = false;
      if (args.deletePluginData) {
        try {
          await this.renameIntoStaging(dataPath, dataTrashDir);
          stagedData = true;
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) {
            // Fail BEFORE the registry commit so the row stays and the user
            // can retry the requested cleanup.
            if (await restoreTree("failed plugin-data staging")) {
              await consumeJournal();
            }
            throw new Error(`Failed to remove the plugin data: ${getErrorMessage(error)}`);
          }
          // No data dir: nothing to delete.
        }
      }

      // The commit write carries a PESSIMISTIC tombstone for every workspace
      // that needs pruning: if a prune later fails — or the best-effort
      // shrink write below fails — the durable record already exists.
      // Over-blocking a reinstall until cleanup is confirmed is safe;
      // silently losing the record (stale enabledServers reactivating a
      // reinstalled server) is not.
      const commitEnvelope = { ...envelope };
      const pendingForCommit = this.updateRawPendingPrunes(
        this.rawPendingPrunes(envelope),
        serverKeyPrefix,
        workspaceIdsToPrune
      );
      if (this.hasOpaquePendingPrunes(envelope)) {
        // Opaque newer-build shape rides through verbatim (kept by the
        // spread above; the up-front guard ensured nothing needs recording).
      } else if (pendingForCommit.length > 0) {
        commitEnvelope.pendingOverridePrunes = pendingForCommit;
      } else {
        delete commitEnvelope.pendingOverridePrunes;
      }
      try {
        // Before the commit, so a failure leaves trust and approved copies cleared (fail closed)
        // rather than kept for a later install under this name.
        await removePluginHookTrust(this.config.rootDir, this.instanceIdFor(entry.name));
        await removeApprovedCopies(this.config.rootDir, this.instanceIdFor(entry.name));
        await this.writeRegistry(
          commitEnvelope,
          rawRegistry.filter((rawEntry) => this.rawEntryName(rawEntry) !== entry.name)
        );
      } catch (error) {
        const treeRestored = await restoreTree("failed registry write");
        let dataRestored = true;
        if (stagedData) {
          // A getToolsForWorkspace startup that began after the pre-stage
          // invalidation can have recreated dataPath (prepareStdioLaunch
          // mkdirs it) while the registry write failed. Invalidate again so
          // no late server publishes against the restored install, then
          // remove the recreated (fresh, empty) directory — otherwise the
          // rename below EEXIST-fails and strands the ORIGINAL data in
          // staging while the still-installed plugin sees an empty data dir.
          try {
            await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
          } catch (stopError) {
            log.warn("Failed to re-invalidate plugin servers during data rollback", {
              serverKeyPrefix,
              error: getErrorMessage(stopError),
            });
          }
          if (await pathExists(dataPath)) {
            await this.removeDir(dataPath).catch(() => undefined);
          }
          dataRestored = await fsPromises.rename(dataTrashDir, dataPath).then(
            () => {
              this.activeStagingPaths.delete(dataTrashDir);
              return true;
            },
            (rollbackError: unknown) => {
              // Keep the journal: reconcileJournals restores the staged data
              // on the next startup/section open.
              log.error("Failed to restore plugin data after failed registry write", {
                dataPath,
                rollbackError,
              });
              return false;
            }
          );
        }
        if (treeRestored && dataRestored) {
          await consumeJournal();
        }
        throw new Error(`Failed to persist the plugin registry: ${getErrorMessage(error)}`);
      }

      // The uninstall is committed; everything below is best-effort cleanup
      // that must not abort the remaining steps.
      let trashCleaned = true;
      if (stagedTree) {
        await this.removeDir(trashDir).catch((error: unknown) => {
          trashCleaned = false;
          log.warn("Failed to delete uninstalled plugin tree; recovery will retry", {
            trashDir,
            error: getErrorMessage(error),
          });
        });
      }
      let dataDeletionFailure: string | undefined;
      if (stagedData) {
        // The user EXPLICITLY requested this deletion, so a failure (e.g. a
        // locked file on Windows) must surface rather than report success:
        // stale-staging reclamation only runs during a later staging
        // operation, which may never happen.
        await this.removeDir(dataTrashDir).catch((error: unknown) => {
          trashCleaned = false;
          dataDeletionFailure = `The plugin was uninstalled, but deleting its stored data failed (${getErrorMessage(error)}). The data was moved to ${shortenHome(dataTrashDir)} — delete it manually.`;
          log.warn("Failed to delete plugin data; recovery will retry", {
            dataTrashDir,
            error: getErrorMessage(error),
          });
        });
      }
      // Consume the journal only once every staged asset is gone: a retained
      // committed journal is the durable retry record for the failed cleanup
      // (recoverInterruptedUninstall's committed branch finishes it), and it
      // blocks same-name reinstalls until then — with the entry gone,
      // recovery can never misread this journal as an uncommitted uninstall
      // and restore the assets.
      if (trashCleaned) {
        await consumeJournal();
      }

      // Re-invalidate AFTER the tree is gone: a getToolsForWorkspace call
      // that started right after the pre-rename stop snapshots the new epoch,
      // and can still have discovered the plugin before the rename — its
      // freshly started server would otherwise publish validly and keep
      // running from the removed tree. This runs BEFORE override pruning so
      // pruning problems cannot skip the correctness-critical invalidation.
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);

      // Workspaces registered AFTER the pre-commit enumeration escaped both
      // the pessimistic tombstone and the prune list, yet until the tree
      // removal + re-invalidation above their MCP dialogs could still save a
      // valid enable for this plugin's servers (save-time validation saw the
      // then-present tree). Re-enumerate now that no new valid enable can be
      // saved and fold the delta in. A failed re-enumeration skips the
      // tombstone shrink below, keeping the pessimistic record.
      let pruneIds = workspaceIdsToPrune;
      let postCommitEnumerated = true;
      let deltaRecordFailure: string | undefined;
      try {
        const postCommitIds = await this.listWorkspaceIdsForOverridePruning();
        pruneIds = [...new Set([...workspaceIdsToPrune, ...postCommitIds])];
      } catch (error) {
        postCommitEnumerated = false;
        log.warn(
          "Failed to re-enumerate workspaces after uninstall commit; keeping the pessimistic tombstone",
          { error: getErrorMessage(error) }
        );
        if (workspaceIdsToPrune.length === 0) {
          // Zero workspaces at commit time means the commit wrote NO
          // tombstone for this prefix, yet a workspace registered during the
          // uninstall could have saved an enable while the tree was still
          // present — and this failed re-enumeration was the only chance to
          // find it. The tombstone's PRESENCE is what drives retry-side live
          // re-enumeration, so persist an empty SENTINEL record; retries
          // clear it only after a full live sweep succeeds. If even that
          // write fails, surface the gap to the user (after the remaining
          // cleanup below).
          try {
            const { envelope: envelopeSentinel, rawEntries: entriesSentinel } =
              await this.readRegistryDocument("strict");
            if (this.hasOpaquePendingPrunes(envelopeSentinel)) {
              // Recording into a newer build's opaque shape would clobber it
              // (same reasoning as the pre-commit guard, which only runs when
              // commit-time workspaces existed).
              throw new Error(
                "the registry's pending cleanup state was written by a newer version of Mux"
              );
            }
            const pendingSentinel = this.updateRawPendingPrunes(
              this.rawPendingPrunes(envelopeSentinel),
              serverKeyPrefix,
              [],
              { keepEmpty: true }
            );
            await this.writePendingOverridePrunes(
              envelopeSentinel,
              entriesSentinel,
              pendingSentinel
            );
          } catch (sentinelError) {
            deltaRecordFailure = `The plugin was uninstalled, but workspaces registered during the uninstall could not be checked for stale MCP overrides and recording a cleanup reminder failed (${getErrorMessage(sentinelError)}). If reinstalling this plugin, first check workspace MCP settings for stale entries.`;
          }
        }
      }
      // Delta workspaces are NOT in the commit-time tombstone. Persist the
      // union BEFORE pruning so a crash between here and their prune keeps a
      // precise durable record. A failed persist is still covered as long as
      // ANY tombstone for this prefix exists: retryPrune re-enumerates live
      // workspaces on every retry, so the pessimistic commit-time record
      // reaches the delta too. Only when no tombstone exists at all (zero
      // workspaces at commit time) is the delta unrecorded — surfaced to the
      // user at the end, after all remaining cleanup ran.
      if (postCommitEnumerated && pruneIds.length > workspaceIdsToPrune.length) {
        try {
          const { envelope: envelopeDelta, rawEntries: entriesDelta } =
            await this.readRegistryDocument("strict");
          const pendingDelta = this.updateRawPendingPrunes(
            this.rawPendingPrunes(envelopeDelta),
            serverKeyPrefix,
            pruneIds
          );
          await this.writePendingOverridePrunes(envelopeDelta, entriesDelta, pendingDelta);
        } catch (error) {
          if (workspaceIdsToPrune.length === 0) {
            deltaRecordFailure = `The plugin was uninstalled, but recording override cleanup for workspaces registered during the uninstall failed (${getErrorMessage(error)}). If reinstalling this plugin, first check the MCP settings of workspaces ${pruneIds.join(", ")} for stale entries.`;
          }
          log.warn(
            "Failed to persist post-commit workspace delta into the prune tombstone; keeping the pessimistic record",
            { error: getErrorMessage(error) }
          );
        }
      }

      // Per-workspace failures are caught inside; the failure-prone
      // enumeration already happened pre-commit and the pessimistic
      // tombstone is already durable (commit write above). Shrink it to what
      // actually failed — best-effort: a failed shrink leaves the over-broad
      // tombstone, which self-heals on the next retry (section open or the
      // reinstall gate). The shrink is gated on the re-enumeration only, not
      // on the delta persist above: failedPruneIds covers the full union, so
      // a successful shrink IS the durable record for failed delta prunes.
      const failedPruneIds = await this.pruneWorkspaceOverrides(serverKeyPrefix, pruneIds);
      if (pruneIds.length > 0 && postCommitEnumerated) {
        // STRICT re-read for the shrink: a lenient read degrading a transient
        // I/O error or corruption to an empty document would make this write
        // rewrite plugins.json with an empty plugin list, orphaning every
        // other managed install. On any failure the pessimistic tombstone
        // from the commit write simply stays (safe, self-heals on retry).
        try {
          const { envelope: envelopeAfter, rawEntries: entriesAfter } =
            await this.readRegistryDocument("strict");
          const pendingAfter = this.updateRawPendingPrunes(
            this.rawPendingPrunes(envelopeAfter),
            serverKeyPrefix,
            failedPruneIds
          );
          await this.writePendingOverridePrunes(envelopeAfter, entriesAfter, pendingAfter);
          // This write durably recorded every still-failing prune (the
          // failed list covers the delta), so the earlier delta persist
          // failure no longer needs surfacing.
          deltaRecordFailure = undefined;
        } catch (error) {
          log.warn("Failed to shrink pending override prune tombstone (kept pessimistic)", {
            serverKeyPrefix,
            failedPruneIds,
            error: getErrorMessage(error),
          });
        }
      }

      log.info(`Uninstalled agent plugin '${entry.name}'`);
      // Thrown LAST so the remaining cleanup above (invalidation, override
      // pruning) still ran; the uninstall itself is committed and the message
      // says so.
      const commitFailures = [dataDeletionFailure, deltaRecordFailure].filter(
        (message): message is string => message !== undefined
      );
      if (commitFailures.length > 0) {
        throw new Error(commitFailures.join(" "));
      }
    });
  }

  /**
   * Enumerate the local/worktree workspace IDs whose MCP overrides an
   * uninstall must prune. Called BEFORE the uninstall commits anything:
   * enumeration is the only pruning step that can fail wholesale (outside
   * the per-workspace catch), and a post-commit failure would leave stale
   * overrides with no Settings row left to retry from — a reinstall reuses
   * the same instance ID and would silently re-enable those servers.
   * Remote runtimes are skipped — they never see plugin servers
   * (resolveAgentPluginsMcpContext returns null off-host).
   */
  private async listWorkspaceIdsForOverridePruning(): Promise<string[]> {
    if (!this.deps.workspaceMcpOverridesService) {
      return [];
    }
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    return allMetadata
      .filter((metadata) => {
        const runtimeType = metadata.runtimeConfig.type;
        return runtimeType === "local" || runtimeType === "worktree";
      })
      .map((metadata) => metadata.id);
  }

  /**
   * Remove `plugin:<instanceId>:*` keys from the given workspaces' MCP
   * overrides. Best-effort per workspace: a missing checkout must not block
   * uninstall. Returns the workspace IDs whose prune FAILED so callers can
   * persist a retryable tombstone — silently discarding a failure would let
   * a reinstall (same instance ID) pick up the stale override and re-enable
   * the server without consent.
   */
  private async pruneWorkspaceOverrides(
    serverKeyPrefix: string,
    workspaceIds: string[]
  ): Promise<string[]> {
    const overridesService = this.deps.workspaceMcpOverridesService;
    if (!overridesService) {
      return [];
    }
    if (workspaceIds.length === 0) {
      return [];
    }
    // Raw in-queue patch: preserves unknown fields written by newer
    // builds, throws on unreadable files (tombstone retry), and cannot
    // interleave with a dialog save (shared exclusive write queue).
    //
    // The publish hook repairs MCPServerManager's in-memory override
    // cache INSIDE that same write queue: latestWorkspaceOverrides wins
    // over freshly read overrides, so a workspace that once enabled this
    // plugin's server would otherwise keep serving the stale enable — and
    // a same-name reinstall's default-disabled server could start without
    // a fresh user action. In-queue publication also keeps the ordering
    // consistent with concurrent dialog saves (whichever writes disk last
    // publishes last). A failure keeps the tombstone so cache repair is
    // retried too.
    //
    // One batched call, not one prune per workspace: every workspace in
    // config is swept here, and the per-workspace variant re-resolves
    // metadata from a full config.json parse each time — with thousands of
    // workspaces that made installs sit on "Installing…" for half an hour.
    const mcpServerManager = this.deps.mcpServerManager;
    let failures: Array<{ workspaceId: string; error: unknown }>;
    try {
      failures = await overridesService.prunePluginOverrideKeysForWorkspaces(
        workspaceIds,
        serverKeyPrefix,
        mcpServerManager
          ? {
              publish: (persisted, target) =>
                persisted === null
                  ? Promise.resolve(
                      target === ALL_WORKSPACES_TARGET
                        ? mcpServerManager.forgetAllWorkspaceOverrides()
                        : mcpServerManager.forgetWorkspaceOverrides(target)
                    )
                  : mcpServerManager.applyWorkspaceOverrides(target, persisted),
              hasSnapshot: (workspaceId) =>
                mcpServerManager.hasWorkspaceOverridesSnapshot(workspaceId),
            }
          : undefined
      );
    } catch (error) {
      // Wholesale failure (lock timeout, unreadable config): no workspace was
      // verified, so every one keeps its tombstone.
      log.warn("Failed to prune plugin MCP overrides", { error: getErrorMessage(error) });
      return [...workspaceIds];
    }
    for (const failure of failures) {
      log.warn("Failed to prune plugin MCP overrides for workspace", {
        workspaceId: failure.workspaceId,
        error: getErrorMessage(failure.error),
      });
    }
    return failures.map((failure) => failure.workspaceId);
  }

  /**
   * Pending override prunes ("tombstones") persisted in the registry
   * envelope under `pendingOverridePrunes`: uninstalls whose per-workspace
   * override cleanup failed (checkout temporarily unavailable, unwritable
   * override file). They are retried on section open (list) and gate a
   * reinstall of the same instance ID, so a stale `enabledServers` key can
   * never silently re-enable a reinstalled plugin's server.
   *
   * Rewrites operate on the RAW item list, mirroring the registry-entry
   * rules: items this build cannot parse (a newer release's tombstone
   * variant) pass through untouched, and recognized items keep their unknown
   * fields when their `workspaceIds` shrink.
   */
  private isRecognizedPrune(
    item: unknown
  ): item is { prefix: string; workspaceIds: string[] } & Record<string, unknown> {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const prefix = (item as { prefix?: unknown }).prefix;
    const workspaceIds = (item as { workspaceIds?: unknown }).workspaceIds;
    return (
      typeof prefix === "string" &&
      // Only canonical `plugin:<instanceId>:` prefixes are executable: a
      // corrupted prefix (e.g. "g") must never reach prunePluginOverrideKeys,
      // where it would destructively strip arbitrary workspace override keys.
      // Invalid tombstones pass through verbatim like unknown variants.
      isCanonicalPluginServerKeyPrefix(prefix) &&
      Array.isArray(workspaceIds) &&
      workspaceIds.every((id): id is string => typeof id === "string")
    );
  }

  /** The raw `pendingOverridePrunes` array as stored (unknown variants included). */
  private rawPendingPrunes(envelope: Record<string, unknown>): unknown[] {
    const raw = envelope.pendingOverridePrunes;
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * True when `pendingOverridePrunes` exists with a shape this build does
   * not understand (a newer release's representation). It is opaque: every
   * rewrite must preserve it verbatim — deleting or replacing it would
   * destroy that build's cleanup metadata on downgrade.
   */
  private hasOpaquePendingPrunes(envelope: Record<string, unknown>): boolean {
    return (
      envelope.pendingOverridePrunes !== undefined && !Array.isArray(envelope.pendingOverridePrunes)
    );
  }

  /**
   * Recognized tombstones only (for matching/retrying). Corrupted persisted
   * state can carry several recognized tombstones for one prefix; they are
   * merged (workspace-ID union) so per-prefix rewrites, which replace every
   * matching item, can never silently drop a duplicate's cleanup record.
   */
  private parsePendingOverridePrunes(
    envelope: Record<string, unknown>
  ): Array<{ prefix: string; workspaceIds: string[] }> {
    const merged = new Map<string, string[]>();
    for (const item of this.rawPendingPrunes(envelope)) {
      if (!this.isRecognizedPrune(item)) {
        continue;
      }
      const existing = merged.get(item.prefix);
      if (existing) {
        for (const workspaceId of item.workspaceIds) {
          if (!existing.includes(workspaceId)) {
            existing.push(workspaceId);
          }
        }
      } else {
        merged.set(item.prefix, [...item.workspaceIds]);
      }
    }
    return [...merged.entries()].map(([prefix, workspaceIds]) => ({ prefix, workspaceIds }));
  }

  /**
   * Set this build's tombstone for `prefix` within the raw item list:
   * removes every recognized item for that prefix (merging their unknown
   * fields into the replacement) and appends the new one when
   * `workspaceIds` is non-empty. Unrecognized items are preserved verbatim.
   * `keepEmpty` appends an empty-list SENTINEL tombstone instead of removing
   * the entry: its presence still drives retry-side live re-enumeration,
   * covering uninstalls where the workspaces needing pruning were never
   * enumerable (see the uninstall post-commit re-enumeration catch).
   */
  private updateRawPendingPrunes(
    rawPending: unknown[],
    prefix: string,
    workspaceIds: string[],
    options?: { keepEmpty?: boolean }
  ): unknown[] {
    const matches: Array<Record<string, unknown>> = [];
    const next: unknown[] = [];
    for (const item of rawPending) {
      if (this.isRecognizedPrune(item) && item.prefix === prefix) {
        matches.push(item);
      } else {
        next.push(item);
      }
    }
    if (workspaceIds.length > 0 || options?.keepEmpty === true) {
      const replacement: Record<string, unknown> = {};
      for (const match of matches) {
        Object.assign(replacement, match);
      }
      replacement.prefix = prefix;
      replacement.workspaceIds = workspaceIds;
      next.push(replacement);
    }
    return next;
  }

  /** Persist the raw tombstone list into the envelope (removing the key when empty). */
  private async writePendingOverridePrunes(
    envelope: Record<string, unknown>,
    rawEntries: unknown[],
    rawPending: unknown[]
  ): Promise<void> {
    const nextEnvelope = { ...envelope };
    if (this.hasOpaquePendingPrunes(envelope)) {
      // A newer build's opaque shape rides through verbatim (kept by the
      // spread above). Nothing can need recording here: recognized
      // tombstones only ever come from an array shape, and uninstall
      // refuses up-front when it would have to record one.
      assert(
        rawPending.length === 0,
        "writePendingOverridePrunes: cannot merge tombstones into an opaque pendingOverridePrunes shape"
      );
    } else if (rawPending.length > 0) {
      nextEnvelope.pendingOverridePrunes = rawPending;
    } else {
      delete nextEnvelope.pendingOverridePrunes;
    }
    await this.writeRegistry(nextEnvelope, rawEntries);
  }

  /**
   * Retry one tombstone's pruning. The tombstone's PRESENCE — not its exact
   * workspace-ID list — is the durable retry record: workspaces registered
   * between an uninstall's pre-commit enumeration and its post-commit
   * re-enumeration may exist only in memory when the union write fails, and
   * a crash mid-prune loses them entirely. Every retry therefore
   * re-enumerates the CURRENT local/worktree workspaces and prunes that
   * full set, so a tombstone can only clear after a complete live sweep
   * succeeded. Recorded workspaces that no longer exist drop out implicitly
   * — a deleted workspace's overrides can never reactivate anything, so
   * keeping its ID would block reinstall forever. Returns the IDs that
   * still need pruning; when enumeration itself fails (`enumerated: false`),
   * the recorded list is returned unshrunk even if its prunes succeeded,
   * because unenumerated delta workspaces cannot be ruled out — callers must
   * then keep the tombstone even when `failed` is empty (an empty SENTINEL
   * tombstone records exactly this "delta workspaces unknown" state, and a
   * failed re-enumeration cannot rule them out either).
   */
  private async retryPrune(prune: {
    prefix: string;
    workspaceIds: string[];
  }): Promise<{ enumerated: boolean; failed: string[] }> {
    let liveWorkspaceIds: string[];
    try {
      liveWorkspaceIds = await this.listWorkspaceIdsForOverridePruning();
    } catch (error) {
      log.warn("Failed to enumerate workspaces for pending override prune retry", {
        error: getErrorMessage(error),
      });
      await this.pruneWorkspaceOverrides(prune.prefix, prune.workspaceIds);
      return { enumerated: false, failed: prune.workspaceIds };
    }
    return {
      enumerated: true,
      failed: await this.pruneWorkspaceOverrides(prune.prefix, liveWorkspaceIds),
    };
  }

  /**
   * Reinstall gate: a plugin name maps to the same instance ID, so a pending
   * prune for its prefix means stale workspace overrides could re-enable the
   * reinstalled plugin's servers without consent. Retry the prune now; only
   * a fully successful cleanup unblocks the install. Runs under the caller's
   * exclusive mutation lock (install's runExclusive).
   */
  private async assertNoPendingOverridePrune(name: string): Promise<void> {
    const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(name), "");
    const { envelope, rawEntries } = await this.readRegistryDocument("strict");
    // An opaque newer-build shape is unreadable here, so it may contain a
    // pending cleanup for this very instance ID — reinstalling would reuse
    // that ID and stale workspace overrides could silently re-enable its
    // servers. Over-blocking until the newer build resolves it is safe.
    if (this.hasOpaquePendingPrunes(envelope)) {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) contains pending cleanup state written by a newer version of Mux. Install with that version, or let it finish its cleanup first.`
      );
    }
    // Same reasoning per ITEM: an unrecognized array entry (a newer build's
    // per-entry variant, or corrupted data) may reference this very instance
    // ID — this build cannot rule that out, so it blocks installs too.
    // (Uninstalls stay possible: appending this build's tombstone preserves
    // unrecognized entries verbatim.)
    if (this.rawPendingPrunes(envelope).some((item) => !this.isRecognizedPrune(item))) {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) contains pending cleanup records this version cannot read (written by a newer version of Mux, or corrupted). Install with that version, or repair the file's pendingOverridePrunes entries first.`
      );
    }
    const pending = this.parsePendingOverridePrunes(envelope);
    const match = pending.find((prune) => prune.prefix === serverKeyPrefix);
    if (!match) {
      return;
    }

    const { enumerated, failed } = await this.retryPrune(match);
    if (!enumerated) {
      // Delta workspaces cannot be ruled out without a live enumeration:
      // keep the tombstone verbatim (even an empty sentinel) and stay
      // blocked — clearing it here would let the reinstall proceed over
      // workspaces the sweep never saw.
      throw new Error(
        `A previous uninstall of '${name}' could not verify its workspace MCP override cleanup yet (workspace enumeration failed). Retry in a moment.`
      );
    }
    const remaining = this.updateRawPendingPrunes(
      this.rawPendingPrunes(envelope),
      serverKeyPrefix,
      failed
    );
    await this.writePendingOverridePrunes(envelope, rawEntries, remaining);
    if (failed.length > 0) {
      throw new Error(
        `A previous uninstall of '${name}' could not clean up its workspace MCP overrides yet (${describeFailedWorkspaces(failed)}). The log has the error for each workspace. If the errors are time-outs (Xum was busy), retry in a moment.`
      );
    }
  }

  /**
   * Fresh-install hygiene for consent state left by a PREVIOUS occupant of
   * this plugin's path. The instance ID derives from the lexical target
   * path, so an UNMANAGED plugin the user enabled and then deleted by hand
   * (never uninstalled — no tombstone exists) leaves global enablement,
   * workspace overrides and cached instances that a same-name managed install
   * would silently inherit: its default-disabled servers would start
   * without fresh enablement. Sweep the prefix across live workspaces and
   * retire cached instances BEFORE anything is promoted; failures block the
   * install (over-blocking is safe, silent activation is not). Runs under
   * install's exclusive mutation lock.
   */
  private async assertNoResidualInstanceState(name: string): Promise<void> {
    const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(name), "");
    await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
    await this.deps.mcpConfigService?.pruneEnabledPluginServers(serverKeyPrefix);
    const { enumerated, failed } = await this.retryPrune({
      prefix: serverKeyPrefix,
      workspaceIds: [],
    });
    if (!enumerated) {
      throw new Error(
        `Could not verify that no workspace holds stale MCP overrides for '${name}' (workspace enumeration failed). Retry in a moment.`
      );
    }
    if (failed.length > 0) {
      throw new Error(
        `Xum could not check the MCP overrides of ${describeFailedWorkspaces(failed)} before installing '${name}'. The log has the error for each workspace. If the errors are time-outs (Xum was busy), retry in a moment.`
      );
    }
  }

  /**
   * Retry all pending override prunes; persists progress. Best-effort: runs
   * on section open (list), so transient failures self-heal the next time
   * the affected checkout is reachable. The read-modify-write runs under the
   * exclusive mutation queue — an install/update/uninstall committing while
   * the workspace I/O is in flight would otherwise be clobbered by this
   * write's stale registry snapshot.
   */
  private async retryPendingOverridePrunes(): Promise<void> {
    return this.runExclusive(async () => {
      const { envelope, rawEntries } = await this.readRegistryDocument("lenient");
      const pending = this.parsePendingOverridePrunes(envelope);
      if (pending.length === 0) {
        return;
      }

      let rawPending = this.rawPendingPrunes(envelope);
      let progressed = false;
      for (const prune of pending) {
        const { enumerated, failed } = await this.retryPrune(prune);
        if (!enumerated) {
          // Keep the record verbatim: without a live enumeration, delta
          // workspaces cannot be ruled out — in particular an empty SENTINEL
          // tombstone (recorded when an uninstall's re-enumeration failed
          // with zero commit-time workspaces) must not be cleared here.
          continue;
        }
        // Set comparison, not length: retryPrune re-enumerates live
        // workspaces, so `failed` can contain IDs the record never held
        // (delta workspaces) — those must be folded in durably too. A fully
        // successful sweep (`failed` empty) always counts as progress so an
        // empty sentinel tombstone clears instead of lingering forever.
        const recorded = new Set(prune.workspaceIds);
        const changed =
          failed.length === 0 ||
          failed.length !== recorded.size ||
          failed.some((id) => !recorded.has(id));
        if (changed) {
          progressed = true;
          rawPending = this.updateRawPendingPrunes(rawPending, prune.prefix, failed);
        }
      }

      if (progressed) {
        await this.writePendingOverridePrunes(envelope, rawEntries, rawPending).catch(
          (error: unknown) => {
            log.warn("Failed to persist pending override prune progress", {
              error: getErrorMessage(error),
            });
          }
        );
      }
    });
  }

  /**
   * Compare each managed entry's tracking ref against `lockedSha` via
   * `git ls-remote` (no fetch). Runs on Settings-section open and on the
   * explicit "Check for updates" action only — no background timers.
   */
  async checkUpdates(): Promise<AgentPluginUpdateCheck[]> {
    // STRICT: a lenient read would degrade an unreadable/corrupted registry
    // to an empty list and report a false "everything is up to date". The
    // thrown error surfaces nonfatally in the UI as the update-check error
    // state instead.
    const registry = await this.readRegistry("strict");
    // Bounded concurrency: one ls-remote process per entry at once would let
    // a large registry exhaust sockets/file descriptors on section open.
    return mapWithConcurrency(
      registry,
      UPDATE_CHECK_CONCURRENCY,
      async (entry): Promise<AgentPluginUpdateCheck> => {
        if (entry.source.refType === "commit") {
          return { name: entry.name, status: "pinned" };
        }
        try {
          // Commit-level comparison, also for subpath installs: a monorepo
          // commit outside the subpath still reads as "update available",
          // but applying it needs no consent (the staged folder is identical,
          // so the capability diff is empty).
          // Pass the stored kind: a remote ADDING a same-name branch must
          // not make a still-tracked tag read as "now a branch".
          const resolved = await this.resolveRemoteRef(
            entry.source.url,
            entry.source.ref,
            entry.source.refType
          );
          if (resolved.refType !== entry.source.refType) {
            // e.g. a tracked branch was deleted and a tag with the same name exists now.
            return {
              name: entry.name,
              status: "error",
              message: `Tracked ${entry.source.refType} '${entry.source.ref}' is now a ${resolved.refType} on the remote.`,
            };
          }
          if (resolved.sha === entry.lockedSha) {
            return { name: entry.name, status: "up-to-date" };
          }
          return {
            name: entry.name,
            // A moved tag is suspicious (tags are supposed to be immutable) — warn, don't just offer.
            status: entry.source.refType === "tag" ? "tag-moved" : "update-available",
            remoteSha: resolved.sha,
          };
        } catch (error) {
          return { name: entry.name, status: "error", message: getErrorMessage(error) };
        }
      }
    );
  }

  /**
   * Pre-flight shared by previewUpdate and update: registry lookup, the
   * refusals that make an update impossible, and the remote ref resolution.
   * Must run under runExclusive (reads the registry document for a later
   * write).
   */
  private async resolveUpdateTarget(name: string): Promise<{
    envelope: Record<string, unknown>;
    rawRegistry: unknown[];
    entry: AgentPluginInstallEntry;
    resolved: ResolvedRemoteRef;
    updateJournalPath: string;
  }> {
    const { envelope, rawEntries: rawRegistry } = await this.readRegistryDocument("strict");
    const registry = this.parseRegistryEntries(rawRegistry, "strict");
    const entry = registry.find((e) => e.name === name);
    if (!entry) {
      throw new Error(`'${name}' is not a managed plugin install.`);
    }
    if (entry.source.refType === "commit") {
      throw new Error(
        `'${entry.name}' is pinned to commit ${entry.lockedSha.slice(0, 12)}; uninstall and reinstall to change it.`
      );
    }
    // A retained journal means a previous swap's recovery is unfinished
    // (e.g. the target was occupied by an unidentifiable tree). Refuse
    // BEFORE cloning and comparing capabilities: a new journal would
    // clobber the trashDir reference protecting the recoverable original,
    // and the capability comparison would run against the wrong tree.
    const updateJournalPath = this.journalPath(UPDATE_JOURNAL_PREFIX, entry.name);
    if (await pathExists(updateJournalPath)) {
      throw new Error(
        `A previous update of '${entry.name}' has unfinished recovery. Open Settings → Plugins to let recovery complete, then try again.`
      );
    }
    // Same for an unresolved UNINSTALL journal (the registry still owns the
    // plugin while its tree sits in staging): a skills-only plugin has an
    // empty capability surface, so the missing target would NOT stop this
    // update — it would promote a replacement, after which uninstall
    // recovery sees the occupied target, keeps its journal forever, and the
    // whole managed container stays suppressed.
    if (await pathExists(this.journalPath(UNINSTALL_JOURNAL_PREFIX, entry.name))) {
      throw new Error(
        `A previous uninstall of '${entry.name}' has unfinished cleanup. Open Settings → Plugins to let recovery complete, then try again.`
      );
    }

    const resolved = await this.resolveRemoteRef(
      entry.source.url,
      entry.source.ref,
      entry.source.refType
    );
    if (resolved.refType !== entry.source.refType) {
      // The ref name now resolves to a different kind on the remote (e.g. a
      // tracked branch was deleted and a tag of the same name exists). The
      // update check flags this as an error; a stale Update click must not
      // silently install content from a different ref kind while the
      // registry keeps claiming the old one.
      throw new Error(
        `Tracked ${entry.source.refType} '${entry.source.ref}' is now a ${resolved.refType} on the remote. Uninstall and reinstall to track it.`
      );
    }
    return { envelope, rawRegistry, entry, resolved, updateJournalPath };
  }

  /** Stage `sha`, validate it, and refuse an upstream rename (names are identity). */
  private async stageUpdate(
    entry: AgentPluginInstallEntry,
    sha: string
  ): Promise<{ stagedDir: string; plugin: AgentPluginInfo; warnings: string[] }> {
    // A subpath install tracks the same folder at the new commit; a folder
    // that disappeared upstream fails here, before any swap.
    // A plugin.json that Xum generated is regenerated from the new commit, unless the
    // repository now has its own manifest. The update review covers every component as usual. A
    // marketplace entry is read again from the marketplace file at the new commit: the staged
    // folder holds only the entry.
    const generatedFrom = await readInstalledGeneratedFrom(this.targetPathFor(entry.name));
    const { stagedDir, marketplace } = await this.cloneWithEntry(
      entry.source,
      sha,
      generatedFrom?.kind === "claude-marketplace" ? generatedFrom.entry : undefined
    );
    try {
      const { plugin, warnings } = await this.validateStagedClone(
        stagedDir,
        entry.source,
        { mode: "update", generatedFrom },
        marketplace
      );
      if (plugin.name !== entry.name) {
        // Container-entry names are identity (instanceId, PLUGIN_DATA,
        // workspace overrides hash the path) — never rename on update.
        throw new Error(
          `The plugin renamed itself upstream ('${entry.name}' → '${plugin.name}'). Uninstall and reinstall to adopt the new name.`
        );
      }
      return { stagedDir, plugin, warnings };
    } catch (error) {
      await this.removeDir(stagedDir);
      throw error;
    }
  }

  /**
   * Stateless update review: stage the pending commit and report every
   * capability change relative to the installed tree (see
   * collectCapabilityChanges). Writes nothing; the UI shows the result and,
   * on confirmation, calls update() with a consent naming these exact SHAs.
   */
  /**
   * The imported components of the installed tree whose current fingerprint the user has not
   * reviewed (#6498), in the update review shape so Settings reuses the update review panel.
   */
  async previewComponentReview(args: { name: string }): Promise<AgentPluginUpdateReview> {
    const entry = (await this.readRegistry("strict")).find((entry) => entry.name === args.name);
    if (entry === undefined) throw new Error(`No managed plugin named '${args.name}'.`);
    const { changes, warnings } = await this.unreviewedComponents(entry);
    return {
      name: entry.name,
      fromSha: entry.lockedSha,
      toSha: entry.lockedSha,
      changes,
      warnings,
    };
  }

  /**
   * Record consent for the reviewed components that still match the installed tree. A component
   * that changed after the review keeps needing review, so consent never covers unseen content.
   */
  async confirmComponentReview(args: {
    name: string;
    expectedLockedSha: string;
    reviewed: AgentPluginComponentRef[];
  }): Promise<{ entry: AgentPluginInstallEntry; cleanupWarning?: string }> {
    const data = await this.runExclusive(async () => {
      const { envelope, rawEntries } = await this.readRegistryDocument("strict");
      const entry = this.parseRegistryEntries(rawEntries, "strict").find(
        (entry) => entry.name === args.name
      );
      if (entry === undefined) throw new Error(`No readable managed plugin named '${args.name}'.`);
      if (entry.lockedSha !== args.expectedLockedSha)
        throw new Error("Plugin changed since the review. Review it again.");
      const { changes } = await this.unreviewedComponents(entry);
      const componentConsent = consentAfterReview(entry, changes, { reviewed: args.reviewed });
      await this.writeRegistry(
        envelope,
        rawEntries.map((raw) =>
          this.rawEntryName(raw) === entry.name
            ? {
                ...(raw as Record<string, unknown>),
                componentConsent: mergeRawConsent(
                  (raw as Record<string, unknown>).componentConsent,
                  componentConsent
                ),
              }
            : raw
        )
      );
      const reviewed = { ...entry, componentConsent };
      await this.sweepApprovedCopies(reviewed);
      return reviewed;
    });
    // Newly consented servers can start: reconcile after the lock, like setComponents. The
    // consent is committed, so a reconcile failure is a warning, not a failed review.
    try {
      await this.deps.mcpServerManager?.reconcilePluginComponents();
      return { entry: data };
    } catch (error) {
      const cleanupWarning = `Review saved, but MCP servers need a restart to apply it: ${getErrorMessage(error)}`;
      log.warn(cleanupWarning, { name: args.name });
      return { entry: data, cleanupWarning };
    }
  }

  /** Review rows for imported components without a matching consent record. */
  private async unreviewedComponents(
    entry: AgentPluginInstallEntry
  ): Promise<{ changes: AgentPluginCapabilityChange[]; warnings: string[] }> {
    const targetPath = this.targetPathFor(entry.name);
    const { plugin } = await discoverAgentPluginAt({ pluginDir: targetPath, scope: "global" });
    if (plugin === null || plugin.name !== entry.name)
      throw new Error(`Installed plugin '${entry.name}' is missing or invalid.`);
    const warnings: string[] = [];
    const surface = await this.capabilitySurface(
      plugin,
      this.instanceIdFor(entry.name),
      targetPath,
      warnings
    );
    // Skills and scripts whose approved copy serves until this review (approvedCopies.ts).
    const served = verifiedApprovedCopies(
      await readApprovedCopies(this.approvedCopiesSource(entry)),
      entry.componentConsent,
      plugin.rootPath,
      surface.skills
    );
    // An agent a second file disabled after install has no fingerprint, so only this row shows it.
    const changes = [
      ...unreviewedRows(entry, surface, served),
      ...ambiguousAgentChanges(surface.ambiguousAgents, undefined),
    ];
    assertReviewFits(changes);
    return { changes, warnings };
  }

  /** Where this install keeps its approved copies (approvedCopies.ts). */
  private approvedCopiesSource(
    entry: Pick<AgentPluginInstallEntry, "name" | "installedAt">
  ): ApprovedCopiesSource {
    return {
      xumHome: this.config.rootDir,
      instancePath: this.targetPathFor(entry.name),
      installedAt: entry.installedAt,
    };
  }

  /**
   * Save the approved copies of this install's skills and workflow scripts from its live tree
   * (approvedCopies.ts), so a later change to them falls back to what the user approved. Runs in
   * the mutation lock after each approval. Best effort: a failure is logged and never fails the
   * committed mutation (the components then block until reviewed, as without copies).
   */
  private async sweepApprovedCopies(entry: AgentPluginInstallEntry): Promise<void> {
    try {
      await updateApprovedCopies(await this.approvedCopiesSweep(entry));
    } catch (error) {
      log.warn("Failed to save the approved copies of a plugin", {
        name: entry.name,
        error: getErrorMessage(error),
      });
    }
  }

  private async approvedCopiesSweep(entry: AgentPluginInstallEntry): Promise<ApprovedCopiesSweep> {
    return {
      source: this.approvedCopiesSource(entry),
      consent: entry.componentConsent,
      selection: entry.importedComponents,
      live: await this.liveApprovedCopies(entry.name),
    };
  }

  /** The installed tree's skills and workflow scripts; none when the tree is gone or invalid. */
  private async liveApprovedCopies(name: string): Promise<ApprovedCopies> {
    const { plugin } = await discoverAgentPluginAt({
      pluginDir: this.targetPathFor(name),
      scope: "global",
    });
    if (plugin?.name !== name) return noApprovedCopies();
    const warnings: string[] = [];
    const skills = await this.collectSkillsFromRoots(plugin, warnings);
    const workflows = await this.collectWorkflowScripts(plugin, warnings);
    return {
      skills: Object.fromEntries(
        skills.map((skill) => [
          skill.name,
          { fingerprint: skill.consentFingerprint, content: skill.approvedCopy.content },
        ])
      ),
      workflows: Object.fromEntries(
        workflows.map((w) => [w.file, { fingerprint: w.consentFingerprint, source: w.source }])
      ),
    };
  }

  /**
   * One sweep of every install after the first clean crash recovery, so installs approved by an
   * older build get their copies too. Never rejects: startup must not fail on it.
   */
  private async sweepApprovedCopiesAtStartup(): Promise<void> {
    try {
      // In this process's mutation queue, so the check never reads a tree in the middle of one of
      // its mutations (which would look outdated and take the lock after it). Most starts have
      // nothing to save: the cross-process lock is taken only when a sweep would write, and the
      // sweep then runs again under it (another process may have changed the trees meanwhile).
      await this.runQueued(async () => {
        const outdated = new Set<string>();
        for (const entry of await this.readRegistry("lenient")) {
          if (await approvedCopiesOutdated(await this.approvedCopiesSweep(entry))) {
            outdated.add(entry.name);
          }
        }
        if (outdated.size === 0) return;
        await this.withMutationLock(async () => {
          for (const entry of await this.readRegistry("lenient")) {
            if (outdated.has(entry.name)) await this.sweepApprovedCopies(entry);
          }
        });
      });
    } catch (error) {
      log.warn("Failed to save the approved copies of installed plugins at startup", {
        error: getErrorMessage(error),
      });
    }
  }

  async previewUpdate(args: { name: string }): Promise<AgentPluginUpdateReview> {
    return this.runExclusive(async () => {
      const { entry, resolved } = await this.resolveUpdateTarget(args.name);
      if (resolved.sha === entry.lockedSha) {
        return {
          name: entry.name,
          fromSha: entry.lockedSha,
          toSha: entry.lockedSha,
          changes: [],
          warnings: [],
        };
      }
      const { stagedDir, plugin, warnings } = await this.stageUpdate(entry, resolved.sha);
      try {
        const changes = await this.collectCapabilityChanges(
          entry.name,
          this.targetPathFor(entry.name),
          plugin,
          warnings
        );
        return {
          name: entry.name,
          fromSha: entry.lockedSha,
          toSha: resolved.sha,
          ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
          changes,
          warnings,
        };
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }

  /**
   * Apply an update: temp clone at the new SHA → re-validate → wholesale
   * directory swap (rename-old → promote-new → delete-old) → bump lockedSha →
   * recycle that plugin's MCP servers. Never an in-place `git pull`; local
   * edits to the managed dir are discarded.
   */
  async update(args: {
    name: string;
    consent?: AgentPluginUpdateConsent | undefined;
  }): Promise<AgentPluginInstallEntry> {
    if (args.consent !== undefined) {
      assert(
        isFullCommitSha(args.consent.toSha),
        "update: consent.toSha must be a full commit SHA"
      );
    }

    return this.runExclusive(async () => {
      const { envelope, rawRegistry, entry, resolved, updateJournalPath } =
        await this.resolveUpdateTarget(args.name);
      if (args.consent !== undefined && args.consent.fromSha !== entry.lockedSha) {
        // The review compared the staged tree against THIS install; if
        // another update landed in between, the shown diff is stale.
        throw new Error(
          `'${entry.name}' changed since you reviewed the update (installed ${entry.lockedSha.slice(0, 12)}, reviewed against ${args.consent.fromSha.slice(0, 12)}). Check for updates again.`
        );
      }
      // Consent installs exactly the reviewed commit (mirroring install's
      // expectedSha): if the branch moved on since the review, the newer
      // commit was never shown to the user and surfaces on the next check.
      const targetSha = args.consent?.toSha ?? resolved.sha;
      if (targetSha === entry.lockedSha) {
        return entry; // Already current.
      }

      const { stagedDir, plugin } = await this.stageUpdate(entry, targetSha);
      // Sign-outs this update recorded, and whether its tree went live (see the catch below).
      let recordedSignOuts: string[] = [];
      let promoted = false;
      try {
        const targetPath = this.targetPathFor(entry.name);
        // Security: an update must not silently expand what the plugin can
        // do — a compromised upstream could add hooks.js plus a bash grant
        // and auto-load it on the next request. Compare the staged tree's
        // capability surface against the installed tree; changes need a
        // consent from previewUpdate naming this exact (from, to) pair,
        // which the user gave after seeing every change.
        const signInResets: string[] = [];
        const changes = await this.collectCapabilityChanges(
          entry.name,
          targetPath,
          plugin,
          [],
          signInResets
        );
        // Only changes the user saw at these fingerprints get consent records (#6498).
        const componentConsent = consentAfterReview(entry, changes, args.consent);
        if (changes.length > 0 && args.consent === undefined) {
          throw new Error(
            `The update to '${entry.name}' ${changes.map((change) => change.summary).join("; ")}. Updates cannot expand a plugin's capabilities without review — open Settings → Plugins and review the update to confirm it.`
          );
        }

        // Record the sign-outs before anything changes: a crash, or a store write that fails
        // after the swap, leaves them for the next start (#6122).
        const resets = [...new Set(signInResets)];
        recordedSignOuts = await this.recordPendingSignOuts(resets);
        // Before the swap: a change this update does not approve falls back to the approved
        // version of the old tree.
        await this.sweepApprovedCopies(entry);

        await this.removeDir(path.join(stagedDir, ".git"));

        const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(entry.name), "");
        const trashDir = path.join(this.stagingRoot, `trash-${Date.now()}-${entry.name}`);
        const hadOldTree = await pathExists(targetPath);

        // Stop this plugin's running MCP servers BEFORE the old tree moves:
        // a live server can lose its files mid-swap on POSIX, and open
        // handles can make the rename itself fail on Windows.
        await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);

        // The nonce marker rides inside the staged tree through the promote
        // rename, letting crash recovery tell OUR promoted tree from an
        // unmanaged one a user placed at the then-empty target.
        const updateNonce = randomBytes(16).toString("hex");
        await fsPromises.writeFile(path.join(stagedDir, PROMOTION_MARKER_FILE), updateNonce);
        if (hadOldTree) {
          // Journal the swap BEFORE the live tree moves: a crash between the
          // rename below and the promote would leave the registry recording
          // an install whose path is missing — and retrying Update cannot
          // self-heal because assertNoCapabilityIncrease treats the missing
          // tree as an empty surface and rejects the staged capabilities as
          // additions. reconcileJournals restores the old tree on recovery.
          // newSha lets crash recovery reconcile registry provenance: a crash
          // between the promote below and the registry write leaves the
          // (consented) replacement live while the registry still claims the
          // old commit — recovery must be able to commit the recorded SHA.
          // componentConsent: the consent this update records, so recovery can record it too
          // instead of asking again for what the user just reviewed (#6589). Recovery reads it
          // tolerantly: a journal without it (an older build) keeps the old consent.
          await this.writeJournalFile(updateJournalPath, {
            name: entry.name,
            trashDir,
            nonce: updateNonce,
            stagedAt: Date.now(),
            newSha: targetSha,
            componentConsent,
          });
          try {
            await this.renameIntoStaging(targetPath, trashDir);
          } catch (error) {
            // Nothing moved: no recovery needed.
            await this.consumeJournalFile(updateJournalPath).catch(() => undefined);
            throw error;
          }
        }
        try {
          await fsPromises.mkdir(this.containerDir, { recursive: true });
          await fsPromises.rename(stagedDir, targetPath);
        } catch (error) {
          if (hadOldTree) {
            // Roll the old tree back so a failed swap never leaves the plugin missing.
            try {
              await fsPromises.rename(trashDir, targetPath);
              this.activeStagingPaths.delete(trashDir);
              await this.consumeJournalFile(updateJournalPath).catch(() => undefined);
            } catch (rollbackError) {
              // Keep the journal: reconcileJournals restores the tree on the
              // next startup/section open.
              log.error("Failed to roll back plugin dir after failed update swap", {
                targetPath,
                rollbackError,
              });
            }
          }
          throw error;
        }
        promoted = true;
        // The new tree is live. Consume the JOURNAL before the marker, and
        // ENFORCE that ordering: a markerless target with the journal still
        // present is exactly the state recovery must treat as an unidentified
        // user replacement — deadlocking future updates. If the journal
        // cannot be deleted, keep the marker (it is the tree's identity for
        // the matching-nonce recovery branch, which retries this cleanup) and
        // leave the staged old tree pinned by the journal. Journal-first, a
        // crash merely leaves a stray marker in the live tree (harmless; the
        // next update swap discards it).
        let journalConsumed = true;
        if (hadOldTree) {
          try {
            await this.consumeJournalFile(updateJournalPath);
          } catch (error) {
            journalConsumed = false;
            log.warn(
              "Failed to delete the update journal; keeping the tree marker so recovery can finish",
              { name: entry.name, error: getErrorMessage(error) }
            );
          }
        }
        if (journalConsumed) {
          await fsPromises
            .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
            .catch(() => undefined);
          if (hadOldTree) {
            // Best-effort: the trash dir sits under the staging root, where
            // stale-dir reclamation cleans up leftovers.
            await this.removeDir(trashDir).catch((error: unknown) => {
              // The update transaction no longer owns this dir (journal
              // consumed above) — release it from the active set or every
              // later purgeStaleStaging in this process skips the very dir
              // this catch defers to reclamation, accumulating a full
              // checkout per failed deletion until restart.
              this.activeStagingPaths.delete(trashDir);
              log.warn(
                "Failed to delete replaced plugin tree; leaving it for staging reclamation",
                { trashDir, error: getErrorMessage(error) }
              );
            });
          }
        }
        if (!hadOldTree) {
          // No journal was written (no old tree to restore), so nothing
          // above bumped the mutation epoch. Bump it explicitly: sibling
          // processes' MCPServerManagers key their cross-process plugin
          // invalidation off this token, and a server launched before the
          // old tree went missing may still be running there. This bump is
          // the ONLY cross-process publication on this path (no journal, no
          // consume), so a failure must FAIL the update rather than commit
          // success — a sibling would otherwise observe neither a journal
          // nor a token change and keep serving the removed tree's server
          // indefinitely. The registry still holds the old lockedSha, the
          // update badge stays visible, and the retry runs the journaled
          // swap path (the promoted tree now exists), whose journal
          // lifecycle republishes the epoch or retains a durable record.
          try {
            await bumpContainerMutationEpoch(this.stagingRoot);
          } catch (error) {
            throw new Error(
              `The new plugin tree is in place, but publishing the change to other Mux processes failed (${getErrorMessage(error)}). Retry the update.`
            );
          }
        }

        const updated: AgentPluginInstallEntry = {
          ...entry,
          lockedSha: targetSha,
          updatedAt: new Date().toISOString(),
          componentConsent,
          manifest: {
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
        // The new tree is already promoted; a failed write surfaces as an
        // error and the stale lockedSha keeps the update badge visible, so
        // retrying the update self-heals the mismatch.
        //
        // Patch ONLY the fields this update owns (lockedSha, updatedAt, and
        // the manifest's version/description) into the RAW entry: spreading
        // the Zod-parsed entry would replace `source`/`manifest` wholesale
        // with their stripped counterparts, deleting nested metadata a newer
        // build may have stored there (breaking downgrade round-trips).
        try {
          await this.writeRegistry(
            envelope,
            rawRegistry.map((rawEntry) => {
              if (this.rawEntryName(rawEntry) !== entry.name) {
                return rawEntry;
              }
              const rawRecord = rawEntry as Record<string, unknown>;
              const rawManifest =
                typeof rawRecord.manifest === "object" &&
                rawRecord.manifest !== null &&
                !Array.isArray(rawRecord.manifest)
                  ? (rawRecord.manifest as Record<string, unknown>)
                  : {};
              // version/description are owned by the update (they mirror the
              // newly installed plugin.json), so stale values are dropped and
              // fresh ones written; unknown manifest keys pass through.
              const {
                version: _staleVersion,
                description: _staleDescription,
                ...preservedManifest
              } = rawManifest;
              return {
                ...rawRecord,
                lockedSha: updated.lockedSha,
                updatedAt: updated.updatedAt,
                manifest: { ...preservedManifest, ...updated.manifest },
                componentConsent: mergeRawConsent(rawRecord.componentConsent, componentConsent),
              };
            })
          );
        } finally {
          // Recycle post-promote even when the registry write fails: the tree
          // already swapped, so (1) content changed behind a stable path —
          // possibly an unchanged stdio command line — which the config
          // signature cannot see, and (2) a concurrent getToolsForWorkspace
          // that began after the pre-swap invalidation but discovered the
          // plugin before the rename may have published a server from the
          // replaced tree. Servers restart on next use; default-disabled
          // state and workspace overrides are untouched (identity is the
          // lexical path).
          // The new tree is in place: tokens issued to the old sign-in
          // identity (client, endpoints, issuer, resource, scopes) must not be
          // refreshed with the new client. Signed out, the server asks again.
          // Runs BEFORE the final stop, so a startup that raced the sign-out
          // is invalidated too, and a failing stop cannot skip it.
          await this.signOutAndSettle(entry.name, resets);
          await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
        }

        await this.sweepApprovedCopies(updated);
        log.info(
          `Updated agent plugin '${entry.name}' ${entry.lockedSha.slice(0, 12)} → ${targetSha.slice(0, 12)}`
        );
        return updated;
      } catch (error) {
        // Failed before the new tree went live: the old sign-in still applies, so the recorded
        // sign-outs must not run at the next start.
        if (!promoted) await this.forgetPendingSignOuts(recordedSignOuts);
        throw error;
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }
}
