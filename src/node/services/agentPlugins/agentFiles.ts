import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { AgentIdSchema } from "@/common/schemas/ids";
import { parseAgentDefinitionMarkdown } from "@/node/services/agentDefinitions/parseAgentDefinitionMarkdown";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";

export interface PluginAgentFile {
  /** The file name in the agents directory. */
  name: string;
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
export async function listPluginAgentFiles(dir: string | undefined): Promise<PluginAgentFile[]> {
  if (dir === undefined) {
    return [];
  }
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: PluginAgentFile[] = [];
  // Runtime discovery dedupes by normalized agent ID with the first
  // successfully parsed file winning (discoverAgentDefinitions sets byId
  // once per ID, in the same readdir enumeration order used here). Mirror
  // that: on a case-sensitive filesystem agents/foo.md and agents/FOO.md
  // are ONE loadable agent, so the preview must promise one row and the
  // capability surface must not fingerprint a definition that never loads.
  const seenAgentIds = new Set<string>();
  for (const entry of entries) {
    const agentIdParse = AgentIdSchema.safeParse(path.parse(entry.name).name.trim().toLowerCase());
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || !agentIdParse.success) {
      continue;
    }
    if (seenAgentIds.has(agentIdParse.data)) {
      continue;
    }
    let frontmatter: unknown;
    try {
      const filePath = path.join(dir, entry.name);
      const stat = await fsPromises.stat(filePath);
      // Size-check BEFORE reading (mirroring runtime discovery): the parse
      // below applies the same cap, but only after the whole file has been
      // read and UTF-8-decoded — an untrusted repo pouring its checkout
      // quota into one agents/*.md could stall the main process first.
      if (stat.size > MAX_FILE_SIZE) {
        continue;
      }
      const content = await fsPromises.readFile(filePath, "utf8");
      // Throws on malformed frontmatter or oversized content — exactly the
      // definitions runtime discovery would skip.
      frontmatter = parseAgentDefinitionMarkdown({
        content,
        byteSize: stat.size,
        plugin: { agentId: agentIdParse.data },
      }).frontmatter;
    } catch {
      continue;
    }
    // Seen only AFTER a successful parse, mirroring runtime dedupe: when
    // the enumeration-order winner is malformed (skipped above), the next
    // same-ID file is the one that actually loads.
    seenAgentIds.add(agentIdParse.data);
    agents.push({ name: entry.name, id: agentIdParse.data, frontmatter });
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
