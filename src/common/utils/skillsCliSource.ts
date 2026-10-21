/**
 * Which Add-panel sources the "Skills CLI" install method takes. The backend refuses the others
 * (skillsCli.ts) and Settings → Plugins does not offer the choice for them, so both share this.
 */

/**
 * SCP-style ssh (`git@github.com:owner/repo.git`). The user part and the host must not start
 * with `-`, so the CLI and git cannot read an option.
 */
const SCP_REMOTE_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:/;

export const SKILLS_CLI_REF_OR_SUBPATH_PROBLEM =
  "The Skills CLI method installs from the default branch of the whole repository. Remove the @ref or the subpath.";
export const SKILLS_CLI_NOT_REMOTE_PROBLEM =
  "The Skills CLI method needs an https:// or ssh:// repository URL or owner/repo shorthand.";

/**
 * Only remote https/ssh sources: a local path or file:// URL would install from this machine,
 * which the plugin flow handles itself.
 */
export function isSkillsCliRemoteUrl(url: string): boolean {
  if (url.startsWith("https://")) return true;
  // ssh://[user@]host: neither part may start with "-" (ssh would read `-oProxyCommand=…`).
  if (url.startsWith("ssh://")) return /^ssh:\/\/(?:[A-Za-z0-9._][^@/]*@)?[A-Za-z0-9[]/.test(url);
  return SCP_REMOTE_PATTERN.test(url);
}

/**
 * Why the Skills CLI cannot install `input` (the Add panel source as typed), or undefined when
 * it can. The CLI installs the default branch of the whole repository, so shorthand takes no
 * `@ref` and no subpath (dropping them would install other skills than the user picked).
 */
export function skillsCliSourceProblem(input: string): string | undefined {
  const source = input.trim();
  if (isSkillsCliRemoteUrl(source)) return undefined;
  // Shorthand has no ':' or '\' and does not start like a local path.
  if (/[:\\]/.test(source) || /^[/~.]/.test(source)) return SKILLS_CLI_NOT_REMOTE_PROBLEM;
  const segments = source.replace(/\/$/, "").split("/");
  if (source.includes("@") || segments.length > 2) return SKILLS_CLI_REF_OR_SUBPATH_PROBLEM;
  return undefined;
}
