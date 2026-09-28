import {
  AgentPluginInstallEntrySchema,
  type AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import {
  BackupPluginRecipeSchema,
  MAX_BACKUP_PLUGIN_RECIPES,
  type BackupPluginRecipe,
} from "@/common/config/schemas/settingsBackup";
import type { BackupPendingPlugin } from "@/common/orpc/schemas/backup";
import { isPlainObject } from "@/common/utils/isPlainObject";

/**
 * A backup's `plugins` block: one reinstall recipe per managed plugin, and nothing else about
 * plugins (no timestamps, manifest, auto-update flag, plugin data, or MCP enablement). Plugins
 * run third-party code, so a restore never installs one or writes plugin state; it only offers
 * the recipes to the normal install preview. Restore never uninstalls either, so the block need
 * not be a complete snapshot: an absent block, as in a backup an older build wrote, offers none.
 */

function toRecipe(entry: AgentPluginInstallEntry): unknown {
  return {
    name: entry.name,
    source: entry.source,
    lockedSha: entry.lockedSha,
    importedComponents: entry.importedComponents,
  };
}

/** From the raw entries the registry's lenient reader returns, never a copy of the file. */
export function projectBackupPlugins(rawEntries: readonly unknown[]): BackupPluginRecipe[] {
  const recipes: BackupPluginRecipe[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntries) {
    if (recipes.length === MAX_BACKUP_PLUGIN_RECIPES) break;
    const entry = AgentPluginInstallEntrySchema.safeParse(raw);
    // The first valid row of a name wins, as in the registry's own lenient view.
    if (!entry.success || seen.has(entry.data.name)) continue;
    seen.add(entry.data.name);
    // Through the schema a restore reads with, so every exported recipe is one a restore
    // accepts. A source that fails it (a URL with credentials, a local path, a remote helper)
    // must not be published, so that plugin stays off the backup.
    const recipe = BackupPluginRecipeSchema.safeParse(toRecipe(entry.data));
    if (recipe.success) recipes.push(recipe.data);
  }
  return recipes;
}

export interface BackupPluginsRead {
  recipes: BackupPluginRecipe[];
  /** Entries a restore skips, labeled `plugins.<name>` (or by index) for the restore notice. */
  unsupported: string[];
}

/** Reads the `plugins` block of a preferences document. */
export function readBackupPlugins(document: unknown): BackupPluginsRead {
  if (!isPlainObject(document) || document.plugins === undefined) {
    return { recipes: [], unsupported: [] };
  }
  const block = document.plugins;
  if (!Array.isArray(block)) return { recipes: [], unsupported: ["plugins (not an array)"] };
  const recipes: BackupPluginRecipe[] = [];
  const unsupported: string[] =
    block.length > MAX_BACKUP_PLUGIN_RECIPES
      ? [`plugins (over ${MAX_BACKUP_PLUGIN_RECIPES} entries)`]
      : [];
  const seen = new Set<string>();
  block.slice(0, MAX_BACKUP_PLUGIN_RECIPES).forEach((raw: unknown, index) => {
    const parsed = BackupPluginRecipeSchema.safeParse(raw);
    if (parsed.success && !seen.has(parsed.data.name)) {
      seen.add(parsed.data.name);
      recipes.push(parsed.data);
      return;
    }
    // Only a valid name is echoed into the notice; anything else is repository-controlled
    // text of any length.
    const name = AgentPluginInstallEntrySchema.shape.name.safeParse(
      isPlainObject(raw) ? raw.name : undefined
    );
    unsupported.push(name.success ? `plugins.${name.data}` : `plugins[${index}]`);
  });
  return { recipes, unsupported };
}

/**
 * The recipes not installed here, against the raw registry entries. A name installed from the
 * same source counts as installed at whatever commit it is (moving it is the Update flow's
 * job). A name installed from another source, or owned by a row this build cannot read, is a
 * conflict: the installer would refuse it, so it is listed but never offered.
 */
export function pendingBackupPlugins(
  recipes: readonly BackupPluginRecipe[],
  rawRegistryEntries: readonly unknown[]
): BackupPendingPlugin[] {
  const installed = new Map<string, AgentPluginInstallEntry | null>();
  for (const raw of rawRegistryEntries) {
    if (!isPlainObject(raw) || typeof raw.name !== "string") continue;
    const parsed = AgentPluginInstallEntrySchema.safeParse(raw);
    if (installed.get(raw.name) == null) {
      installed.set(raw.name, parsed.success ? parsed.data : null);
    }
  }
  return recipes.flatMap((recipe): BackupPendingPlugin[] => {
    if (!installed.has(recipe.name)) return [{ recipe, conflict: false }];
    const entry = installed.get(recipe.name);
    const sameSource =
      entry != null &&
      entry.source.url === recipe.source.url &&
      entry.source.subpath === recipe.source.subpath;
    return sameSource ? [] : [{ recipe, conflict: true }];
  });
}
