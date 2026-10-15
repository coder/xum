import * as path from "node:path";

import type { SkillLookupName } from "@/common/types/agentSkill";
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
export interface SkillFileLocation {
  skillName: SkillLookupName;
  /** POSIX path relative to the skill directory, as agent_skill_read_file takes it. */
  filePath: string;
}

/** Skill files sit at most a few folders below SKILL.md (playbooks/, references/). */
const MAX_SKILL_ANCESTORS = 4;

/** At most this many path-like bash tokens are checked, so one overflow costs a few stats. */
const MAX_BASH_PATH_TOKENS = 8;

export function formatSkillFileHint(location: SkillFileLocation): string {
  const name = JSON.stringify(location.skillName);
  const filePath = JSON.stringify(location.filePath);
  return `${filePath} is a file of skill ${name}. Read it whole, long lines included, with agent_skill_read_file (name: ${name}, filePath: ${filePath}).`;
}

/**
 * The discovered skill that owns `filePath`, or null. A skill directory here is
 * the one agent_skill_read reports as skillDir. Never throws: the hint is
 * optional, and a failed lookup must not fail the read that asked for it.
 */
export async function findSkillFileForPath(
  config: ToolConfiguration,
  filePath: string
): Promise<SkillFileLocation | null> {
  try {
    if (!config.cwd) return null;
    const pathApi = config.runtime instanceof RemoteRuntime ? path.posix : path;
    // Lexical: `..` segments are resolved first, so `<skill>/../x` is outside.
    // Symlinks are checked by agent_skill_read_file's containment below.
    const absPath = config.runtime.normalizePath(filePath, config.cwd);
    let dir = pathApi.dirname(absPath);
    for (let depth = 0; depth < MAX_SKILL_ANCESTORS; depth++) {
      if (await isFile(config.runtime, pathApi.join(dir, "SKILL.md"))) {
        const relative = pathApi.relative(dir, absPath).split(pathApi.sep).join("/");
        return await matchDiscoveredSkill(config, pathApi.basename(dir), dir, relative);
      }
      const parent = pathApi.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  } catch (error) {
    log.debug("[findSkillFileForPath] skill lookup failed", { error, filePath });
    return null;
  }
}

/** The first discovered skill file a bash script names by path, or null. */
export async function findSkillFileInScript(
  config: ToolConfiguration,
  script: string
): Promise<SkillFileLocation | null> {
  const tokens = new Set(
    script
      .split(/[\s'"`;|&<>()]+/)
      .filter((token) => token.includes("/") && !token.startsWith("-") && !/[$*?]/.test(token))
  );
  for (const token of [...tokens].slice(0, MAX_BASH_PATH_TOKENS)) {
    const location = await findSkillFileForPath(config, token);
    if (location != null) return location;
  }
  return null;
}

async function isFile(runtime: Runtime, filePath: string): Promise<boolean> {
  try {
    return !(await runtime.stat(filePath)).isDirectory;
  } catch {
    return false;
  }
}

async function matchDiscoveredSkill(
  config: ToolConfiguration,
  directoryName: string,
  dir: string,
  relativePath: string
): Promise<SkillFileLocation | null> {
  assert(config.cwd, "matchDiscoveredSkill needs cwd");
  // A bare name resolves by precedence and can name another skill's directory.
  // A shadowed plugin skill is offered under its qualified name, so try those too.
  const names = [
    directoryName,
    ...(config.availableSkills ?? [])
      .map((skill) => skill.name)
      .filter((name) => name.endsWith(`:${directoryName}`)),
  ];
  const includeClaudeSkills = config.experiments?.claudeSkillsCompat === true;
  const skillCtx = resolveSkillStorageContext({
    runtime: config.runtime,
    workspacePath: config.cwd,
    xumScope: config.xumScope ?? null,
    includeClaudeSkills,
  });
  for (const name of new Set(names)) {
    if (parseSkillLookupName(name) == null) continue;
    try {
      const resolved = await readAgentSkill(skillCtx.runtime, skillCtx.workspacePath, name, {
        roots: skillCtx.roots,
        containment: skillCtx.containment,
        includeClaudeSkills,
      });
      const skillDir = resolveSkillDirectory(resolved, config.runtime);
      if (!skillDir.available || skillDir.skillDir !== toPosixPath(dir)) continue;
      assert(resolved.sourceRuntime != null, "on-disk skills have a source runtime");
      // Throws when the path leaves the skill directory through a symlink.
      await resolveSkillFileTarget(
        resolved,
        resolved.sourceRuntime,
        skillCtx.containment,
        relativePath
      );
      return { skillName: name, filePath: relativePath };
    } catch {
      // Not this skill: try the next name.
    }
  }
  return null;
}
