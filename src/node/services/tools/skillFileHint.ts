import * as path from "node:path";

import type { InvocableSkill, SkillLookupName } from "@/common/types/agentSkill";
import assert from "@/common/utils/assert";
import { parseSkillLookupName } from "@/common/utils/agentSkills/skillLookupName";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillDirectory } from "@/node/services/agentSkills/skillDirectory";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { log } from "@/node/services/log";
import { toPosixPath } from "@/node/utils/paths";
import { resolveSkillFileTarget } from "./agent_skill_read_file";

/**
 * Agents often get a skill file as a raw path (pstack's router puts its own
 * SKILL.md path in every delegate prompt) and read it with file_read or bash.
 * Both cut long lines, and skill markdown often keeps a paragraph on one line,
 * so the agent silently worked from a partial skill. Only agent_skill_read_file
 * returns long lines whole. When a cut hits a file of a discovered skill, the
 * cutting tool names that call instead of changing what it returns, so reads of
 * plain repo files stay exactly as before.
 */
interface SkillFileLocation {
  skillName: SkillLookupName;
  /** POSIX path relative to the skill directory, as agent_skill_read_file takes it. */
  filePath: string;
}

/** Skill files sit at most a few folders below SKILL.md (playbooks/, references/). */
const MAX_SKILL_ANCESTORS = 4;

/**
 * Bash checks at most this many operands, and only those with a `skills`
 * folder segment (every default skill root has one). On SSH each stat is a
 * remote command, so an overflow of a plain script must cost none.
 */
const MAX_BASH_PATH_TOKENS = 3;
const SKILLS_SEGMENT_RE = /(^|\/)skills\//;
const SHELL_WORD_RE = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"`;|&<>()\\])+/g;
/** A quoted fragment or a backslash escape; plain characters do not match. */
const SHELL_FRAGMENT_RE = /'([^']*)'|"((?:\\.|[^"\\])*)"|\\./g;

function formatSkillFileHint(location: SkillFileLocation): string {
  const name = JSON.stringify(location.skillName);
  const filePath = JSON.stringify(location.filePath);
  // No page-cap number here: agent_skill_read_file states its own limits when
  // a page is too big, and a copied number goes stale (#6738).
  return `${filePath} is a file of skill ${name}. agent_skill_read_file (name: ${name}, filePath: ${filePath}) returns its lines whole.`;
}

/**
 * The hint for a file_read result, as fields to spread into it. Only a read
 * that cut a line pays for the skill lookup, so plain reads do no extra I/O.
 */
export async function skillFileReadNote(
  config: ToolConfiguration,
  filePath: string,
  cutLongLine: boolean
): Promise<{ note?: string }> {
  const location = cutLongLine ? await findSkillFileForPath(config, filePath) : null;
  return location == null ? {} : { note: formatSkillFileHint(location) };
}

/**
 * The hint paragraph for a bash overflow note ("" when the script names no
 * skill file). Filtering the overflow file would drop the cut lines too.
 */
export async function skillFileBashHint(
  config: ToolConfiguration,
  script: string
): Promise<string> {
  // Shell words: adjacent quoted, escaped and plain fragments form one word
  // ('/a b'/SKILL.md), so a path with spaces stays whole.
  // Quoted `$`, `*` and `?` are literal path characters, so those words stay
  // (#6738). The shell expands an unquoted one (and `$` in double quotes), so
  // such a word is not the path bash read, and naming it would point
  // agent_skill_read_file at a file that does not exist.
  const words = (script.match(SHELL_WORD_RE) ?? []).filter((word) => !expandsInShell(word));
  const operands = words.map((word) =>
    word.replace(
      SHELL_FRAGMENT_RE,
      (fragment: string, single?: string, double?: string) =>
        single ?? double?.replace(/\\(.)/g, "$1") ?? fragment.slice(1)
    )
  );
  const tokens = new Set(operands.filter((token) => SKILLS_SEGMENT_RE.test(token)));
  for (const token of [...tokens].slice(0, MAX_BASH_PATH_TOKENS)) {
    const location = await findSkillFileForPath(config, token);
    if (location != null) return `${formatSkillFileHint(location)}\n\n`;
  }
  return "";
}

/** True when the shell would expand a `$`, `*` or `?` in this word. */
function expandsInShell(word: string): boolean {
  // Drop what the shell keeps literal: single-quoted text, backslash escapes,
  // and everything but unescaped `$` inside double quotes.
  const expandable = word.replace(
    SHELL_FRAGMENT_RE,
    (_fragment: string, single?: string, double?: string) =>
      single !== undefined ? "" : (double?.replace(/\\./g, "").replace(/[^$]/g, "") ?? "")
  );
  return /[$*?]/.test(expandable);
}

/**
 * The discovered skill that owns `filePath`, or null. A skill directory here is
 * the one agent_skill_read reports as skillDir. Lookup failures mean "no
 * skill": the hint is optional and must not fail the read that asked for it.
 */
async function findSkillFileForPath(
  config: ToolConfiguration,
  filePath: string
): Promise<SkillFileLocation | null> {
  if (!config.cwd) return null;
  const pathApi = config.runtime instanceof RemoteRuntime ? path.posix : path;
  // Lexical: `..` segments are resolved first, so `<skill>/../x` is outside.
  // Symlinks are checked by agent_skill_read_file's containment in skillOwnsFile.
  // pathApi.normalize: remote normalizePath keeps `..` segments.
  const absPath = pathApi.normalize(config.runtime.normalizePath(filePath, config.cwd));
  let dir = pathApi.dirname(absPath);
  for (let depth = 0; depth < MAX_SKILL_ANCESTORS; depth++) {
    if (await isFile(config.runtime, pathApi.join(dir, "SKILL.md"))) {
      const relativePath = pathApi.relative(dir, absPath).split(pathApi.sep).join("/");
      for (const name of candidateSkillNames(pathApi.basename(dir), config.availableSkills)) {
        if (await skillOwnsFile(config, name, dir, relativePath)) {
          return { skillName: name, filePath: relativePath };
        }
      }
      // An undiscovered SKILL.md (a template a skill bundles) does not end the
      // search: the enclosing skill can still own the file.
    }
    const parent = pathApi.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * A bare name resolves by precedence and can name another skill's directory.
 * A shadowed plugin skill is offered under its qualified name, so try those too.
 */
function candidateSkillNames(
  directoryName: string,
  availableSkills: readonly InvocableSkill[] | undefined
): SkillLookupName[] {
  const qualified = (availableSkills ?? [])
    .map((skill) => skill.name)
    .filter((name) => name.endsWith(`:${directoryName}`));
  return [...new Set([directoryName, ...qualified])].filter(
    (name) => parseSkillLookupName(name) != null
  );
}

async function isFile(runtime: Runtime, filePath: string): Promise<boolean> {
  try {
    return !(await runtime.stat(filePath)).isDirectory;
  } catch {
    return false;
  }
}

/** True when skill `name` is discovered at `dir` and reads `relativePath` inside it. */
async function skillOwnsFile(
  config: ToolConfiguration,
  name: SkillLookupName,
  dir: string,
  relativePath: string
): Promise<boolean> {
  assert(config.cwd, "skillOwnsFile needs cwd");
  const includeClaudeSkills = config.experiments?.claudeSkillsCompat === true;
  const skillCtx = resolveSkillStorageContext({
    runtime: config.runtime,
    workspacePath: config.cwd,
    xumScope: config.xumScope ?? null,
    includeClaudeSkills,
  });
  let resolved;
  try {
    resolved = await readAgentSkill(skillCtx.runtime, skillCtx.workspacePath, name, {
      roots: skillCtx.roots,
      containment: skillCtx.containment,
      includeClaudeSkills,
    });
  } catch (error) {
    log.debug("[skillFileHint] skill lookup failed", { name, error });
    return false;
  }
  const skillDir = resolveSkillDirectory(resolved, config.runtime);
  if (!skillDir.available || skillDir.skillDir !== toPosixPath(dir)) return false;
  assert(resolved.sourceRuntime != null, "on-disk skills have a source runtime");
  // agent_skill_read_file's own containment: fails when the path leaves the
  // skill directory, also through a symlink.
  return resolveSkillFileTarget(
    resolved,
    resolved.sourceRuntime,
    skillCtx.containment,
    relativePath
  ).then(
    () => true,
    () => false
  );
}
