import { shellQuote } from "@/common/utils/shell";
import { buildGuardedCommand, buildShellExport } from "./shellEnv";
export { shellQuote };

/** Exit code for process killed by SIGKILL (128 + 9) */
export const EXIT_CODE_SIGKILL = 137;

/** Exit code for process killed by SIGTERM (128 + 15) */
export const EXIT_CODE_SIGTERM = 143;

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
 * Build the wrapper script: cd, exports, then the user's script.
 * Pattern: cd /path && export K=V || exit; script
 *
 * The wrapper records nothing itself. The supervisor (buildSpawnCommand) runs it, takes its exit
 * status from `wait`, and writes the exit_code file once the whole process group has ended.
 */
export function buildWrapperScript(options: WrapperScriptOptions): string {
  const parts: string[] = [];

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
 * Shell function `__xum_glive <pgid> [<exclude pid>]`: succeeds when a live (non-zombie) process
 * other than <exclude pid> is in process group <pgid>.
 *
 * "Live" excludes zombies on purpose: a container whose PID 1 never reaps (Docker's
 * `sleep infinity`) keeps dead group members as zombies forever, and `kill -0 -<pgid>` succeeds on
 * such a group. A group of zombies cannot be signalled into doing anything and its number stays
 * allocated, so treating it as ended is safe. Linux and busybox read /proc; others (macOS) use
 * `ps`.
 *
 * Outside callers (Stop, probes, gates; no exclude PID) fail closed: only ESRCH from
 * `kill -0 -<pgid>` proves the group gone at once, a /proc entry that exists but cannot be read
 * counts as live, and when /proc hides other users' processes (`hidepid`, `subset=pid`) a member
 * that changed UID would be invisible, so only that kill answer counts. Without /proc and `ps`,
 * the function reports live: callers then wait or refuse, never settle.
 *
 * With an exclude PID (the supervisor scanning its own group), a candidate must still exist after
 * the scan, so the scan's own short-lived helpers (the `ps` command substitution) do not count.
 * The supervisor's scan only decides when it writes exit_code; readers check the group again.
 */
export const GROUP_LIVE_FUNCTION = [
  "__xum_glive() {",
  "  __g=$1; __x=${2-}; __s=$__x",
  // Windows' Git Bash (MSYS/Cygwin) keeps the plain /proc scan: the fail-closed rules below
  // were never run against its kill messages and /proc (Windows is unresolved, #5520). __s is
  // empty only for outside callers on other platforms.
  "  case ${OSTYPE-} in msys*|cygwin*) __s=w ;; esac",
  '  if [ -z "$__s" ]; then',
  '    __e=$(LC_ALL=C kill -0 -"$__g" 2>&1) || case $__e in *"No such process"*) return 1 ;; esac',
  "  fi",
  "  if [ -r /proc/self/stat ]; then",
  '    if [ -z "$__s" ]; then',
  // No mount table: whether /proc hides processes is unknown.
  "      [ -r /proc/self/mountinfo ] || return 0",
  "      while read -r __m; do",
  "        case $__m in",
  // Any hidepid mode other than 0/off hides some processes (1, 2, 4, noaccess, invisible,
  // ptraceable, and modes added later).
  '          *" /proc "*" - proc "*hidepid=0,*|*" /proc "*" - proc "*hidepid=off,*) ;;',
  '          *" /proc "*" - proc "*hidepid=0|*" /proc "*" - proc "*hidepid=off) ;;',
  '          *" /proc "*" - proc "*hidepid=*|*" /proc "*" - proc "*subset=pid*) return 0 ;;',
  "        esac",
  "      done < /proc/self/mountinfo",
  "    fi 2>/dev/null",
  "    for __f in /proc/[0-9]*/stat; do",
  // The whole record: comm may contain newlines (PR_SET_NAME), and `read` stops at the first.
  '      __l=; { read -r -d "" __l < "$__f"; } 2>/dev/null',
  "      case $__l in",
  "        *') '*) ;;",
  // Gone since the glob: skip. Present but unreadable or incomplete: inconclusive, so live
  // for outside callers.
  '        *) [ -z "$__s" ] && [ -e "${__f%/stat}" ] && return 0',
  "          continue ;;",
  "      esac",
  // Field 2 (comm) may contain spaces and ") ": strip through its LAST ") ".
  "      __l=${__l##*') '}",
  "      set -- $__l",
  '      [ "$3" = "$__g" ] || continue',
  "      case $1 in Z|X|x) continue ;; esac",
  "      __p=${__f#/proc/}; __p=${__p%/stat}",
  '      [ "$__p" = "$__x" ] && continue',
  '      [ -z "$__x" ] || [ -e "/proc/$__p" ] || continue',
  "      return 0",
  "    done",
  "    return 1",
  "  fi",
  "  __o=$(ps -A -o pid= -o pgid= -o stat= 2>/dev/null) || return 0",
  "  set -- $__o",
  '  [ "$#" -ge 3 ] || return 0',
  '  while [ "$#" -ge 3 ]; do',
  '    if [ "$2" = "$__g" ] && [ "$1" != "$__x" ]; then',
  '      case $3 in Z*) ;; *) { [ -z "$__x" ] || kill -0 "$1" 2>/dev/null; } && return 0 ;; esac',
  "    fi",
  "    shift 3",
  "  done",
  "  return 1",
  "}",
].join("\n");

/**
 * Call of GROUP_LIVE_FUNCTION (define it first in the same script): exit status 0 while process
 * group `pgid` still has a live member. For remote probes and gates that run through runtime.exec.
 */
export function groupLiveCall(pgid: number): string {
  assertPgid(pgid);
  return `__xum_glive ${pgid}`;
}

function assertPgid(pgid: number): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    throw new Error(`Invalid background process group id: ${pgid}`);
  }
}

/**
 * The supervisor S (formal/background-processes/BgTerminateGroup.tla, MC_group_supervisor).
 * Arguments: $1 record directory, $2 stop token, $3 wrapper script.
 *
 * S leads the background command's process group, and it is the only process that ever signals
 * that group: it sends `kill -TERM 0` and `kill -KILL 0` from inside the group. A signal sent to
 * one's own group cannot reach another group that later reuses the number, so Xum never signals
 * a reused process group (B1 NoSignalToReusedPgid). Nothing outside the group signals it: Stop
 * (buildStopCommand) only files a request and watches the group end.
 *
 * - S catches TERM with a no-op handler instead of ignoring it: an ignored TERM is inherited
 *   across exec, a caught one resets to the default, so the command still dies on TERM.
 * - The notifier subshell runs the wrapper, then writes one line to the control FIFO so S wakes
 *   at once. S sleeps by reading that FIFO with a 1 s timeout (it holds it open read-write, so
 *   the open never blocks). Without a FIFO, S sleeps 1 s per round.
 * - S takes the wrapper's status only once the notifier has ended, so a signal that interrupts
 *   `wait` never becomes the recorded exit code.
 * - S writes `exit_code` (the wrapper's status) only when no other live member is left. Members
 *   that outlive the wrapper keep the record "running": the command is not over until its whole
 *   group is. Readers additionally require the group to be gone, so a forged exit_code settles
 *   nothing (BackgroundProcessExecutor probes, BackgroundProcessManager gates).
 * - On a stop request (directory `stop.<token>`), S sends TERM to the group, waits up to 2 s
 *   for the members to end, writes the wrapper's status (137 when TERM did not end the
 *   wrapper), then sends KILL to the group, itself included.
 *
 * S writes nothing to stdout/stderr: both belong to the command's output.log.
 * Residual: a process that kills S leaves the group without a supervisor. Stop then reports
 * "unconfirmed" and the members keep running (never a signal from outside).
 *
 * The spawn writes this script to SUPERVISOR_FILENAME in the record directory instead of passing
 * it on the command line: Windows' Git Bash (MSYS) re-parses command lines that Node quoted, and
 * mangled the quoting of the inline script. S sources the file, which reads it whole before the
 * command starts, so later edits to the file do not change a running S.
 */
export const SUPERVISOR_FILENAME = "supervisor.sh";
export const SUPERVISOR_SCRIPT = [
  GROUP_LIVE_FUNCTION,
  // Reset options a BASH_ENV file or an exported SHELLOPTS may have set: with errexit, the
  // first `read -t` timeout would end S while the command keeps running.
  "D=$1; T=$2; W=$3; set +euxv +o pipefail -C",
  "trap ':' TERM",
  "fifo=0",
  '{ rm -f "$D/ctl" && mkfifo "$D/ctl" && [ -p "$D/ctl" ] && exec 3<>"$D/ctl" && fifo=1; } 2>/dev/null',
  `{ trap ':' TERM; "$BASH" -c "$W" 3>&-; rc=$?; [ "$fifo" = 1 ] && { echo "x $rc" >&3; } 2>/dev/null; exit "$rc"; } &`,
  "w=$!; nrc=; reaped=0; rc=",
  // Publish atomically: a fresh temp file (noclobber create after rm, so a planted FIFO is
  // never opened), then rename over the record.
  'pub() { __t="$D/.$1.$$"; { rm -f "$__t" && printf \'%s\\n\' "$2" > "$__t" && mv -f "$__t" "$D/$1"; } 2>/dev/null; }',
  // One sleep round: wakes early on a FIFO line ("x <status>" = the wrapper ended with that
  // status, and the notifier is about to exit).
  "nap() {",
  '  if [ "$fifo" = 1 ]; then',
  "    __m=; read -r -t 1 __m <&3 2>/dev/null",
  '    case $__m in "x "*) nrc=${__m#x }; case $nrc in ""|*[!0-9]*) nrc= ;; esac ;; esac',
  "  else sleep 1; fi",
  "}",
  // The status comes from the notifier's FIFO line; `wait` then only reaps it (bash's job
  // table, so no PID reuse). Without that line (no FIFO, or a read cut short by a signal), S
  // calls `wait` only once the notifier is gone: bash has then stored its status, so `wait`
  // returns it at once and no trapped signal can interrupt it into a fake 128+n status.
  "reap() {",
  '  [ "$reaped" = 1 ] && return 0',
  '  if [ -n "$nrc" ]; then rc=$nrc; reaped=1; wait "$w" 2>/dev/null; return 0; fi',
  '  kill -0 "$w" 2>/dev/null && return 1',
  '  wait "$w"; rc=$?; reaped=1',
  "}",
  "stop() {",
  "  kill -TERM 0 2>/dev/null",
  "  __i=0",
  '  while [ "$__i" -lt 2 ] && __xum_glive $$ $$; do nap; __i=$((__i + 1)); done',
  "  reap",
  `  [ "$reaped" = 1 ] || rc=${EXIT_CODE_SIGKILL}`,
  '  pub exit_code "$rc"',
  "  kill -KILL 0",
  "}",
  "n=0",
  "while :; do",
  "  nap",
  '  [ -d "$D/stop.$T" ] && stop',
  "  reap || continue",
  // Lingering members: check every round for 10 s, then every 5 s.
  '  n=$((n + 1)); [ "$n" -gt 10 ] && [ $((n % 5)) != 0 ] && continue',
  "  __xum_glive $$ $$ && continue",
  '  pub exit_code "$rc"',
  "  exit 0",
  "done",
].join("\n");

/**
 * Options for building the spawn command.
 */
export interface SpawnCommandOptions {
  /** The wrapper script to execute */
  wrapperScript: string;
  /** Path for unified output (stdout + stderr) redirection */
  outputPath: string;
  /** The process's record directory (exit_code, control FIFO, stop requests) */
  recordDir: string;
  /** SUPERVISOR_SCRIPT written to SUPERVISOR_FILENAME in the record directory */
  supervisorPath: string;
  /** Per-spawn token: the supervisor honors only `stop.<token>` requests (no stale request from an earlier process in a reused directory) */
  stopToken: string;
  /** Path to bash executable (defaults to "bash") */
  bashPath?: string;
  /** Function to quote paths for shell (default: shellQuote). Use expandTildeForSSH for SSH. */
  quotePath?: (path: string) => string;
}

/** Stop tokens are generated hex: they become part of a path the supervisor tests. */
function assertStopToken(token: string): void {
  if (!/^[0-9a-f]{8,64}$/.test(token)) {
    throw new Error("Invalid background stop token");
  }
}

/**
 * Build the spawn command: the supervisor (SUPERVISOR_SCRIPT, already written to
 * options.supervisorPath) runs under subshell + nohup.
 *
 * set -m: job control gives the backgrounded supervisor its own process group (PID === PGID);
 * the supervisor runs without job control, so the wrapper and everything it starts stay in that
 * group. nohup: ignores SIGHUP (survives terminal hangup).
 *
 * stdout and stderr are merged into a single output file with 2>&1 for unified display.
 * Returns the supervisor's PID (= PGID) via echo.
 */
export function buildSpawnCommand(options: SpawnCommandOptions): string {
  assertStopToken(options.stopToken);
  const bash = options.bashPath ?? "bash";
  const quotePath = options.quotePath ?? shellQuote;

  return (
    // `. "$0"` runs the supervisor file with $1.. = record dir, token, wrapper.
    `(set -m; nohup ${shellQuote(bash)} -c '. "$0"' ${quotePath(options.supervisorPath)} ` +
    `${quotePath(options.recordDir)} ${options.stopToken} ${shellQuote(options.wrapperScript)} ` +
    `> ${quotePath(options.outputPath)} 2>&1 ` +
    `< /dev/null & echo $!)`
  );
}

/** Seconds Stop waits for the group to end while the supervisor is alive. */
const STOP_WAIT_SECS = 6;
/** Extra seconds Stop watches the group after that wait (or after the supervisor died). */
const STOP_CONFIRM_SECS = 3;
/** Upper bound for one Stop exec: both waits, plus slack for the group scans. */
export const STOP_COMMAND_TIMEOUT_SECS = STOP_WAIT_SECS + STOP_CONFIRM_SECS + 6;

const STOP_RESULT_MARKER = "__XUM_BG_STOP__";

/**
 * Build the Stop command. It sends no signal to the group (B1 NoSignalToReusedPgid): it files a
 * stop request (`mkdir stop.<token>`, which the supervisor polls every second), then watches the
 * group until it is gone.
 *
 * It prints `__XUM_BG_STOP__ confirmed <code|none>` once no live member is left, or
 * `__XUM_BG_STOP__ unconfirmed none` when the group outlives the bounded wait or the request
 * cannot be filed (for example, a process killed the supervisor). The code is the exit_code
 * file the supervisor wrote, when it is a regular file holding digits.
 * `kill -0 <supervisor pid>` is only an observation: a live group whose leader is gone has no
 * supervisor left to act on the request, so Stop stops waiting early.
 *
 * Total runtime stays under STOP_COMMAND_TIMEOUT_SECS, which callers pass as the exec timeout
 * (RemoteRuntime kills the exec at the timeout).
 */
export function buildStopCommand(
  pgid: number,
  recordDir: string,
  stopToken: string,
  quotePath: (p: string) => string = shellQuote
): string {
  assertPgid(pgid);
  assertStopToken(stopToken);
  return [
    GROUP_LIVE_FUNCTION,
    `N=${pgid}; D=${quotePath(recordDir)}`,
    "res() {",
    '  c=; if [ -f "$D/exit_code" ] && [ ! -L "$D/exit_code" ]; then read -r c < "$D/exit_code"; fi 2>/dev/null',
    "  case $c in ''|*[!0-9]*) c=none ;; esac",
    `  echo "${STOP_RESULT_MARKER} $1 $c"; exit 0`,
    "}",
    '__xum_glive "$N" || res confirmed',
    `mkdir "$D/stop.${stopToken}" 2>/dev/null || [ -d "$D/stop.${stopToken}" ] || res unconfirmed`,
    "__i=0",
    `while [ "$__i" -lt ${STOP_WAIT_SECS} ]; do`,
    '  __xum_glive "$N" || res confirmed',
    '  kill -0 "$N" 2>/dev/null || break',
    "  sleep 1; __i=$((__i + 1))",
    "done",
    "__i=0",
    `while [ "$__i" -lt ${STOP_CONFIRM_SECS} ]; do`,
    '  __xum_glive "$N" || res confirmed',
    "  sleep 1; __i=$((__i + 1))",
    "done",
    '__xum_glive "$N" || res confirmed',
    "res unconfirmed",
  ].join("\n");
}

/** Outcome of a Stop command (buildStopCommand). */
export type StopCommandResult = { confirmed: true; exitCode: number | null } | { confirmed: false };

/**
 * Parse a Stop command's stdout. Substring match: SSH login banners can prefix stdout.
 * Anything else (no marker, a transport error message) is unconfirmed.
 */
export function parseStopResult(stdout: string): StopCommandResult {
  const match = new RegExp(`${STOP_RESULT_MARKER} (confirmed|unconfirmed) (\\d+|none)`).exec(
    stdout
  );
  if (match?.[1] !== "confirmed") return { confirmed: false };
  return { confirmed: true, exitCode: match[2] === "none" ? null : parseExitCode(match[2]) };
}
