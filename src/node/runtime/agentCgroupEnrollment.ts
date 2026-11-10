import { shellQuote } from "@/common/utils/shell";

const ENROLLMENT_WARNING = "xum: could not apply the agent resource limit to this command";

/** Where new agent shells go while an agent resource limit applies. */
export interface AgentCgroupEnrollmentTargets {
  /** The `cgroup.procs` file for the commands of a project without a limit of its own. */
  fallback: string;
  /** The `cgroup.procs` file of each project with a limit of its own, keyed by its config path. */
  byProject: ReadonlyMap<string, string>;
}

let enrollmentTargets: AgentCgroupEnrollmentTargets | null = null;

/** Set by AgentResourceLimitsService: null when no limit applies. */
export function setAgentCgroupEnrollmentTargets(
  targets: AgentCgroupEnrollmentTargets | null
): void {
  enrollmentTargets = targets;
}

/**
 * The first line of an agent shell script for a command of the project at `projectPath`: the
 * command joins the cgroup of that project, or the shared one when the project has no limit of its
 * own or is unknown, for example a command that a skill loader runs in a worktree path. Empty when
 * no limit applies.
 */
export function agentCgroupEnrollmentLineForProject(projectPath: string | undefined): string {
  if (enrollmentTargets === null) {
    return "";
  }
  const projectTarget =
    projectPath === undefined ? undefined : enrollmentTargets.byProject.get(projectPath);
  return agentCgroupEnrollmentLine(projectTarget ?? enrollmentTargets.fallback);
}

/**
 * The first line of an agent shell script: it moves the shell into the cgroup of `procsFile`
 * before its first command, so every process the shell starts shares the limit. It prints nothing
 * on stdout, which background spawns read for the PID, and a failed move only prints a warning on
 * stderr.
 */
export function agentCgroupEnrollmentLine(procsFile: string): string {
  return `{ echo $$ > ${shellQuote(procsFile)}; } 2>/dev/null || echo ${shellQuote(ENROLLMENT_WARNING)} >&2\n`;
}
