import { projectAutomationDisabled } from "@/node/utils/projectAutomation";

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

/**
 * Build a shell command prefix that disables git hooks for untrusted projects.
 * Returns empty string when hooks are allowed, or "GIT_CONFIG_COUNT=1 ... "
 * when they must be neutralized.
 */
export function gitNoHooksPrefix(trusted?: boolean): string {
  if (gitHooksAllowed(trusted)) return "";
  return (
    Object.entries(GIT_NO_HOOKS_ENV)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") + " "
  );
}
