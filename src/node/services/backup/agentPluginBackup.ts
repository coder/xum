import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import type { AgentPluginInstallEntry } from "@/common/config/schemas/agentPluginInstalls";
import type { BackupContents } from "@/common/config/schemas/settingsBackup";
import {
  BackupPluginEntrySchema,
  MAX_BACKUP_PLUGIN_ENTRIES,
  type BackupPluginEntry,
  type BackupPluginManifest,
  type BackupPluginRemoval,
  type BackupPluginReport,
  type BackupPluginRow,
  type BackupPluginStatus,
} from "@/common/orpc/schemas/backup";
import { getErrorMessage } from "@/common/utils/errors";
import { pointsAtThisMachine } from "@/common/utils/agentPluginSource";
import { readInstalledGeneratedFrom } from "@/node/services/agentPlugins/installMethods";
import {
  acquirePluginMutationLock,
  MUTATION_LOCK_ACQUIRE_TIMEOUT_MS,
} from "@/node/services/agentPlugins/journals";
import type { GeneratedFrom } from "@/node/services/agentPlugins/manifest";
import {
  parseRegistryEntriesLenient,
  PLUGIN_REGISTRY_FILE_NAME,
  readPluginRegistryDocument,
} from "@/node/services/agentPlugins/registry";
import { log } from "@/node/services/log";
import { CrossProcessLockTimeoutError } from "@/node/utils/concurrency/lockErrors";
import { formatZodIssues } from "@/node/utils/markdownFrontmatter";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { BackupServiceError } from "./backupService";
import {
  assertManagedTreeWithinLimits,
  BACKUP_MANIFEST_FILE,
  isFilesystemError,
  lstatIfExists,
  MAX_BACKUP_FILE_BYTES,
  resolveContainedPath,
  serializeSidecarManifest,
  sha256,
  sidecarExists,
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

/** The managed registry rows this build can read, by name. */
async function readManagedInstalls(muxRoot: string): Promise<Map<string, AgentPluginInstallEntry>> {
  const { rawEntries } = await readPluginRegistryDocument(
    path.join(muxRoot, PLUGIN_REGISTRY_FILE_NAME),
    "lenient"
  );
  return new Map(parseRegistryEntriesLenient(rawEntries).map((entry) => [entry.name, entry]));
}

const AGENT_PLUGINS_OFF_HINT = 'Turning off "Agent plugins" backs up without the plugin list.';

/**
 * The registry rows a push lists. A restore only compares names, so it reads what it can. A push
 * writes the list, so a registry it cannot read whole (a row it cannot parse, or a name listed
 * twice) would drop plugins from the backup without a word: the push fails instead, and names the
 * file. A missing file is no plugins. The code is IO_ERROR, not INVALID_BACKUP: the file is on
 * this machine, not in the backup repository.
 */
async function readInstallsToList(muxRoot: string): Promise<AgentPluginInstallEntry[]> {
  const registryFile = path.join(muxRoot, PLUGIN_REGISTRY_FILE_NAME);
  let rawEntries: unknown[];
  try {
    ({ rawEntries } = await readPluginRegistryDocument(registryFile, "strict"));
  } catch (error) {
    throw new BackupServiceError("IO_ERROR", `${getErrorMessage(error)} ${AGENT_PLUGINS_OFF_HINT}`);
  }
  // The rows the lenient read drops: a row that fails the schema, and a second row of a name (the
  // first wins there). A repeated name is corrupt identity, so the list could not say which row the
  // user means.
  const installs = parseRegistryEntriesLenient(rawEntries);
  const unreadable = rawEntries.length - installs.length;
  if (unreadable > 0) {
    throw new BackupServiceError(
      "IO_ERROR",
      `The plugin registry (${registryFile}) has ${unreadable} of ${rawEntries.length} entries this version of Xum cannot read, for example plugins a newer Xum installed. Backing up would leave them out of the list. ${AGENT_PLUGINS_OFF_HINT}`
    );
  }
  return installs;
}

/** A registry row with the `generatedFrom` marker of its plugin folder, as one read saw them. */
interface InstallSnapshot {
  install: AgentPluginInstallEntry;
  generated: GeneratedFrom | undefined;
}

/** The way out each side of a backup has when it cannot read the plugins: the flag skips the read. */
const LOCK_WAIT_FAILURE = {
  backup: {
    reading: "the installed plugins for the backup",
    wayOut: 'Turning off "Agent plugins" backs up without the plugin list.',
  },
  restore: {
    reading: "the installed plugins to compare with the backup's list",
    wayOut: 'Turning off "Agent plugins" restores without the plugin list.',
  },
} as const;

/**
 * The plugin lock install, update and uninstall hold, taken for the reads only. A timeout is a
 * failed push, preview or restore, named like the other local reads: the holder is a process on
 * this machine, not the backup repository.
 */
async function acquireSnapshotLock(
  muxRoot: string,
  timeoutMs: number,
  side: keyof typeof LOCK_WAIT_FAILURE
) {
  try {
    return await acquirePluginMutationLock(muxRoot, { timeoutMs });
  } catch (error) {
    if (!(error instanceof CrossProcessLockTimeoutError)) throw error;
    const { reading, wayOut } = LOCK_WAIT_FAILURE[side];
    throw new BackupServiceError(
      "IO_ERROR",
      `Xum could not read ${reading}. ${error.message} ${wayOut}`
    );
  }
}

/**
 * The registry and the plugin folders' markers, read together under the lock that every plugin
 * mutation holds. A mutation moves a plugin's folder and rewrites the registry in separate steps,
 * so unlocked reads could pair a row from before an update with a marker from after it, or list a
 * plugin whose uninstall has begun. The lock is held for the reads and no longer, never across
 * git or network work. The installer clones under it, so the wait is bounded by the installer's own
 * timeout (`MUTATION_LOCK_ACQUIRE_TIMEOUT_MS`). Lock order: a push holds the backup locks (the
 * repository's and the local payload's) and then takes this one, and so do a preview and a restore
 * (`planPluginRows`). Nothing that holds this lock takes a backup lock, so the two cannot wait on
 * each other.
 */
async function readInstallSnapshot(
  muxRoot: string,
  lockTimeoutMs: number
): Promise<InstallSnapshot[]> {
  const release = await acquireSnapshotLock(muxRoot, lockTimeoutMs, "backup");
  try {
    const installs = await readInstallsToList(muxRoot);
    return await Promise.all(
      installs.map(async (install) => ({
        install,
        generated: await readInstalledGeneratedFrom(path.join(muxRoot, "plugins", install.name)),
      }))
    );
  } finally {
    await release();
  }
}

/**
 * The portable entry of one install, or null for a plugin the backup leaves out on purpose (logged
 * by name, and listed in the docs). An install the list cannot hold throws instead.
 */
function entryOf({ install, generated }: InstallSnapshot): BackupPluginEntry | null {
  // Another machine cannot use a path or a loopback host on this one, and the list would publish it
  // (the home folder names the user). The plugin is logged by name only, so its absence from the
  // backup is explained.
  if (pointsAtThisMachine(install.source.url)) {
    log.info("Leaving a plugin out of the settings backup: its source is on this machine", {
      plugin: install.name,
    });
    return null;
  }
  // The registry records the repository a marketplace entry resolved to, and the plugin.json keeps
  // only the entry's name. An entry that points at another repository cannot be rebuilt from this
  // row, and telling it from an entry in the marketplace's own repository needs a registry field.
  // The marker is read for this exclusion alone. A plugin's repository can author its own marker,
  // so it can only remove a plugin from the backup, never choose how a restore installs it.
  if (generated?.kind === "claude-marketplace") {
    log.info(
      "Leaving a plugin out of the settings backup: Xum generated it from a Claude Code marketplace entry",
      { plugin: install.name }
    );
    return null;
  }
  // Only the fields the schema names: consent, install times and auto-update stay local.
  const parsed = BackupPluginEntrySchema.safeParse({
    name: install.name,
    source: install.source,
    lockedSha: install.lockedSha,
    importedComponents: install.importedComponents,
  });
  if (!parsed.success) {
    // A row the restore side would refuse. Leaving it out would drop the plugin from the backup
    // without a word, so the push fails, like it does for a registry this build cannot read whole.
    throw new BackupServiceError(
      "IO_ERROR",
      `The installed plugin "${install.name}" cannot be listed in the backup: ${formatZodIssues(parsed.error.issues.slice(0, 2))}. ${AGENT_PLUGINS_OFF_HINT}`
    );
  }
  return parsed.data;
}

/**
 * Every managed install as a portable entry, sorted by name; null when there is none. A list over
 * the cap fails the push, like a registry this build cannot read whole: keeping the first
 * plugins would leave the rest out of the backup without a word. The code is IO_ERROR for the
 * same reason (`readInstallsToList`).
 */
export async function collectPluginBackup(
  muxRoot: string,
  lockTimeoutMs = MUTATION_LOCK_ACQUIRE_TIMEOUT_MS
): Promise<BackupPluginManifest | null> {
  const snapshot = await readInstallSnapshot(muxRoot, lockTimeoutMs);
  const plugins = snapshot
    .map(entryOf)
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (plugins.length > MAX_BACKUP_PLUGIN_ENTRIES) {
    throw new BackupServiceError(
      "IO_ERROR",
      `${plugins.length} plugins are installed here that a backup can list, and one backup lists at most ${MAX_BACKUP_PLUGIN_ENTRIES}. Backing up would leave ${plugins.length - MAX_BACKUP_PLUGIN_ENTRIES} of them out. Uninstalling that many plugins brings the count under the cap. ${AGENT_PLUGINS_OFF_HINT}`
    );
  }
  return plugins.length === 0 ? null : { schemaVersion: 1, plugins };
}

/** A monorepo folder with no leading or trailing slash, so `/a/b/` and `a/b` are one folder. */
function folderIdentity(subpath: string | undefined): string {
  return (subpath ?? "").replace(/^\/+|\/+$/g, "");
}

/**
 * The same repository URL as written, and the same folder, wherever the commit or ref of either
 * one points. Another spelling of one repository (`.git`, ssh against https, a host's case) is
 * another source here: a rule that merged spellings could also merge two repositories, and that
 * would count a different repository's plugin as kept with no approval. A spelling difference
 * asks for approval on a push and reads "Name in use" on a restore, which is the safe direction.
 */
function isSameSource(
  a: Pick<BackupPluginEntry["source"], "url" | "subpath">,
  b: Pick<BackupPluginEntry["source"], "url" | "subpath">
): boolean {
  return a.url === b.url && folderIdentity(a.subpath) === folderIdentity(b.subpath);
}

/**
 * The same plugin in the backup and in this export: the same name from the same repository and
 * folder (`isSameSource`). A new commit or ref of that repository is an update of the plugin,
 * which the user can read in the install review. A name now installed from another source is
 * another plugin: the list would silently swap what the backup holds for it.
 */
function isSamePlugin(listed: BackupPluginEntry, written: BackupPluginEntry): boolean {
  return listed.name === written.name && isSameSource(listed.source, written.source);
}

/**
 * The names a push removes from the backup's list, whether it removes the whole list, and whether
 * it replaces parts this build could not read. A name counts as removed when the export does not
 * write that plugin (`isSamePlugin`), so a plugin replaced by another source is named too. Undefined
 * when the backup has no list and nothing listed is lost. Every warning of a read marks a part
 * left out, so a read with warnings has unreadable parts, which a push that writes a list drops
 * without naming them.
 */
function pluginRemovalOf(
  prior: PluginListRead | null,
  written: BackupPluginManifest | null
): BackupPluginRemoval | undefined {
  if (prior === null) return undefined;
  const names = prior.plugins
    .filter((listed) => !written?.plugins.some((plugin) => isSamePlugin(listed, plugin)))
    .map((plugin) => plugin.name);
  const wholeList = written === null;
  const unreadable = prior.warnings.length > 0;
  if (!wholeList && !unreadable && names.length === 0) return undefined;
  names.sort();
  // JSON, not a delimiter: a name is repository-controlled text.
  const approval = sha256(Buffer.from(JSON.stringify({ names, wholeList, unreadable }), "utf-8"));
  return { names, wholeList, unreadable, approval };
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
  muxRoot: string;
  destination: string;
  contents: BackupContents;
  prior: PluginListRead | null;
}): Promise<{ files: BackupFile[]; pluginRemoval?: BackupPluginRemoval }> {
  const manifest = options.contents.includePlugins
    ? await collectPluginBackup(options.muxRoot)
    : null;
  const pluginRemoval = pluginRemovalOf(options.prior, manifest);
  if (manifest === null) return { files: [], pluginRemoval };
  const content = serializeSidecarManifest(manifest);
  const sidecar = path.join(options.destination, PLUGIN_BACKUP_DIR);
  await fs.mkdir(sidecar, { recursive: true, mode: 0o700 });
  await writeFileAtomic(path.join(sidecar, BACKUP_MANIFEST_FILE), content, { mode: 0o600 });
  await assertManagedTreeWithinLimits(options.destination);
  return { files: [{ path: PLUGIN_BACKUP_MANIFEST_PATH, content }], pluginRemoval };
}

/** Anything at the sidecar path counts, so a malformed one is still reported while the flag is off. */
function pluginBackupExists(sourceDir: string): Promise<boolean> {
  return sidecarExists(sourceDir, PLUGIN_BACKUP_DIR);
}

async function readManifestText(sourceDir: string): Promise<string> {
  // The walk refuses a symlink at the sidecar folder or the manifest, which git can store.
  const manifestPath = await resolveContainedPath(sourceDir, PLUGIN_BACKUP_MANIFEST_PATH);
  const stat = await lstatIfExists(manifestPath);
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

function unreadableList(reason: string): PluginListRead {
  return { plugins: [], warnings: [`The plugin list was not read: ${reason}.`] };
}

/** Row numbers keep every warning distinct, even for rows that share a name or have none. */
function rowLabel(row: unknown, index: number): string {
  const named = PluginRowNameSchema.safeParse(row);
  return named.success
    ? `row ${index + 1} ("${named.data.name.slice(0, 64)}")`
    : `row ${index + 1}`;
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
      problems.push(
        `Left out ${rowLabel(row, index)}: ${formatZodIssues(parsed.error.issues.slice(0, 2))}`
      );
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
    return unreadableList("it is not valid JSON");
  }
  const envelope = PluginListEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return unreadableList("only a version 1 list with a plugins array can be read here");
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
    return unreadableList(getErrorMessage(error));
  }
  return parsePluginList(text);
}

async function hasPluginFolder(muxRoot: string, name: string): Promise<boolean> {
  // lstat, so an unreadable plugins folder throws instead of reading as a plugin that is gone.
  return (await lstatIfExists(path.join(muxRoot, "plugins", name))) !== null;
}

/**
 * `installed`: that name at that commit from that repository and folder (`isSameSource`), with its
 * folder. `folderMissing`: the registry lists that plugin but the folder is gone, so it is not
 * installed and a reinstall would collide with the row. Another commit, another source under that
 * name, or a folder the installer does not manage: `conflict`. The restore only names a plugin by
 * its source, so a same-named plugin from elsewhere is not the one the backup pinned.
 */
async function statusOf(
  muxRoot: string,
  plugin: BackupPluginEntry,
  local: AgentPluginInstallEntry | undefined
): Promise<BackupPluginStatus> {
  if (
    local !== undefined &&
    (local.lockedSha !== plugin.lockedSha || !isSameSource(local.source, plugin.source))
  ) {
    return "conflict";
  }
  const folder = await hasPluginFolder(muxRoot, plugin.name);
  if (local === undefined) return folder ? "conflict" : "missing";
  return folder ? "installed" : "folderMissing";
}

/**
 * Each listed plugin against this machine's installs. The registry and the folders are read under
 * the plugin lock (`readInstallSnapshot`): an uninstall that lands between the two reads would
 * report a plugin that is gone as `folderMissing`, which a reinstall is withheld for.
 */
async function planPluginRows(
  muxRoot: string,
  listed: readonly BackupPluginEntry[],
  lockTimeoutMs: number
): Promise<BackupPluginRow[]> {
  // No rows, nothing to compare: a backup without a list never reads this machine's registry.
  if (listed.length === 0) return [];
  const release = await acquireSnapshotLock(muxRoot, lockTimeoutMs, "restore");
  try {
    const local = await readManagedInstalls(muxRoot);
    return await Promise.all(
      listed.map(async (plugin) => ({
        ...plugin,
        status: await statusOf(muxRoot, plugin, local.get(plugin.name)),
      }))
    );
  } finally {
    await release();
  }
}

/**
 * The checked-out list, as far as the flag lets this build read it. With the flag off the list is
 * only checked for existence, so a malformed one never blocks a settings-only restore, and its
 * presence is reported (`skipped`). With it on, an unreadable list or row comes back as a warning
 * (`readPluginBackup`), and a local disk failure still throws. Reads the backup only, so a
 * restore's validation can call it alone, before the snapshot.
 */
export async function readPluginSidecar(
  sourceDir: string,
  contents: BackupContents
): Promise<{ skipped: boolean; list: PluginListRead }> {
  if (!contents.includePlugins) {
    return { skipped: await pluginBackupExists(sourceDir), list: { plugins: [], warnings: [] } };
  }
  return { skipped: false, list: await readPluginBackup(sourceDir) };
}

/**
 * What a preview or restore reports of the backup's plugin list. Writes nothing: the rows are an
 * offer the user can take through the install review (see the note at the top of this file).
 */
export async function readPluginRestore(options: {
  muxRoot: string;
  sourceDir: string;
  contents: BackupContents;
  /** How long to wait for a plugin install, update or uninstall in progress. */
  lockTimeoutMs?: number;
}): Promise<BackupPluginReport> {
  const { skipped, list } = await readPluginSidecar(options.sourceDir, options.contents);
  return {
    rows: await planPluginRows(
      options.muxRoot,
      list.plugins,
      options.lockTimeoutMs ?? MUTATION_LOCK_ACQUIRE_TIMEOUT_MS
    ),
    skipped,
    warnings: list.warnings,
  };
}
