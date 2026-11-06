import * as fs from "fs/promises";
import * as path from "path";
import {
  AgentPluginInstallEntrySchema,
  type AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import type { BackupContents } from "@/common/config/schemas/settingsBackup";
import type { AgentPluginInstallMethod } from "@/common/orpc/schemas/agentPlugins";
import {
  BackupPluginEntrySchema,
  BackupPluginManifestSchema,
  MAX_BACKUP_PLUGIN_ENTRIES,
  type BackupPluginEntry,
  type BackupPluginInstall,
  type BackupPluginManifest,
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
  BackupInvalidPayloadError,
  isFilesystemError,
  MAX_BACKUP_FILE_BYTES,
  resolveContainedPath,
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
 * Writes the sidecar into the managed copy and returns the files the push now publishes, for the
 * secret scan. Off, or with nothing installed, it writes nothing: the core write already cleared
 * the managed path, so a list pushed earlier disappears from the next tree.
 */
export async function exportPluginBackup(options: {
  rootDir: string;
  destination: string;
  contents: BackupContents;
}): Promise<BackupFile[]> {
  if (!options.contents.includePlugins) return [];
  const manifest = await collectPluginBackup(options.rootDir);
  if (manifest === null) return [];
  const content = serializePluginBackupManifest(manifest);
  const sidecar = path.join(options.destination, PLUGIN_BACKUP_DIR);
  await fs.mkdir(sidecar, { recursive: true, mode: 0o700 });
  await writeFileAtomic(path.join(sidecar, BACKUP_MANIFEST_FILE), content, { mode: 0o600 });
  await assertManagedTreeWithinLimits(options.destination);
  return [{ path: PLUGIN_BACKUP_MANIFEST_PATH, content }];
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

function parseManifest(text: string): BackupPluginManifest {
  const parsed = BackupPluginManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Backup plugin list is invalid at '${issue?.path.join(".") ?? ""}': ${issue?.message ?? ""}`
    );
  }
  return parsed.data;
}

/**
 * The checked-out list, validated whole: null when the backup has none, INVALID_BACKUP when it is
 * malformed. A local disk failure keeps its own error, so it is not blamed on the repository.
 */
export async function readPluginBackup(sourceDir: string): Promise<BackupPluginManifest | null> {
  if (!(await pluginBackupExists(sourceDir))) return null;
  try {
    return parseManifest(await readManifestText(sourceDir));
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    throw new BackupInvalidPayloadError(error);
  }
}

/** `installed`: that name at that commit. Another commit, or a folder the installer does not manage: `conflict`. */
async function statusOf(
  rootDir: string,
  plugin: BackupPluginEntry,
  local: AgentPluginInstallEntry | undefined
): Promise<BackupPluginInstall["status"]> {
  if (local !== undefined) return local.lockedSha === plugin.lockedSha ? "installed" : "conflict";
  const folder = await fs.lstat(path.join(rootDir, "plugins", plugin.name)).catch(() => null);
  return folder === null ? "missing" : "conflict";
}

async function planPluginInstalls(
  rootDir: string,
  manifest: BackupPluginManifest
): Promise<BackupPluginInstall[]> {
  const local = await readManagedInstalls(rootDir);
  return await Promise.all(
    manifest.plugins.map(async (plugin) => ({
      ...plugin,
      status: await statusOf(rootDir, plugin, local.get(plugin.name)),
    }))
  );
}

/**
 * What a preview or restore reports of the backup's plugin list. Writes nothing: the rows are an
 * offer the user can take through the install review (see the note at the top of this file).
 * With the flag off the list is only checked for existence, so a malformed one never blocks a
 * settings-only restore, and its presence is reported.
 */
export async function readPluginRestore(options: {
  rootDir: string;
  sourceDir: string;
  contents: BackupContents;
}): Promise<{ pluginInstalls: BackupPluginInstall[]; pluginListSkipped: boolean }> {
  if (!options.contents.includePlugins) {
    return { pluginInstalls: [], pluginListSkipped: await pluginBackupExists(options.sourceDir) };
  }
  const manifest = await readPluginBackup(options.sourceDir);
  return {
    pluginInstalls: manifest === null ? [] : await planPluginInstalls(options.rootDir, manifest),
    pluginListSkipped: false,
  };
}
