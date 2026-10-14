import assert from "@/common/utils/assert";
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
 * Joins a runtime's setup steps (`cd`, exports) with the caller's command so that a failed step
 * runs none of the command (#5192). `&&` binds only the first line of a multi-line command, so
 * `cd <cwd> && <command>` would still run the later lines in the shell's starting directory
 * without the exported env. `|| exit` ends the shell before any caller line runs, with the failed
 * step's exit code.
 * - Not a `{ <command>\n}` group: caller text can close a group early (a stray `}`) or absorb
 *   the newline before `}` (a trailing backslash).
 * - The command stays on the first line and is parsed line by line as before, so line numbers in
 *   bash error messages and heredoc/syntax-error handling do not change.
 */
export function buildGuardedCommand(setup: readonly string[], command: string): string {
  assert(setup.length > 0, "buildGuardedCommand needs at least one setup step");
  return `${setup.join(" && ")} || exit; ${command}`;
}
