import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { AgentIdSchema } from "@/common/schemas/ids";
import { parseAgentDefinitionMarkdown } from "@/node/services/agentDefinitions/parseAgentDefinitionMarkdown";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";

export interface PluginAgentFile {
  /** The file name in the agents directory. */
  file: string;
  /** The agent ID the runtime loads it under. */
  id: string;
  /** The parsed frontmatter (plugin format mapping applied), as the runtime parses it. */
  frontmatter: unknown;
}

/**
 * Agent definition files (agents/*.md) for the consent preview and the consent records (#6629),
 * mirroring runtime discovery exactly (agentDefinitionsService): only REGULAR files
 * (symlinks never load) whose basename parses as a valid agent ID AND
 * whose CONTENT parses as a runtime-valid definition (size cap included).
 * Filename-only fingerprinting would let an update repair a malformed
 * agents/foo.md in place — identical component sets on both sides — and
 * introduce a runnable agent without re-consent; the preview could
 * likewise advertise an agent that never loads.
 */
export async function listPluginAgentFiles(
  dir: string | undefined,
  /** Receives one warning per agent refused because two files claim its ID. */
  warnings: string[] = [],
  /** Receives the IDs of those refused agents. */
  ambiguousIds?: Set<string>
): Promise<PluginAgentFile[]> {
  if (dir === undefined) return [];
  const names = await readAgentFileNames(dir);
  const ambiguous = ambiguousPluginAgentIds(names, warnings);
  for (const agentId of ambiguous) ambiguousIds?.add(agentId);
  const agents: PluginAgentFile[] = [];
  for (const name of names) {
    const agentId = pluginAgentIdOf(name);
    if (agentId === null || ambiguous.has(agentId)) {
      continue;
    }
    const frontmatter = await readAgentFrontmatter(path.join(dir, name), agentId);
    if (frontmatter === undefined) {
      continue;
    }
    agents.push({ file: name, id: agentId, frontmatter });
  }
  return agents.sort((a, b) => a.file.localeCompare(b.file));
}

/** The regular files of an agents directory; none when it is unreadable. */
async function readAgentFileNames(dir: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return entries.flatMap((entry) => (entry.isFile() ? [entry.name] : []));
  } catch {
    return [];
  }
}

/** The agent ID a plugin file loads under: a `.md` file with a valid ID stem, lowercased. */
export function pluginAgentIdOf(fileName: string): string | null {
  const agentIdParse = AgentIdSchema.safeParse(path.parse(fileName).name.trim().toLowerCase());
  if (!fileName.toLowerCase().endsWith(".md") || !agentIdParse.success) return null;
  return agentIdParse.data;
}

/**
 * Agent IDs that two files of one agents directory claim (`Reviewer.md` and `reviewer.md` on a
 * case-sensitive filesystem). Discovery would list one file and the definition read would open the
 * other, so a review of one could approve the other's bytes. Xum refuses such an agent (#6629):
 * the review, discovery and the definition read all skip it, and each caller warns.
 */
export function ambiguousPluginAgentIds(
  fileNames: readonly string[],
  warnings: string[]
): Set<string> {
  const filesById = new Map<string, string[]>();
  for (const name of fileNames) {
    const agentId = pluginAgentIdOf(name);
    if (agentId !== null) filesById.set(agentId, [...(filesById.get(agentId) ?? []), name]);
  }
  const ambiguous = new Set<string>();
  for (const [agentId, files] of filesById) {
    if (files.length < 2) continue;
    ambiguous.add(agentId);
    warnings.push(
      `Agent '${agentId}' does not load: more than one file claims its ID (${files.sort().join(", ")}). Keep one of them.`
    );
  }
  return ambiguous;
}

/** The parsed frontmatter of one agent file, or undefined when the runtime would skip it. */
async function readAgentFrontmatter(filePath: string, agentId: string): Promise<unknown> {
  try {
    const stat = await fsPromises.stat(filePath);
    // Size-check BEFORE reading (mirroring runtime discovery): the parse
    // below applies the same cap, but only after the whole file has been
    // read and UTF-8-decoded — an untrusted repo pouring its checkout
    // quota into one agents/*.md could stall the main process first.
    if (stat.size > MAX_FILE_SIZE) {
      return undefined;
    }
    const content = await fsPromises.readFile(filePath, "utf8");
    // Throws on malformed frontmatter or oversized content — exactly the
    // definitions runtime discovery would skip.
    return parseAgentDefinitionMarkdown({
      content,
      byteSize: stat.size,
      plugin: { agentId },
    }).frontmatter;
  } catch {
    return undefined;
  }
}
