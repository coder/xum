import { createHash } from "node:crypto";
import { tool } from "ai";

import type { SkillsCatalogReadToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_TEXT_PAGE_MAX_CHARS } from "@/common/constants/toolLimits";
import { pageToolTextForResult, type ToolTextPage } from "@/common/utils/tools/pageToolText";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { fetchSkillContent, type FetchedSkillContent } from "./skillsCatalogFetch";

interface SkillsCatalogReadToolArgs {
  owner: string;
  repo: string;
  skillId: string;
  offset_chars?: number | null;
  snapshot?: string | null;
}

interface PinnedSkill {
  fetched: FetchedSkillContent;
  parsed: ReturnType<typeof parseSkillMarkdown>;
  /** Short content hash: the paging sequence's id, passed back as `snapshot`. */
  snapshot: string;
  pinnedAt: number;
}

// Later pages of a long body read the first page's fetch, not a new clone: each fetch
// shallow-clones the whole repo, and the branch can move between pages. Pins are keyed by the
// content hash, so a new first page by another reader adds a pin instead of replacing the one an
// earlier sequence still reads. Bounded: a few entries of at most MAX_FILE_SIZE (1 MB) each, for
// a short time.
const PIN_TTL_MS = 10 * 60 * 1000;
const PIN_MAX_ENTRIES = 8;
const pinnedSkills = new Map<string, PinnedSkill>();

function pinKey(owner: string, repo: string, skillId: string, snapshot: string): string {
  return JSON.stringify([owner, repo, skillId, snapshot]);
}

function contentSnapshot(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

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

async function fetchAndParseSkill(owner: string, repo: string, skillId: string, now: number) {
  const fetched = await fetchSkillContent(owner, repo, skillId);
  const parsed = parseSkillMarkdown({
    content: fetched.content,
    byteSize: Buffer.byteLength(fetched.content, "utf-8"),
    // Don't pass directoryName — catalog skills may have mismatched directory/frontmatter names.
  });
  return { fetched, parsed, snapshot: contentSnapshot(fetched.content), pinnedAt: now };
}

/** The note for a later page that could not read its sequence's pinned copy. */
function pinMissNote(requested: string | undefined, current: string): string {
  const source =
    requested == null
      ? "No snapshot was passed, so this page comes from a new fetch"
      : `The copy for snapshot ${requested} is no longer cached, and the skill changed since`;
  return (
    `${source}: this page is from snapshot ${current} and can disagree with earlier pages. ` +
    "Read again from offset_chars 0 for one consistent copy."
  );
}

/**
 * The skill for one page. A first page always fetches and, when the body has more pages,
 * pins the copy under its snapshot. A later page reads its snapshot's pin. A miss (expired,
 * evicted, unknown or absent snapshot) fetches again; when that copy has other bytes than the
 * requested snapshot, the page says so.
 */
/** The pinned copy a later page asks for by snapshot; undefined for a first page or a miss. */
function findPinnedSkillForPage(args: SkillsCatalogReadToolArgs, now: number) {
  if ((args.offset_chars ?? 0) <= 0 || args.snapshot == null) return undefined;
  return readPinnedSkill(pinKey(args.owner, args.repo, args.skillId, args.snapshot), now);
}

async function loadSkillForPage(
  args: SkillsCatalogReadToolArgs
): Promise<PinnedSkill & { pinNote?: string }> {
  const { owner, repo, skillId } = args;
  const laterPage = (args.offset_chars ?? 0) > 0;
  const requested = args.snapshot ?? undefined;
  const now = Date.now();
  const pinned = findPinnedSkillForPage(args, now);
  if (pinned != null) return pinned;
  const loaded = await fetchAndParseSkill(owner, repo, skillId, now);
  if (loaded.parsed.body.length > TOOL_TEXT_PAGE_MAX_CHARS) {
    pinSkill(pinKey(owner, repo, skillId, loaded.snapshot), loaded);
  }
  return laterPage && requested !== loaded.snapshot
    ? { ...loaded, pinNote: pinMissNote(requested, loaded.snapshot) }
    : loaded;
}

/** Only a body with more than one page needs the snapshot to read the others. */
function snapshotField(
  paging: Omit<ToolTextPage, "text">,
  snapshot: string
): { snapshot?: string } {
  return paging.nextCharOffset != null || paging.startCharOffset != null ? { snapshot } : {};
}

function joinNotes(...notes: Array<string | undefined>): { note?: string } {
  const present = notes.filter((note): note is string => note != null);
  return present.length > 0 ? { note: present.join(" ") } : {};
}

export const createSkillsCatalogReadTool: ToolFactory = (_config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.skills_catalog_read.description,
    inputSchema: TOOL_DEFINITIONS.skills_catalog_read.schema,
    execute: async (args: SkillsCatalogReadToolArgs): Promise<SkillsCatalogReadToolResult> => {
      const { owner, repo, skillId } = args;
      try {
        const { fetched, parsed, snapshot, pinNote } = await loadSkillForPage(args);

        // Catalog SKILL.md files can reach MAX_FILE_SIZE (1 MB): return the body in pages.
        const { text: body, ...paging } = pageToolTextForResult(
          parsed.body,
          args.offset_chars,
          `skills_catalog_read(owner: "${owner}", repo: "${repo}", skillId: "${skillId}", offset_chars: <offset>, snapshot: "${snapshot}")`
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
          ...snapshotField(paging, snapshot),
          ...joinNotes(pinNote, paging.note),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
};
