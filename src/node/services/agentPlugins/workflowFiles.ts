import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { listPluginSkillFolders, type PluginSkillsRoot } from "./discovery";

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
      .filter(isResolvableWorkflowName)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Whether `plugin://<plugin>/<name>` resolves to this top-level file (#6777). The resolver's
 * normalizeRelativeWorkflowPath refuses a name that starts with `~` and reads `\` as a path
 * separator, so the script would be nested and refused. Listing such a name would add a review
 * row for a script that never runs.
 */
function isResolvableWorkflowName(name: string): boolean {
  return !name.startsWith("~") && !name.includes("\\");
}

/** The entry a `skill://<skill>` workflow runs (workflowScriptDiscovery's launcher entry). */
export const SKILL_WORKFLOW_ENTRY = "workflow.js";

/**
 * The plugin-relative consent key of a skill script (#6629): `skills/foo/workflow.js`, with `/`.
 * Top-level workflow keys are bare file names, so the two key spaces never collide.
 */
export function pluginSkillScriptKey(pluginRoot: string, scriptPath: string): string {
  // Only the platform separator becomes `/`: on POSIX a backslash is a literal name character.
  const key = path.relative(pluginRoot, scriptPath).split(path.sep).join("/");
  // A single skill at the plugin root (PluginSkillsRoot `single`) puts its script directly in
  // the root. `./` keeps that key out of the bare-name space of top-level workflows.
  return key.includes("/") ? key : `./${key}`;
}

/**
 * The `workflow.js` of every skill directory in every skills root of a plugin (#6629). It lists
 * each root's copy, not only the one that wins by name: an extra row only asks for a review, and
 * a missed one would let a script run unreviewed. Only the entry is listed: the resolver refuses
 * any other script path of a managed plugin skill, because no review can approve it.
 */
export async function listPluginSkillScripts(plugin: {
  rootPath: string;
  skillsDirs?: PluginSkillsRoot[];
}): Promise<Array<{ file: string; filePath: string }>> {
  const scripts: Array<{ file: string; filePath: string }> = [];
  for (const skillsRoot of plugin.skillsDirs ?? []) {
    // A Claude command's folder is the commands folder, not a skill folder: no script of its own.
    if (skillsRoot.command) continue;
    for (const { name, dir } of await listPluginSkillFolders(skillsRoot)) {
      // Only a folder the runtime loads as a skill: a valid skill name with a SKILL.md.
      if (!SkillNameSchema.safeParse(name).success) continue;
      if (!(await isFileOrLink(path.join(dir, "SKILL.md")))) continue;
      const filePath = path.join(dir, SKILL_WORKFLOW_ENTRY);
      if (!(await isFileOrLink(filePath))) continue;
      scripts.push({ file: pluginSkillScriptKey(plugin.rootPath, filePath), filePath });
    }
  }
  return scripts;
}

async function isFileOrLink(filePath: string): Promise<boolean> {
  try {
    const stat = await fsPromises.lstat(filePath);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}
