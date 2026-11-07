import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  AgentPluginInstallEntrySchema,
  type AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import type { BackupContents } from "@/common/config/schemas/settingsBackup";
import type { AgentPluginInstallMethod } from "@/common/orpc/schemas/agentPlugins";
import {
  BackupPluginEntrySchema,
  MAX_BACKUP_PLUGIN_ENTRIES,
  type BackupPluginEntry,
  type BackupPluginManifest,
  type BackupPluginRemoval,
  type BackupPluginReport,
  type BackupPluginRow,
  type BackupPluginStatus,
  EMPTY_BACKUP_PLUGIN_REPORT,
} from "@/common/orpc/schemas/backup";
import { getErrorMessage } from "@/common/utils/errors";
import { readInstalledGeneratedFrom } from "@/node/services/agentPlugins/installMethods";
import type { GeneratedFrom } from "@/node/services/agentPlugins/manifest";
import {
  PLUGIN_REGISTRY_FILE_NAME,
  readPluginRegistryDocument,
} from "@/node/services/agentPlugins/registry";
import { log } from "@/node/services/log";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import {
  assertManagedTreeWithinLimits,
  BACKUP_MANIFEST_FILE,
  isFilesystemError,
  MAX_BACKUP_FILE_BYTES,
  resolveContainedPath,
  sha256,
  type BackupFile,
} from "./payload";

/**
 * Settings backup of the managed Agent Plugin list. The list is data about where each plugin came
 * from and which commit was pinned. It is never the plugin itself, and it never carries consent.
 *
 * A restore must therefore install nothing. An install records consent for the install preview
 * the user read (componentConsent.ts), and a plugin's `hooks.js` loads on its own once installed.
 * A list that installed by itself would let whoever can push to the backup branch run code here.
 * So a restore only reports how each listed plugin compares with this machine, and the user
 * reinstalls through the normal preview and consent review.
 *
 * Like the project bundle and the artifact shelf, the list is a sidecar folder with its own
 * manifest: the core manifest rejects unknown paths, so listing it there would make older builds
 * refuse the whole backup, while an older build ignores an unknown sidecar folder.
 */
export const PLUGIN_BACKUP_DIR = "agent-plugins";
export const PLUGIN_BACKUP_MANIFEST_PATH = `${PLUGIN_BACKUP_DIR}/${BACKUP_MANIFEST_FILE}`;

/** The managed registry rows this build can read, first row per name (a later duplicate is corrupt). */
async function readManagedInstalls(rootDir: string): Promise<Map<string, AgentPluginInstallEntry>> {
  const { rawEntries } = await readPluginRegistryDocument(
    path.join(rootDir, PLUGIN_REGISTRY_FILE_NAME),
    "lenient"
  );
  const installs = new Map<string, AgentPluginInstallEntry>();
  for (const raw of rawEntries) {
    const parsed = AgentPluginInstallEntrySchema.safeParse(raw);
    if (parsed.success && !installs.has(parsed.data.name))
      installs.set(parsed.data.name, parsed.data);
  }
  return installs;
}

/**
 * The preview selector that rebuilds a plugin Xum generated a plugin.json for. A plugin with its
 * own manifest has none: the preview takes the first method that fits.
 */
function methodOf(generated: GeneratedFrom | undefined): AgentPluginInstallMethod | undefined {
  if (generated === undefined) return undefined;
  return generated.kind === "skills"
    ? { kind: "skills" }
    : { kind: "claude-marketplace", entry: generated.entry };
}

async function entryOf(
  rootDir: string,
  install: AgentPluginInstallEntry
): Promise<BackupPluginEntry | null> {
  const method = methodOf(
    await readInstalledGeneratedFrom(path.join(rootDir, "plugins", install.name))
  );
  // Only the fields the schema names: consent, install times and auto-update stay local.
  const parsed = BackupPluginEntrySchema.safeParse({
    name: install.name,
    source: install.source,
    lockedSha: install.lockedSha,
    method,
    importedComponents: install.importedComponents,
  });
  if (!parsed.success) {
    // A row the restore side would refuse must not make every restore of this backup fail.
    log.warn("Leaving a plugin out of the settings backup", {
      plugin: install.name,
      error: getErrorMessage(parsed.error),
    });
    return null;
  }
  return parsed.data;
}

/** Every managed install as a portable entry, sorted by name; null when there is none. */
export async function collectPluginBackup(rootDir: string): Promise<BackupPluginManifest | null> {
  const installs = [...(await readManagedInstalls(rootDir)).values()];
  const entries = await Promise.all(installs.map((install) => entryOf(rootDir, install)));
  const plugins = entries
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_BACKUP_PLUGIN_ENTRIES);
  return plugins.length === 0 ? null : { schemaVersion: 1, plugins };
}

export function serializePluginBackupManifest(manifest: BackupPluginManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/**
 * The names a push removes from the backup's list, and whether it removes the whole list. Undefined
 * when the backup has no list or every listed plugin stays. A list the backup has but this build
 * cannot read names nothing, so only a push that writes no list (`written` null) reports it.
 */
function pluginRemovalOf(
  prior: PluginListRead | null,
  written: BackupPluginManifest | null
): BackupPluginRemoval | undefined {
  if (prior === null) return undefined;
  const kept = new Set(written?.plugins.map((plugin) => plugin.name));
  const names = prior.plugins.map((plugin) => plugin.name).filter((name) => !kept.has(name));
  const wholeList = written === null;
  if (!wholeList && names.length === 0) return undefined;
  names.sort();
  // JSON, not a delimiter: a name is repository-controlled text.
  const approval = sha256(Buffer.from(JSON.stringify({ names, wholeList }), "utf-8"));
  return { names, wholeList, approval };
}

/**
 * The list the checked-out backup carries, or null when it has none. A push rewrites the managed
 * path, so read it before the core write clears it.
 */
export async function readPriorPluginList(sourceDir: string): Promise<PluginListRead | null> {
  return (await pluginBackupExists(sourceDir)) ? await readPluginBackup(sourceDir) : null;
}

/**
 * Writes the sidecar into the managed copy. Returns the files the push now publishes, for the
 * secret scan, and what it removes from the list the checked-out backup carried (`prior`). Off,
 * or with nothing installed, it writes nothing: the core write already cleared the managed path,
 * so a list pushed earlier disappears from the next tree.
 */
export async function exportPluginBackup(options: {
  rootDir: string;
  destination: string;
  contents: BackupContents;
  prior: PluginListRead | null;
}): Promise<{ files: BackupFile[]; pluginRemoval?: BackupPluginRemoval }> {
  const manifest = options.contents.includePlugins
    ? await collectPluginBackup(options.rootDir)
    : null;
  const pluginRemoval = pluginRemovalOf(options.prior, manifest);
  if (manifest === null) return { files: [], pluginRemoval };
  const content = serializePluginBackupManifest(manifest);
  const sidecar = path.join(options.destination, PLUGIN_BACKUP_DIR);
  await fs.mkdir(sidecar, { recursive: true, mode: 0o700 });
  await writeFileAtomic(path.join(sidecar, BACKUP_MANIFEST_FILE), content, { mode: 0o600 });
  await assertManagedTreeWithinLimits(options.destination);
  return { files: [{ path: PLUGIN_BACKUP_MANIFEST_PATH, content }], pluginRemoval };
}

/** Anything at the sidecar path counts, so a malformed one is still reported while the flag is off. */
async function pluginBackupExists(sourceDir: string): Promise<boolean> {
  return (await fs.lstat(path.join(sourceDir, PLUGIN_BACKUP_DIR)).catch(() => null)) !== null;
}

async function readManifestText(sourceDir: string): Promise<string> {
  // The walk refuses a symlink at the sidecar folder or the manifest, which git can store.
  const manifestPath = await resolveContainedPath(sourceDir, PLUGIN_BACKUP_MANIFEST_PATH);
  const stat = await fs.lstat(manifestPath).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Backup plugin list is missing, not a file, or too large");
  }
  return await fs.readFile(manifestPath, "utf-8");
}

/** The version and the rows of the list file. Each row is read on its own (`readPluginRows`). */
const PluginListEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  plugins: z.array(z.unknown()),
});

/** The name of a row, for its warning, when it has a string one. */
const PluginRowNameSchema = z.object({ name: z.string() });

/** A corrupt list of hundreds of rows must not become hundreds of warning lines. */
const MAX_PLUGIN_LIST_WARNINGS = 10;

/** What this build could read of the checked-out list, and what it had to leave out. */
export interface PluginListRead {
  plugins: BackupPluginEntry[];
  warnings: string[];
}

function skippedList(reason: string): PluginListRead {
  return { plugins: [], warnings: [`The plugin list was not read: ${reason}.`] };
}

/** Row numbers keep every warning distinct, even for rows that share a name or have none. */
function rowLabel(row: unknown, index: number): string {
  const named = PluginRowNameSchema.safeParse(row);
  return named.success
    ? `row ${index + 1} ("${named.data.name.slice(0, 64)}")`
    : `row ${index + 1}`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 2)
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/**
 * Keeps the rows this build can read, first row per name (a later duplicate is corrupt). A row it
 * cannot read, such as a source kind a newer build wrote, is left out and reported: the list is
 * advice, so one bad row must not hide the others or block the restore.
 */
function readPluginRows(rows: readonly unknown[]): PluginListRead {
  const plugins: BackupPluginEntry[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  for (const [index, row] of rows.slice(0, MAX_BACKUP_PLUGIN_ENTRIES).entries()) {
    const parsed = BackupPluginEntrySchema.safeParse(row);
    if (!parsed.success) {
      problems.push(`Left out ${rowLabel(row, index)}: ${describeIssues(parsed.error)}`);
    } else if (names.has(parsed.data.name)) {
      problems.push(`Left out ${rowLabel(row, index)}: the list names that plugin twice`);
    } else {
      names.add(parsed.data.name);
      plugins.push(parsed.data);
    }
  }
  const warnings = problems.slice(0, MAX_PLUGIN_LIST_WARNINGS);
  if (problems.length > warnings.length) {
    warnings.push(`${problems.length - warnings.length} more plugins were left out`);
  }
  if (rows.length > MAX_BACKUP_PLUGIN_ENTRIES) {
    warnings.push(`Only the first ${MAX_BACKUP_PLUGIN_ENTRIES} plugins of the list were read`);
  }
  return { plugins, warnings };
}

function parsePluginList(text: string): PluginListRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return skippedList("it is not valid JSON");
  }
  const envelope = PluginListEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return skippedList("only a version 1 list with a plugins array can be read here");
  }
  return readPluginRows(envelope.data.plugins);
}

/**
 * The checked-out list as far as this build can read it. The list is advice, so a list it cannot
 * read (bad JSON, another version, a symlink, a missing or oversized file) or a row it cannot read
 * becomes a warning and never refuses the restore. A local disk failure still throws, so it is not
 * blamed on the repository. A symlink is reported without being followed.
 */
async function readPluginBackup(sourceDir: string): Promise<PluginListRead> {
  if (!(await pluginBackupExists(sourceDir))) return { plugins: [], warnings: [] };
  let text: string;
  try {
    text = await readManifestText(sourceDir);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    return skippedList(getErrorMessage(error));
  }
  return parsePluginList(text);
}

/** `installed`: that name at that commit. Another commit, or a folder the installer does not manage: `conflict`. */
async function statusOf(
  rootDir: string,
  plugin: BackupPluginEntry,
  local: AgentPluginInstallEntry | undefined
): Promise<BackupPluginStatus> {
  if (local !== undefined) return local.lockedSha === plugin.lockedSha ? "installed" : "conflict";
  const folder = await fs.lstat(path.join(rootDir, "plugins", plugin.name)).catch(() => null);
  return folder === null ? "missing" : "conflict";
}

async function planPluginRows(
  rootDir: string,
  listed: readonly BackupPluginEntry[]
): Promise<BackupPluginRow[]> {
  // No rows, nothing to compare: a backup without a list never reads this machine's registry.
  if (listed.length === 0) return [];
  const local = await readManagedInstalls(rootDir);
  return await Promise.all(
    listed.map(async (plugin) => ({
      ...plugin,
      status: await statusOf(rootDir, plugin, local.get(plugin.name)),
    }))
  );
}

/**
 * What a preview or restore reports of the backup's plugin list. Writes nothing: the rows are an
 * offer the user can take through the install review (see the note at the top of this file).
 * With the flag off the list is only checked for existence, so a malformed one never blocks a
 * settings-only restore, and its presence is reported. With it on, an unreadable list or row comes
 * back as a warning (`readPluginBackup`).
 */
export async function readPluginRestore(options: {
  rootDir: string;
  sourceDir: string;
  contents: BackupContents;
}): Promise<BackupPluginReport> {
  if (!options.contents.includePlugins) {
    return { ...EMPTY_BACKUP_PLUGIN_REPORT, skipped: await pluginBackupExists(options.sourceDir) };
  }
  const list = await readPluginBackup(options.sourceDir);
  return {
    rows: await planPluginRows(options.rootDir, list.plugins),
    skipped: false,
    warnings: list.warnings,
  };
}
