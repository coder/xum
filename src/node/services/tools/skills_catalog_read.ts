import { tool } from "ai";

import type { SkillsCatalogReadToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_TEXT_PAGE_MAX_CHARS } from "@/common/constants/toolLimits";
import { pageToolTextForResult } from "@/common/utils/tools/pageToolText";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { fetchSkillContent, type FetchedSkillContent } from "./skillsCatalogFetch";

interface SkillsCatalogReadToolArgs {
  owner: string;
  repo: string;
  skillId: string;
  offset_chars?: number | null;
}

interface PinnedSkill {
  fetched: FetchedSkillContent;
  parsed: ReturnType<typeof parseSkillMarkdown>;
  pinnedAt: number;
}

// Later pages of a long body read the first page's fetch, not a new clone: each fetch
// shallow-clones the whole repo, and the branch can move between pages. Bounded: a few
// entries of at most MAX_FILE_SIZE (1 MB) each, for a short time.
const PIN_TTL_MS = 10 * 60 * 1000;
const PIN_MAX_ENTRIES = 8;
const pinnedSkills = new Map<string, PinnedSkill>();

const PIN_MISS_NOTE =
  "The copy fetched for the first page expired, so this page comes from a new fetch. If the " +
  "skill changed since, pages can disagree: read again from offset_chars 0 for one consistent copy.";

function readPinnedSkill(key: string, now: number): PinnedSkill | undefined {
  const pinned = pinnedSkills.get(key);
  if (pinned != null && now - pinned.pinnedAt <= PIN_TTL_MS) return pinned;
  pinnedSkills.delete(key);
  return undefined;
}

function pinSkill(key: string, pinned: PinnedSkill): void {
  pinnedSkills.delete(key);
  pinnedSkills.set(key, pinned);
  // Map order is insertion order: drop the oldest pins past the bound.
  for (const oldest of pinnedSkills.keys()) {
    if (pinnedSkills.size <= PIN_MAX_ENTRIES) break;
    pinnedSkills.delete(oldest);
  }
}

async function fetchAndParseSkill(owner: string, repo: string, skillId: string) {
  const fetched = await fetchSkillContent(owner, repo, skillId);
  const parsed = parseSkillMarkdown({
    content: fetched.content,
    byteSize: Buffer.byteLength(fetched.content, "utf-8"),
    // Don't pass directoryName — catalog skills may have mismatched directory/frontmatter names.
  });
  return { fetched, parsed };
}

/**
 * The skill for one page. The first page always fetches and, when the body has more pages,
 * pins the copy; later pages read the pin. A missed pin (expired or evicted) fetches again and
 * says so, because the new copy can differ from the pages already read.
 */
async function loadSkillForPage(
  owner: string,
  repo: string,
  skillId: string,
  offsetArg: number | null | undefined
): Promise<PinnedSkill & { pinNote?: string }> {
  const offsetChars = offsetArg ?? 0;
  const key = JSON.stringify([owner, repo, skillId]);
  const now = Date.now();
  const pinned = offsetChars > 0 ? readPinnedSkill(key, now) : undefined;
  if (pinned != null) return pinned;
  const loaded = { ...(await fetchAndParseSkill(owner, repo, skillId)), pinnedAt: now };
  if (loaded.parsed.body.length > TOOL_TEXT_PAGE_MAX_CHARS) pinSkill(key, loaded);
  return offsetChars > 0 ? { ...loaded, pinNote: PIN_MISS_NOTE } : loaded;
}

function joinNotes(...notes: Array<string | undefined>): { note?: string } {
  const present = notes.filter((note): note is string => note != null);
  return present.length > 0 ? { note: present.join(" ") } : {};
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
        const { fetched, parsed, pinNote } = await loadSkillForPage(
          owner,
          repo,
          skillId,
          offset_chars
        );

        // Catalog SKILL.md files can reach MAX_FILE_SIZE (1 MB): return the body in pages.
        const { text: body, ...paging } = pageToolTextForResult(
          parsed.body,
          offset_chars,
          `skills_catalog_read(owner: "${owner}", repo: "${repo}", skillId: "${skillId}", offset_chars: <offset>)`
        );
        return {
          success: true,
          skillId,
          owner,
          repo,
          path: fetched.path,
          frontmatter: parsed.frontmatter,
          body,
          url: `https://github.com/${owner}/${repo}/blob/${fetched.branch}/${fetched.path}`,
          ...paging,
          ...joinNotes(pinNote, paging.note),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
};
