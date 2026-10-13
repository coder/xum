import assert from "@/common/utils/assert";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime";
import type { Runtime } from "@/node/runtime/Runtime";

import type { ResolvedAgentSkill } from "./agentSkillsService";
import { isSkillDynamicDirectiveLine } from "./skillDynamicContext";

/**
 * Where a skill's bundled files live, as seen by `bash` in the workspace.
 *
 * Skills that ship scripts must find themselves without hard-coding an install
 * path (project, global, universal and plugin installs all differ). The path is
 * only reported when it is valid where bash runs; otherwise `reason` tells the
 * model why there is none, so it falls back to agent_skill_read_file.
 */
export type SkillDirectory =
  | { available: true; skillDir: string; pluginRoot?: string }
  | { available: false; reason: string };

const BUILT_IN_REASON =
  "Built-in skills are bundled in the Xum app and have no directory on disk. Read their files with agent_skill_read_file.";
const OFF_HOST_REASON =
  "This skill's files are on the Xum host, but bash in this workspace runs on another machine or in a container, where that path is not valid. Read its files with agent_skill_read_file.";

const OTHER_CHECKOUT_REASON =
  "This skill was read from the project's main checkout, not from this workspace's checkout. Call agent_skill_read for its directory in this workspace.";

/**
 * True when commands run directly on the Xum host. Positive check on purpose:
 * SSH/Docker (RemoteRuntime), devcontainers (exec inside the container) and
 * multi-project wrappers (which can wrap SSH runtimes) all fail it, so a host
 * path is never reported for a runtime Xum cannot prove shares the host
 * filesystem.
 */
function execsOnHost(runtime: Runtime): boolean {
  return runtime instanceof LocalBaseRuntime && !(runtime instanceof DevcontainerRuntime);
}

/**
 * Resolve the skill directory that `bash` on `workspaceRuntime` can use.
 *
 * - Built-in skills: none (embedded in the app bundle).
 * - Read through the workspace runtime itself (local, worktree, SSH/Docker
 *   project skills, Docker globals): the path is valid where bash runs.
 * - Read on the host while bash runs elsewhere (host-fallback global skills on
 *   SSH, every devcontainer read): none. A devcontainer sees the
 *   checkout under a different path, so a host path would mislead the model.
 *   Plugin discovery is host-only, so remote runtimes never see plugin skills;
 *   in local/worktree workspaces plugin skills pass the host check.
 */
export function resolveSkillDirectory(
  resolved: ResolvedAgentSkill,
  workspaceRuntime: Runtime,
  options?: {
    /**
     * The skill was discovered from a checkout other than the workspace's (a new
     * worktree's first message resolves project skills from the main project
     * path). Its project path names the other checkout's copy, so it is withheld.
     */
    discoveredOutsideWorkspace?: boolean;
  }
): SkillDirectory {
  const reason = getSkillDirectoryUnavailableReason(
    resolved,
    workspaceRuntime,
    options?.discoveredOutsideWorkspace === true
  );
  if (reason != null) return { available: false, reason };

  assert(resolved.skillDir.length > 0, "on-disk skills must have a skill directory");
  return {
    available: true,
    skillDir: resolved.skillDir,
    ...(resolved.pluginRoot != null ? { pluginRoot: resolved.pluginRoot } : {}),
  };
}

/** Why bash on `workspaceRuntime` cannot use the skill's path, or null when it can. */
function getSkillDirectoryUnavailableReason(
  resolved: ResolvedAgentSkill,
  workspaceRuntime: Runtime,
  discoveredOutsideWorkspace: boolean
): string | null {
  if (resolved.sourceRuntime == null) {
    assert(
      resolved.package.scope === "built-in",
      "only built-in skills resolve without a source runtime"
    );
    return BUILT_IN_REASON;
  }
  if (discoveredOutsideWorkspace && resolved.package.scope === "project") {
    return OTHER_CHECKOUT_REASON;
  }
  const sameRuntime = resolved.sourceRuntime === workspaceRuntime;
  const bothOnHost = execsOnHost(resolved.sourceRuntime) && execsOnHost(workspaceRuntime);
  return sameRuntime || bothOnHost ? null : OFF_HOST_REASON;
}

/**
 * Claude Code-compatible placeholders. Matching its names lets skills written
 * for Claude Code run their bundled scripts unchanged. `${PLUGIN_ROOT}` is
 * deliberately NOT expanded: the Agent Plugins spec defines it only for MCP
 * server config, and skills that document that config contain it literally.
 */
const SKILL_DIRECTORY_PLACEHOLDER_RE = /\$\{(CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}/g;

/**
 * Replace `${CLAUDE_SKILL_DIR}` and, for plugin skills, `${CLAUDE_PLUGIN_ROOT}`
 * in a skill body. Single pass, so replacement text is never rescanned.
 * Placeholders without a value (no directory, or not a plugin skill) stay
 * literal, as in Claude Code.
 */
export function substituteSkillDirectoryPlaceholders(body: string, dir: SkillDirectory): string {
  assert(typeof body === "string", "substituteSkillDirectoryPlaceholders requires a string body");
  if (!dir.available) return body;

  // A replacer function (not a string) keeps `$&`-like text in paths literal.
  return body.replace(SKILL_DIRECTORY_PLACEHOLDER_RE, (match, name: string) => {
    if (name === "CLAUDE_SKILL_DIR") return dir.skillDir;
    return dir.pluginRoot ?? match;
  });
}

/**
 * Substitute the placeholders everywhere except whole-line !`command`
 * directives. A directive is shell code: a spliced path containing `$()`,
 * backticks or quotes would be reparsed as shell syntax. Directives get the
 * values as environment variables instead (see skillDirectoryEnv), so the
 * shell expands `"${CLAUDE_SKILL_DIR}"` itself and the path stays one word.
 */
export function substituteSkillDirectoryPlaceholdersOutsideDirectives(
  body: string,
  dir: SkillDirectory
): string {
  return body
    .split("\n")
    .map((line) =>
      isSkillDynamicDirectiveLine(line) ? line : substituteSkillDirectoryPlaceholders(line, dir)
    )
    .join("\n");
}

/** Environment for directive commands: the placeholder names with their values. */
export function skillDirectoryEnv(dir: SkillDirectory): Record<string, string> {
  if (!dir.available) return {};
  return {
    CLAUDE_SKILL_DIR: dir.skillDir,
    ...(dir.pluginRoot != null ? { CLAUDE_PLUGIN_ROOT: dir.pluginRoot } : {}),
  };
}

/** `$NAME` and `${NAME}` references to the skill-directory variables in shell code. */
const SKILL_DIRECTORY_SHELL_REF_RE = /\$\{?(CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\b/g;

/**
 * Throw when `command` refers to a skill-directory variable that `env` does not
 * set. The shell would expand it to an empty string, so a directive such as
 * `sh "${CLAUDE_SKILL_DIR}/x.sh"` would run `/x.sh` from the filesystem root.
 * Directive runners call this before executing a command.
 */
export function assertSkillDirectoryPlaceholdersResolved(
  command: string,
  env: Record<string, string>
): void {
  assert(typeof command === "string", "assertSkillDirectoryPlaceholdersResolved requires a string");
  const unresolved = [...command.matchAll(SKILL_DIRECTORY_SHELL_REF_RE)].find(
    (match) => env[match[1]] == null
  );
  if (unresolved != null) {
    // Only CLAUDE_SKILL_DIR can be recovered via agent_skill_read; a plugin root
    // exists for plugin skills only.
    const hint =
      unresolved[1] === "CLAUDE_SKILL_DIR"
        ? " (call agent_skill_read for the skill directory)"
        : " (only plugin skills have a plugin root)";
    throw new Error(`not run: ${unresolved[1]} has no value in this workspace${hint}`);
  }
}
