import { shellQuote } from "@/common/utils/shell";
import { buildGuardedCommand, buildShellExport } from "./shellEnv";
export { shellQuote };

/** Exit code for process killed by SIGKILL (128 + 9) */
export const EXIT_CODE_SIGKILL = 137;

/** Exit code for process killed by SIGTERM (128 + 15) */
export const EXIT_CODE_SIGTERM = 143;

/** Printed by buildTerminateCommand when the process had already exited (nothing was signaled). */
export const TERMINATE_ALREADY_EXITED = "already-exited";

/**
 * Parse exit code from file content.
 * Returns null if content is empty or not a valid number.
 */
export function parseExitCode(content: string): number | null {
  const code = parseInt(content.trim(), 10);
  return isNaN(code) ? null : code;
}
/**
 * Parse PID from buildSpawnCommand output.
 * Returns the PID or null if invalid.
 */
export function parsePid(output: string): number | null {
  const pid = parseInt(output.trim(), 10);
  return isNaN(pid) || pid <= 0 ? null : pid;
}

/**
 * Shared command builders for background process management.
 * Used by both LocalRuntime and SSHRuntime for parity.
 */

/**
 * Options for building the wrapper script that runs inside bash.
 */
export interface WrapperScriptOptions {
  /** Path where exit code will be written */
  exitCodePath: string;
  /** Working directory for the script */
  cwd: string;
  /** Name of the environment variable containing the translated cwd; takes precedence over cwd. */
  cwdEnvVar?: string;
  /** Environment variables to export */
  env?: Record<string, string>;
  /** The actual script to run */
  script: string;
}

/**
 * Build the wrapper script that captures exit code and sets up environment.
 * Pattern: trap 'echo $? > exit_code' EXIT && trap 'exit 143' TERM && cd /path && export K=V || exit; script
 */
export function buildWrapperScript(options: WrapperScriptOptions): string {
  const parts: string[] = [];

  // Set up trap first to capture exit code.
  //
  // IMPORTANT: Do NOT inline shellQuote(exitCodePath) inside a double-quoted trap string.
  // If the path contains a single quote (e.g. processId derived from script contains quotes),
  // shellQuote() will emit the POSIX escape pattern '\''"'"'\'', which contains double quotes
  // and will break the surrounding double quotes.
  //
  // Instead, assign the (quoted) path to a variable and reference it from the trap.
  parts.push(`__MUX_EXIT_CODE_PATH=${shellQuote(options.exitCodePath)}`);
  parts.push(`trap 'echo $? > "$__MUX_EXIT_CODE_PATH"' EXIT`);
  // Without a TERM trap, bash killed by SIGTERM runs the EXIT trap with `$?` = 0, so a stopped
  // process would record 0. Exiting with 128+15 makes the EXIT trap record the real code, which
  // lets buildTerminateCommand publish its own code only when no file exists (never over one).
  parts.push(`trap 'exit ${EXIT_CODE_SIGTERM}' TERM`);

  // Change to working directory
  if (options.cwdEnvVar) {
    parts.push(`__MUX_CWD="$${options.cwdEnvVar}"`);
    parts.push(`unset ${options.cwdEnvVar}`);
    parts.push('cd "$__MUX_CWD"');
  } else {
    parts.push(`cd ${shellQuote(options.cwd)}`);
  }

  // Add environment variable exports
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      parts.push(buildShellExport(key, value));
    }
  }

  // A failed step skips every line of the script (#5192)
  return buildGuardedCommand(parts, options.script);
}

/**
 * Options for building the spawn command.
 */
export interface SpawnCommandOptions {
  /** The wrapper script to execute */
  wrapperScript: string;
  /** Path for unified output (stdout + stderr) redirection */
  outputPath: string;
  /** Path to bash executable (defaults to "bash") */
  bashPath?: string;
  /** Function to quote paths for shell (default: shellQuote). Use expandTildeForSSH for SSH. */
  quotePath?: (path: string) => string;
}

/**
 * Build the spawn command using subshell + nohup pattern.
 *
 * Uses subshell (...) to isolate the process group so the outer shell exits immediately.
 * set -m: enables job control so backgrounded process gets its own process group (PID === PGID)
 * nohup: ignores SIGHUP (survives terminal hangup)
 *
 * stdout and stderr are merged into a single output file with 2>&1 for unified display.
 *
 * Returns PID via echo. With set -m, PID === PGID (process is its own group leader).
 */
export function buildSpawnCommand(options: SpawnCommandOptions): string {
  const bash = options.bashPath ?? "bash";
  const quotePath = options.quotePath ?? shellQuote;

  return (
    `(set -m; nohup ${shellQuote(bash)} -c ${shellQuote(options.wrapperScript)} ` +
    `> ${quotePath(options.outputPath)} 2>&1 ` +
    `< /dev/null & echo $!)`
  );
}

/**
 * Build the terminate command for killing a process group.
 *
 * Uses negative PID to kill entire process group.
 * Relies on set -m ensuring PID === PGID (process is its own group leader).
 * Sends SIGTERM, waits 2 seconds, then SIGKILL if still running.
 * Writes EXIT_CODE_SIGKILL on force kill.
 *
 * A process that already exited is left alone: when the exit_code file holds an exit code (digits
 * on its first line), the command sends no signal, writes nothing and prints
 * TERMINATE_ALREADY_EXITED. A missing, empty or malformed file means "not known to have exited":
 * the command stops the group as before. The caller's in-memory status
 * only follows a natural exit when something polls it, so without this check a stop after an
 * unobserved exit signaled a process group whose PGID may already belong to an unrelated group,
 * and replaced the code the wrapper's EXIT trap wrote with 143 (formal/background-processes, B1).
 * The command never overwrites an exit_code file: it publishes 143/137 with noclobber (`set -C`,
 * O_EXCL), only when neither the trap (which records 143 via the wrapper's TERM trap) nor a
 * natural exit wrote one.
 *
 * Not covered: members the script left running in the background (`cmd & exit 3`) once the
 * wrapper itself exited. exit_code then says the wrapper is gone, not the group, and a live PGID
 * alone does not prove the group is still this record's. A stop after a polled exit has always
 * skipped them too; stopping them needs an identity-safe ownership check (#5481).
 *
 * Residual windows (not closed; a shell has no atomic "signal this group only if it is still
 * mine"):
 * - Check to SIGTERM: reading exit_code (`read`, `case`) and `kill -15` are builtins in the same shell, with no
 *   fork between them. A signal reaches a stranger only if, in that gap, the wrapper writes its
 *   code, every member of the group exits, and the kernel gives the same number to a new group
 *   leader (Linux keeps a number allocated while it is still any process's PGID, so this needs
 *   the whole group gone plus a PID wraparound). A natural exit in that gap keeps its code
 *   (noclobber), but the process is stopped as if it was killed.
 * - The `sleep 2` escalation window: if every member exits after SIGTERM and the PGID is reused
 *   within those 2 seconds, `kill -0` answers for the new group and `kill -9` reaches it. This
 *   predates the check. The escalation deliberately does not consult exit_code: a member that
 *   ignores SIGTERM can keep the group alive after the wrapper wrote its code.
 * - A wrapper killed without running its trap (SIGKILL from outside, the OOM killer) leaves no
 *   exit_code, and a corrupted file is not an exit code, so the check cannot see those exits and
 *   the stop signals a PGID that may have been reused. A file that is not an exit code is never
 *   replaced either (noclobber), so the process then has no known exit code.
 * - The marker is not authenticated: the script runs in the wrapper shell and can write a valid
 *   code itself, and a stop then leaves its group alone (as a stop after a polled exit always
 *   has). A script that swaps the file for a FIFO between `[ -f ]` and `read` can also stall the
 *   stop until the exec timeout. Tracked with the members case in #5481.
 *
 * @param pid - Process ID (equals PGID due to set -m in buildSpawnCommand)
 * @param exitCodePath - Path to write exit code (raw, will be quoted by quotePath)
 * @param quotePath - Function to quote path (default: shellQuote). Use expandTildeForSSH for SSH.
 */
export function buildTerminateCommand(
  pid: number,
  exitCodePath: string,
  quotePath: (p: string) => string = shellQuote
): string {
  const negPid = -pid; // Negative PID targets process group (PID === PGID due to set -m)
  const quotedExitCodePath = quotePath(exitCodePath);
  // noclobber: the trap's (or a natural exit's) code always wins over ours.
  // `[ -e ]` first: noclobber still opens an existing FIFO or device, which can block.
  const publish = (code: number) =>
    `[ -e ${quotedExitCodePath} ] || (set -C; echo ${code} > ${quotedExitCodePath}) 2>/dev/null || true`;
  // Send SIGTERM, wait for process to exit, then publish an exit code if none exists.
  // After sleep 2, either the process exited (SIGTERM code) or we escalate to SIGKILL.
  // The exit_code check and SIGTERM stay in one shell step (see the residual windows above).
  // `read` takes the first line without a fork; `case` accepts only digits (no "3garbage").
  // `[ -f ]` keeps a FIFO or device the script put there from blocking the read.
  return (
    `__mux_ec=; [ -f ${quotedExitCodePath} ] && { read -r __mux_ec < ${quotedExitCodePath}; } 2>/dev/null; ` +
    `case "$__mux_ec" in ''|*[!0-9]*) ` +
    `kill -15 ${negPid} 2>/dev/null || true; ` +
    `sleep 2; ` +
    `if kill -0 ${negPid} 2>/dev/null; then ` +
    `kill -9 ${negPid} 2>/dev/null || true; ` +
    `${publish(EXIT_CODE_SIGKILL)}; ` +
    `else ` +
    `${publish(EXIT_CODE_SIGTERM)}; ` +
    `fi;; ` +
    `*) echo ${TERMINATE_ALREADY_EXITED};; ` +
    `esac`
  );
}
