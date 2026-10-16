import { shellQuote } from "@/common/utils/shell";

const ENROLLMENT_WARNING = "xum: could not apply the agent resource limit to this command";

let enrollmentTarget: string | null = null;

/**
 * Set by AgentResourceLimitsService: the `cgroup.procs` file of the agent cgroup, or null when
 * no limit applies.
 */
export function setAgentCgroupEnrollmentTarget(procsFile: string | null): void {
  enrollmentTarget = procsFile;
}

/**
 * The first line of an agent shell script: it moves the shell into the agent cgroup before its
 * first command, so every process the shell starts shares the limit. It prints nothing on stdout,
 * which background spawns read for the PID, and a failed move only prints a warning on stderr.
 * Empty when no limit applies.
 */
export function agentCgroupEnrollmentLine(procsFile: string | null = enrollmentTarget): string {
  if (procsFile === null) {
    return "";
  }
  return `{ echo $$ > ${shellQuote(procsFile)}; } 2>/dev/null || echo ${shellQuote(ENROLLMENT_WARNING)} >&2\n`;
}
