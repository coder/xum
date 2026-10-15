import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

/**
 * Top-level `*.js` entries of a plugin workflows/ dir, files and symlinks, sorted. The one lister
 * of the runtime launcher and the consent review (#6629): the resolver runs exactly these names
 * (`.js`, case-sensitive, no nested paths), so a review must cover exactly them.
 */
export async function listPluginWorkflowFiles(workflowsDir: string | undefined): Promise<string[]> {
  if (workflowsDir === undefined) return [];
  try {
    const entries = await fsPromises.readdir(workflowsDir, { withFileTypes: true });
    return entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".js"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The entry a `skill://<skill>` workflow runs (workflowScriptDiscovery's launcher entry). */
export const SKILL_WORKFLOW_ENTRY = "workflow.js";

/**
 * The plugin-relative consent key of a skill script (#6629): `skills/foo/workflow.js`, with `/`.
 * Top-level workflow keys are bare file names, so the two key spaces never collide.
 */
export function pluginSkillScriptKey(pluginRoot: string, scriptPath: string): string {
  return path.relative(pluginRoot, scriptPath).replaceAll("\\", "/");
}

/**
 * The `workflow.js` of every skill directory in every skills root of a plugin (#6629). It lists
 * each root's copy, not only the one that wins by name: an extra row only asks for a review, and
 * a missed one would let a script run unreviewed. Only the entry is listed: the resolver refuses
 * any other script path of a managed plugin skill, because no review can approve it.
 */
export async function listPluginSkillScripts(plugin: {
  rootPath: string;
  skillsDirs?: string[];
}): Promise<Array<{ file: string; filePath: string }>> {
  const scripts: Array<{ file: string; filePath: string }> = [];
  for (const skillsDir of plugin.skillsDirs ?? []) {
    for (const dirName of await listSubdirectories(skillsDir)) {
      const filePath = path.join(skillsDir, dirName, SKILL_WORKFLOW_ENTRY);
      if (!(await isFileOrLink(filePath))) continue;
      scripts.push({ file: pluginSkillScriptKey(plugin.rootPath, filePath), filePath });
    }
  }
  return scripts;
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function isFileOrLink(filePath: string): Promise<boolean> {
  try {
    const stat = await fsPromises.lstat(filePath);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}
