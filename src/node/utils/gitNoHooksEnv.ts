import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { providerSecretEnvVarNames } from "@/node/utils/providerRequirements";

/**
 * Environment variables that disable git hooks by pointing core.hooksPath
 * to /dev/null. Used for untrusted projects to prevent repo-controlled
 * hooks from executing during git operations.
 */
export const GIT_NO_HOOKS_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  // Clear the deprecated GIT_CONFIG_PARAMETERS to prevent it from overriding
  // the numbered GIT_CONFIG_* variables above (it takes precedence in git).
  GIT_CONFIG_PARAMETERS: "",
} as const;

/**
 * Git hooks may run only for trusted projects with project automation
 * allowed: under the benchmark kill-switch a dataset repo can plant
 * .git/hooks/post-checkout (or core.hooksPath) that would otherwise execute
 * with provider credentials during git operations (e.g. worktree add for
 * task forks), despite the rest of project automation being disabled.
 */
export function gitHooksAllowed(trusted?: boolean): boolean {
  return trusted === true && !projectAutomationDisabled();
}

/** Empty tree OID: pointing GIT_ATTR_SOURCE here makes git ignore tracked
 * .gitattributes (git >= 2.40), so repo-assigned filter/smudge drivers never
 * run during checkout. Older gits ignore the variable; the secret blanking
 * below still removes the exfiltration value as a second layer. */
const GIT_EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Environment for repo-automation-off git executions. Hooks are only one of
 * git's repo-controlled process vectors: repo config can also define checkout
 * filters (filter.<name>.smudge selected by tracked .gitattributes),
 * fsmonitor daemons, credential helpers, and core.sshCommand. This override
 * set neutralizes each of those and additionally blanks provider secret env
 * vars, so any process that still slips through inherits nothing worth
 * exfiltrating. Values are empty strings rather than deletions because exec
 * helpers merge overrides onto process.env.
 */
export function gitNoRepoAutomationEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...GIT_NO_HOOKS_ENV,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    // An empty credential.helper value resets the helper list.
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_ATTR_SOURCE: GIT_EMPTY_TREE_OID,
    // Environment beats repo-config core.sshCommand.
    GIT_SSH_COMMAND: "ssh",
  };
  for (const name of providerSecretEnvVarNames()) {
    env[name] = "";
  }
  return env;
}

/**
 * Build a shell command prefix that neutralizes repo-controlled git
 * automation for untrusted projects. Returns empty string when hooks are
 * allowed, or "GIT_CONFIG_COUNT=3 ... " assignments when they must be
 * suppressed.
 */
export function gitNoHooksPrefix(trusted?: boolean): string {
  if (gitHooksAllowed(trusted)) return "";
  return (
    Object.entries(gitNoRepoAutomationEnv())
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") + " "
  );
}
