import { PATH_SKILLS_RESULT_FIELD, type PathSkillsResultField } from "@/common/types/tools";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { MuxMessage } from "@/common/types/message";
import { deriveProjectRelativePath } from "@/common/utils/review/assistedReview";
import { createSkillPathsMatcher } from "@/common/utils/skills/skillPaths";
import { log } from "@/node/services/log";
import type { Runtime } from "@/node/runtime/Runtime";
import { resolvePathWithinCwd } from "@/node/services/tools/fileCommon";
import { formatSkillIndexDescription } from "@/node/services/tools/agent_skill_read";

/**
 * Path-scoped skills (`paths` frontmatter): after a successful direct file_read /
 * file_edit_* on a matching file, the tool result gets a persisted pointer naming the
 * skill(s), so the model reads them with agent_skill_read. A pointer (not the body)
 * keeps tokens bounded, and riding the persisted tool result keeps history append-only
 * (prompt-cache friendly). Each skill surfaces at most once per context window.
 */

/** Per-turn activation state, shared by every tool rebuild within the turn. */
export interface PathSkillActivation {
  /**
   * Skills the touched file activates that have not surfaced yet in this context
   * window. Marks them surfaced synchronously, so parallel tool calls in one step
   * never surface the same skill twice.
   */
  takeMatches(toolPath: string): AgentSkillDescriptor[];
  /**
   * Record a skill the model read during this turn (agent_skill_read), so a later
   * matching file call in the same turn does not point at it again.
   */
  markSurfaced(skillName: string): void;
}

/** Bounds one tool result's pointer even when many skills match one file. */
const MAX_SKILLS_PER_TOOL_CALL = 3;

/**
 * Bounds per-turn glob compilation: skills come from untrusted repositories, and each
 * may carry up to 50 patterns. Skills past the cap never activate (logged).
 */
export const MAX_PATH_SCOPED_SKILLS = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function addName(names: Set<string>, value: unknown): void {
  if (typeof value === "string") names.add(value);
}

function collectPointerNames(output: Record<string, unknown> | undefined, names: Set<string>) {
  const skills = asRecord(output?.[PATH_SKILLS_RESULT_FIELD])?.skills;
  if (!Array.isArray(skills)) return;
  for (const skill of skills) addName(names, asRecord(skill)?.name);
}

function collectFromToolPart(part: Record<string, unknown>, names: Set<string>): void {
  const output = asRecord(part.output);
  collectPointerNames(output, names);
  // A skill the model already read in this window needs no pointer.
  if (part.toolName === "agent_skill_read" && output?.success === true) {
    addName(names, asRecord(part.input)?.name);
  }
}

function collectFromParts(parts: unknown, names: Set<string>): void {
  if (!Array.isArray(parts)) return;
  for (const rawPart of parts) {
    const part = asRecord(rawPart);
    if (part?.type === "dynamic-tool") collectFromToolPart(part, names);
  }
}

/**
 * Names of skills already in the context window: prior pointers, successful
 * agent_skill_read calls, and /skill-name snapshot rows. History is untrusted on disk,
 * so malformed rows are skipped, never thrown on (self-healing).
 */
export function collectSurfacedSkillNames(messages: readonly MuxMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    const record = asRecord(message);
    addName(names, asRecord(asRecord(record?.metadata)?.agentSkillSnapshot)?.skillName);
    collectFromParts(record?.parts, names);
  }
  return names;
}

/**
 * The workspace-root-relative POSIX path a file tool touches, resolved like the file
 * tools do, or undefined for files outside the workspace (globs never match those).
 */
function toWorkspaceRelativePath(
  toolPath: string,
  cwd: string,
  runtime: Runtime
): string | undefined {
  const { resolvedPath } = resolvePathWithinCwd(toolPath, cwd, runtime);
  const relativePath = deriveProjectRelativePath(runtime.normalizePath(".", cwd), resolvedPath);
  if (relativePath == null || relativePath === "" || relativePath.startsWith("../")) {
    return undefined;
  }
  return relativePath;
}

/**
 * Build the turn's activation, or undefined when no skill can activate (no model-
 * invocable skill has `paths`), so the file tools stay unwrapped.
 *
 * `messages` must be the current context window (already sliced at the latest
 * context boundary): pointers from before a boundary no longer reach the model.
 */
/** Model-invocable path-scoped skills, capped (disable-model-invocation wins over paths). */
function eligiblePathSkills(
  skills: readonly AgentSkillDescriptor[] | undefined
): AgentSkillDescriptor[] {
  // Like Cursor and Claude Code, a disable-model-invocation / advertise: false skill
  // loads only when explicitly invoked.
  const eligible = (skills ?? []).filter(
    (skill) => skill.paths !== undefined && skill.advertise !== false
  );
  if (eligible.length > MAX_PATH_SCOPED_SKILLS) {
    log.warn("Too many path-scoped skills; only the first ones can activate", {
      count: eligible.length,
      max: MAX_PATH_SCOPED_SKILLS,
    });
  }
  return eligible.slice(0, MAX_PATH_SCOPED_SKILLS);
}

/** A lazily compiled matcher per skill, kept only for this turn (no process-wide cache). */
function createTurnMatcher(): (skill: AgentSkillDescriptor, relativePath: string) => boolean {
  const matchers = new Map<string, (path: string) => boolean>();
  return (skill, relativePath) => {
    let matcher = matchers.get(skill.name);
    if (matcher === undefined) {
      matcher = createSkillPathsMatcher(skill.paths ?? []);
      matchers.set(skill.name, matcher);
    }
    return matcher(relativePath);
  };
}

/** Names of the skills a post-compaction `loaded_skills_snapshot` re-injects. */
export function loadedSnapshotSkillNames(
  attachments: readonly PostCompactionAttachment[] | null | undefined
): string[] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.type === "loaded_skills_snapshot" ? attachment.skills.map((skill) => skill.name) : []
  );
}

export function createPathSkillActivation(params: {
  skills: readonly AgentSkillDescriptor[] | undefined;
  messages: readonly MuxMessage[];
  /** Skills already in the request outside history (post-compaction loaded-skill snapshot). */
  loadedSkillNames?: readonly string[];
  cwd: string;
  runtime: Runtime;
}): PathSkillActivation | undefined {
  const eligible = eligiblePathSkills(params.skills);
  if (eligible.length === 0) {
    return undefined;
  }

  const surfaced = collectSurfacedSkillNames(params.messages);
  for (const name of params.loadedSkillNames ?? []) surfaced.add(name);
  const matches = createTurnMatcher();

  return {
    takeMatches(toolPath) {
      const relativePath = toWorkspaceRelativePath(toolPath, params.cwd, params.runtime);
      if (relativePath === undefined) {
        return [];
      }

      const matched = eligible
        .filter((skill) => !surfaced.has(skill.name) && matches(skill, relativePath))
        .slice(0, MAX_SKILLS_PER_TOOL_CALL);
      for (const skill of matched) {
        surfaced.add(skill.name);
      }
      return matched;
    },
    markSurfaced(skillName) {
      surfaced.add(skillName);
    },
  };
}

/** The persisted `path_skills` result field for the skills a tool call activated. */
export function formatPathSkillsResultField(
  skills: readonly AgentSkillDescriptor[]
): PathSkillsResultField {
  return {
    message:
      "These skills apply to this file. Read each one with agent_skill_read before you continue working on matching files.",
    skills: skills.map((skill) => ({
      name: skill.name,
      scope: skill.scope,
      description: formatSkillIndexDescription(skill.description),
    })),
  };
}
