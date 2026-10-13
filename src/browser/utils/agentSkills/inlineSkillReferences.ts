import type { APIClient } from "@/browser/contexts/API";
import type { SkillResolutionTarget } from "@/browser/features/ChatInput/utils";
import { SkillNameSchema, resolveSkillUserInvocable } from "@/common/orpc/schemas/agentSkill";
import type { InvocableSkill } from "@/common/types/agentSkill";
import {
  parseSkillLookupName,
  resolveSkillReadIdentity,
} from "@/common/utils/agentSkills/skillLookupName";
import type { AgentSkillReference } from "@/common/types/message";
import { dedupeAgentSkillRefs } from "@/common/types/message";
import { isMcpPromptCommandKey } from "@/common/utils/tools/mcpPromptCommandKey";
import {
  collectCodeRanges,
  isCursorInsideCodeRange,
  isPositionInRange,
} from "@/browser/utils/markdown/codeRanges";

/** Parser-only candidate. The startIndex/endIndex are autocomplete-replacement aids
 *  and MUST NOT be persisted in metadata (they become ambiguous after edits/reviews/etc.). */
export interface InlineSkillCandidate {
  skillName: string;
  startIndex: number;
  endIndex: number;
  /**
   * Qualified `$plugin:skill` candidates only: the bare `$plugin` prefix, resolved
   * when the qualified name is unknown (so `$tdd:foo` still loads `tdd`).
   */
  fallback?: InlineSkillCandidate;
}

/** Active candidate when the cursor is inside a `$partial` token (used by autocomplete). */
interface InlineSkillCursorMatch {
  partial: string;
  startIndex: number;
  endIndex: number;
}

const LEFT_BOUNDARY_BLOCKED_RE = /[\w$]/;
// `<plugin>:<skill>` after `$`. Plugin names may hold `.`; a trailing `.` or `:`
// stays punctuation because a skill segment must follow the `:`.
const QUALIFIED_SKILL_TOKEN_RE = /[a-z][a-z0-9.-]*:[a-z0-9-]+/y;
// Cursor partials for the qualified form: `$pstack:` and `$pstack:t` suggest.
const QUALIFIED_PARTIAL_RE = /^[a-z][a-z0-9.-]*:[a-z0-9-]*$/;

function isSkillStartChar(ch: string | undefined): boolean {
  return Boolean(ch && ch >= "a" && ch <= "z");
}

function isSkillContinuationChar(ch: string | undefined): boolean {
  return Boolean(
    ch && ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_")
  );
}

function hasSaneLeftBoundary(text: string, dollarIndex: number): boolean {
  if (dollarIndex === 0) {
    return true;
  }

  return !LEFT_BOUNDARY_BLOCKED_RE.test(text[dollarIndex - 1] ?? "");
}

function isQualifiedTokenChar(ch: string | undefined): boolean {
  return isSkillContinuationChar(ch) || ch === "." || ch === ":";
}

/** The qualified lookup name starting at `start`, or null when none parses there. */
function matchQualifiedSkillToken(text: string, start: number): string | null {
  QUALIFIED_SKILL_TOKEN_RE.lastIndex = start;
  const token = QUALIFIED_SKILL_TOKEN_RE.exec(text)?.[0].replace(/-+$/, "");
  return token != null && parseSkillLookupName(token)?.pluginName != null ? token : null;
}

/** Wrap a bare candidate in its qualified form when one parses at the same `$`. */
function withQualifiedCandidate(
  text: string,
  bare: InlineSkillCandidate | null,
  dollarIndex: number
): InlineSkillCandidate | null {
  const qualified = matchQualifiedSkillToken(text, dollarIndex + 1);
  if (qualified == null) return bare;
  return {
    skillName: qualified,
    startIndex: dollarIndex,
    endIndex: dollarIndex + 1 + qualified.length,
    ...(bare != null ? { fallback: bare } : {}),
  };
}

function isPartialToken(rawPartial: string): boolean {
  if (rawPartial.length === 0) {
    return true;
  }

  if (!isSkillStartChar(rawPartial[0])) {
    return false;
  }

  for (let index = 1; index < rawPartial.length; index++) {
    if (!isSkillContinuationChar(rawPartial[index])) {
      return false;
    }
  }

  return true;
}

/** The candidate for the `$` at `dollarIndex` (a letter follows it) and where scanning resumes. */
function readSkillCandidateAt(
  text: string,
  dollarIndex: number
): { candidate: InlineSkillCandidate | null; scanEnd: number } {
  let tokenEnd = dollarIndex + 2;
  while (tokenEnd < text.length && isSkillContinuationChar(text[tokenEnd])) {
    tokenEnd++;
  }

  const rawTokenEnd = tokenEnd;
  let skillName = text.slice(dollarIndex + 1, tokenEnd);
  if (skillName.endsWith("-")) {
    skillName = skillName.slice(0, -1);
    tokenEnd--;
  }

  const bare =
    SkillNameSchema.safeParse(skillName).success || isMcpPromptCommandKey(skillName)
      ? { skillName, startIndex: dollarIndex, endIndex: tokenEnd }
      : null;
  const candidate = withQualifiedCandidate(text, bare, dollarIndex);
  return { candidate, scanEnd: Math.max(rawTokenEnd, candidate?.endIndex ?? rawTokenEnd) };
}

export function extractInlineSkillReferenceCandidates(text: string): InlineSkillCandidate[] {
  if (!text.includes("$")) {
    return [];
  }

  const codeRanges = collectCodeRanges(text);
  const candidates: InlineSkillCandidate[] = [];
  let codeRangeIndex = 0;

  for (let index = 0; index < text.length; index++) {
    while (codeRangeIndex < codeRanges.length && index >= codeRanges[codeRangeIndex].end) {
      codeRangeIndex++;
    }

    const codeRange = codeRanges[codeRangeIndex];
    if (codeRange && isPositionInRange(index, codeRange)) {
      index = codeRange.end - 1;
      continue;
    }

    if (text[index] !== "$" || !hasSaneLeftBoundary(text, index)) {
      continue;
    }

    if (!isSkillStartChar(text[index + 1])) {
      continue;
    }

    const { candidate, scanEnd } = readSkillCandidateAt(text, index);
    if (candidate) candidates.push(candidate);
    index = scanEnd - 1;
  }

  return candidates;
}

export function findInlineSkillReferenceAtCursor(
  text: string,
  cursor: number
): InlineSkillCursorMatch | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length || !text.includes("$")) {
    return null;
  }

  const codeRanges = collectCodeRanges(text);
  if (codeRanges.some((range) => isCursorInsideCodeRange(cursor, range))) {
    return null;
  }

  // A qualified `$plugin:skill` partial first, then the bare token as before.
  return (
    matchCursorToken(text, cursor, isQualifiedTokenChar, (partial) =>
      QUALIFIED_PARTIAL_RE.test(partial)
    ) ?? matchCursorToken(text, cursor, isSkillContinuationChar, isPartialToken)
  );
}

function tokenStartBefore(
  text: string,
  cursor: number,
  isTokenChar: (ch: string | undefined) => boolean
): number {
  let tokenStart = cursor;
  while (tokenStart > 0 && isTokenChar(text[tokenStart - 1])) tokenStart--;
  return tokenStart;
}

function tokenEndAfter(
  text: string,
  cursor: number,
  isTokenChar: (ch: string | undefined) => boolean
): number {
  let tokenEnd = cursor;
  while (tokenEnd < text.length && isTokenChar(text[tokenEnd])) tokenEnd++;
  return tokenEnd;
}

function matchCursorToken(
  text: string,
  cursor: number,
  isTokenChar: (ch: string | undefined) => boolean,
  isValidPartial: (partial: string) => boolean
): InlineSkillCursorMatch | null {
  const tokenStart = tokenStartBefore(text, cursor, isTokenChar);
  const dollarIndex = tokenStart > 0 && text[tokenStart - 1] === "$" ? tokenStart - 1 : -1;
  if (dollarIndex === -1 || !hasSaneLeftBoundary(text, dollarIndex)) {
    return null;
  }

  const tokenEnd = tokenEndAfter(text, cursor, isTokenChar);
  const partial = text.slice(dollarIndex + 1, tokenEnd);
  if (!isValidPartial(partial)) {
    return null;
  }

  return {
    partial,
    startIndex: dollarIndex,
    endIndex: tokenEnd,
  };
}

interface InlineSkillResolveOptions {
  candidates: InlineSkillCandidate[];
  agentSkillDescriptors: InvocableSkill[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}

async function resolveRemoteSkill(options: {
  skillName: string;
  api: APIClient;
  discovery: SkillResolutionTarget;
}): Promise<InvocableSkill | null> {
  try {
    const pkg =
      options.discovery.kind === "project"
        ? await options.api.agentSkills.get({
            projectPath: options.discovery.projectPath,
            skillName: options.skillName,
          })
        : await options.api.agentSkills.get({
            workspaceId: options.discovery.workspaceId,
            disableWorkspaceAgents: options.discovery.disableWorkspaceAgents,
            skillName: options.skillName,
          });

    // The remote fallback fetches raw frontmatter, so apply the same user-invocability
    // gate the local descriptor list already carries in normalized form.
    if (resolveSkillUserInvocable(pkg.frontmatter) === false) {
      return null;
    }

    return {
      // A typed `pstack:tdd` must keep naming the plugin's skill.
      name: resolveSkillReadIdentity({ name: options.skillName }, pkg.frontmatter.name),
      description: pkg.frontmatter.description,
      scope: pkg.scope,
    };
  } catch {
    return null;
  }
}

export async function resolveInlineSkillReferences(
  options: InlineSkillResolveOptions
): Promise<AgentSkillReference[]> {
  if (options.candidates.length === 0) {
    return [];
  }

  const refs: AgentSkillReference[] = [];
  const seenSkillNames = new Set<string>();

  for (const candidate of options.candidates) {
    if (seenSkillNames.has(candidate.skillName)) {
      continue;
    }
    seenSkillNames.add(candidate.skillName);

    // An unknown `$plugin:skill` falls back to its bare `$plugin` prefix.
    const skill =
      (await resolveInlineSkill(candidate.skillName, options)) ??
      (candidate.fallback ? await resolveInlineSkill(candidate.fallback.skillName, options) : null);
    if (!skill) {
      continue;
    }

    refs.push({ skillName: skill.name, scope: skill.scope, source: "inline" });
  }

  return dedupeAgentSkillRefs(refs);
}

async function resolveInlineSkill(
  skillName: string,
  options: InlineSkillResolveOptions
): Promise<InvocableSkill | null> {
  // user-invocable: false skills must be treated as nonexistent for inline $skill refs
  // (they remain model-invocable via agent_skill_read).
  const skill = options.agentSkillDescriptors.find(
    (descriptor) => descriptor.name === skillName && descriptor.userInvocable !== false
  );
  if (skill) return skill;
  if (!options.api || !options.discovery) return null;
  return resolveRemoteSkill({ skillName, api: options.api, discovery: options.discovery });
}
