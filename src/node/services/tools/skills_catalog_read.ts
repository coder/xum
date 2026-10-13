import { tool } from "ai";

import type { SkillsCatalogReadToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { formatNextPageNote, pageToolText } from "@/common/utils/tools/pageToolText";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { fetchSkillContent } from "./skillsCatalogFetch";

interface SkillsCatalogReadToolArgs {
  owner: string;
  repo: string;
  skillId: string;
  offset_chars?: number | null;
}

export const createSkillsCatalogReadTool: ToolFactory = (_config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.skills_catalog_read.description,
    inputSchema: TOOL_DEFINITIONS.skills_catalog_read.schema,
    execute: async ({
      owner,
      repo,
      skillId,
      offset_chars,
    }: SkillsCatalogReadToolArgs): Promise<SkillsCatalogReadToolResult> => {
      try {
        const fetched = await fetchSkillContent(owner, repo, skillId);

        const parsed = parseSkillMarkdown({
          content: fetched.content,
          byteSize: Buffer.byteLength(fetched.content, "utf-8"),
          // Don't pass directoryName — catalog skills may have mismatched directory/frontmatter names.
        });

        // Catalog SKILL.md files can reach MAX_FILE_SIZE (1 MB): return the body in pages.
        const page = pageToolText(parsed.body, offset_chars ?? 0);
        return {
          success: true,
          skillId,
          owner,
          repo,
          path: fetched.path,
          frontmatter: parsed.frontmatter,
          body: page.text,
          url: `https://github.com/${owner}/${repo}/blob/${fetched.branch}/${fetched.path}`,
          ...(page.nextCharOffset != null
            ? {
                nextCharOffset: page.nextCharOffset,
                note: formatNextPageNote(
                  page.nextCharOffset,
                  `skills_catalog_read(owner: "${owner}", repo: "${repo}", skillId: "${skillId}", offset_chars: <offset>)`
                ),
              }
            : {}),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
};
