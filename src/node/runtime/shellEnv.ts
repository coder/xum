import { shellQuote } from "@/common/utils/shell";

const SHELL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertShellEnvName(key: string): void {
  if (!SHELL_ENV_NAME_PATTERN.test(key)) {
    throw new Error(`Invalid shell environment variable name: ${key}`);
  }
}

export function buildShellExport(
  key: string,
  value: string,
  quoteValue: (value: string) => string = shellQuote
): string {
  assertShellEnvName(key);
  return `export ${key}=${quoteValue(value)}`;
}

export function buildShellPathExport(
  key: string,
  value: string,
  quoteValue: (value: string) => string = shellQuote
): string {
  assertShellEnvName(key);
  // Windows drive-letter ([A-Za-z]:*) and UNC ('\\'*) paths are absolute too:
  // Git Bash accepts them natively, and prepending $PWD would corrupt them.
  return [
    `${key}=${quoteValue(value)}`,
    `case "$${key}" in '~') ${key}="$HOME" ;; '~/'*) ${key}="$HOME/\${${key}:2}" ;; /* | [A-Za-z]:* | '\\\\'*) ;; *) ${key}="$PWD/$${key}" ;; esac`,
    `export ${key}`,
  ].join(" && ");
}

/**
 * Groups a caller's command so all of it depends on the `cd … && export …` chain before it.
 * `&&` binds only the first line of a multi-line command; without the group, a missing cwd
 * skips line 1 and the later lines run in the shell's starting directory without the exported
 * env (#5192). With it, a failed `cd` or export fails the whole command.
 * - The newline before `}` keeps a trailing comment or a heredoc terminator from absorbing it.
 * - The command starts on the `{` line, so bash line numbers in error messages do not shift.
 */
export function groupShellCommand(command: string): string {
  return `{ ${command}\n}`;
}
