import assert from "node:assert";

import { SkillNameSchema } from "@/common/orpc/schemas/agentSkill";
import { getErrorMessage } from "@/common/utils/errors";
import {
  isSkillsCliRemoteUrl,
  SKILLS_CLI_NOT_REMOTE_PROBLEM,
  SKILLS_CLI_SAFE_ARG_PATTERN,
  skillsCliSourceProblem,
} from "@/common/utils/skillsCliSource";
import {
  assertNoAgentPluginUrlCredentials,
  parseAgentPluginSourceInput,
} from "@/node/services/agentPlugins/sourceInput";

/**
 * The "Skills CLI" install method of the Add panel: Xum builds the command of the pinned skills
 * CLI (vercel-labs/skills) for the user to run in a terminal. The CLI copies the skills into
 * ~/.agents/skills, which Xum already reads. Xum does not review, update or remove these skills.
 *
 * SECURITY: Xum does not run the CLI itself. The CLI clones the repository again and copies the
 * skill folders with symlinks followed (skills@1.7.4 installer.ts, `cp` with `dereference`), so a
 * run could copy files from outside the clone that no preview showed. Pinning the clone to the
 * previewed commit does not close that: the CLI tries `git clone --branch <ref>` first, and a
 * branch or tag named after the commit SHA wins over the commit.
 */

// Pinned: the spike verified 1.7.4 (flags, output folder, lock file). `skills@latest` would let
// a new upstream release change the command without review, so a new CLI version needs a Xum
// release.
export const SKILLS_CLI_PACKAGE = "skills@1.7.4";

/**
 * The skills CLI takes a git URL: a remote https/ssh source of the whole repository at its
 * default branch (skillsCliSourceProblem, which Settings also checks before it offers the CLI).
 */
function skillsCliSource(input: string): string {
  const problem = skillsCliSourceProblem(input);
  if (problem !== undefined) throw new Error(problem);
  const parsed = parseAgentPluginSourceInput(input);
  // The shared check refuses shorthand with `@ref` or a subpath; URL inputs never carry them.
  assert(
    parsed.ref === undefined && parsed.subpath === undefined,
    "skillsCliSource: an accepted source has no ref or subpath"
  );
  const url = parsed.url;
  // Again here: the parser checks the raw input, this checks what Xum shows.
  assertNoAgentPluginUrlCredentials(url);
  if (!isSkillsCliRemoteUrl(url)) throw new Error(SKILLS_CLI_NOT_REMOTE_PROBLEM);
  const urlProblem = skillsCliSourceProblem(url);
  if (urlProblem !== undefined) throw new Error(urlProblem);
  assert(!url.startsWith("-"), "skillsCliSource: a remote URL never starts with '-'");
  return url;
}

/**
 * The npx arguments. `--global --agent codex` writes ~/.agents/skills (the
 * plugin installer has no project scope either), and `--copy` keeps no symlink
 * into the CLI cache. `--yes` before the package keeps npx from asking to
 * download it. The CLI itself gets no `--yes`: it asks before it installs,
 * because Xum does not check what is already in ~/.agents/skills.
 */
export function skillsCliArgs(source: string, skills: string[]): string[] {
  assert(skills.length > 0, "Pick at least one skill to install.");
  for (const skill of skills) {
    // The skill-name grammar starts with [a-z0-9], so no name reads as an option.
    if (!SkillNameSchema.safeParse(skill).success) {
      throw new Error(
        `'${skill}' is not a valid skill name (lowercase letters, digits and single hyphens, up to 64 characters).`
      );
    }
  }
  return [
    "--yes",
    SKILLS_CLI_PACKAGE,
    "add",
    skillsCliSource(source),
    ...skills.flatMap((skill) => ["--skill", skill]),
    "--global",
    "--agent",
    "codex",
    "--copy",
  ];
}

/**
 * The command to show and copy. No quoting: no quoting is right for both POSIX shells and cmd.exe,
 * so skillsCliCommand refuses any argument that would need it (SKILLS_CLI_SAFE_ARG_PATTERN).
 */
function formatCommand(argv: string[]): string {
  return argv.join(" ");
}

/**
 * The command for `input`: validated source and skill names only. Throws a user-facing error for
 * invalid input.
 */
export function skillsCliCommand(input: { source: string; skills: string[] }): string {
  const args = skillsCliArgs(input.source, input.skills);
  // skillsCliSourceProblem and the skill-name grammar admit only safe characters. Check what Xum
  // shows again: an unsafe argument throws here, it is never quoted.
  assert(
    args.every((arg) => SKILLS_CLI_SAFE_ARG_PATTERN.test(arg)),
    "skillsCliCommand: every argument must be safe to show unquoted in any shell"
  );
  return formatCommand(["npx", ...args]);
}

/** The ORPC shape: invalid input becomes the error branch. */
export function skillsCliCommandResult(input: {
  source: string;
  skills: string[];
}): { success: true; data: { command: string } } | { success: false; error: string } {
  try {
    return { success: true, data: { command: skillsCliCommand(input) } };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}
