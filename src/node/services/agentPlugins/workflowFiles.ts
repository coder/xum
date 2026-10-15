import * as fsPromises from "node:fs/promises";

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
