import * as crypto from "crypto";
import { z } from "zod";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import {
  LAYOUT_AUDIT_CLOSE_RESERVE_MS,
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditViewport,
} from "@/common/constants/artifactLayoutAudit";
import { LayoutAuditPagePassSchema } from "@/common/types/artifactLayoutAudit";
import { shellQuote } from "@/common/utils/shell";
import { TOOL_ENV_FAILED_EXIT, toolEnvPrelude } from "@/node/services/artifactCapabilities";
import {
  failedOutcomes,
  type FailedReason,
  type ViewportOutcome,
} from "@/node/services/layoutAudit/viewportOutcome";
import { log } from "@/node/services/log";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered, type ExecResult } from "@/node/utils/runtime/helpers";

/**
 * Runs the page script in agent-browser on the workspace's runtime: the browser has to be on the
 * machine where agent-browser and the artifact file are. Two execs, and a third only when the
 * second did not end well (it removes the run's folder, after the audit's budget):
 *
 * 1. RUN opens one fresh browser session, turns its network off, and, for each width in run
 *    order, sets the viewport, loads the file anew, evaluates the script and prints one framed
 *    record. It stops at the first failure. Records printed before a timeout or an abort are
 *    kept; a record whose end line is missing is treated as not printed.
 * 2. CLOSE closes this run's session by name and removes the run's socket folder, in its own
 *    exec with its own time reserve and no abort signal, so it runs after a timeout or a cancel
 *    too. agent-browser's daemon outlives a killed CLI. Never `close --all`: other sessions on
 *    this host are not ours.
 *
 * What CLOSE cannot do: a daemon that is still executing a command (a page that never finishes
 * loading, a script that never returns) does not take the close. agent-browser ends such a
 * command itself after 25 to 30 s (measured on 0.33.2; AGENT_BROWSER_DEFAULT_TIMEOUT did not
 * shorten it for `open` or `eval`), and the idle timeout below then shuts the daemon down. So
 * after a hung page the browser lives up to about half a minute past the audit's result.
 *
 * agent-browser's JSON envelope stays inside this file.
 */

// Run-script exit codes. Those in NEVER_LAUNCHED_EXITS happen before any browser is launched, and
// before the run owns a socket folder (so CLOSE, which removes that folder, is skipped for them).
const EXIT_NO_AGENT_BROWSER = 127;
const EXIT_SETUP_FAILED = 4;
/**
 * `set offline on` failed. Not a never-launched exit: that call starts the browser (measured on
 * 0.33.2), so CLOSE must still run.
 */
const EXIT_OFFLINE_FAILED = 5;
/** The exec itself failed (the runtime threw), so there is no real exit code. */
const EXEC_FAILED_EXIT = -1;
const NEVER_LAUNCHED_EXITS: ReadonlySet<number> = new Set([
  EXIT_NO_AGENT_BROWSER,
  TOOL_ENV_FAILED_EXIT,
  EXIT_SETUP_FAILED,
]);

/** Why a width has no record, by how the run ended. Anything else inherits the last failure. */
const EXIT_REASONS: Readonly<Partial<Record<number, FailedReason>>> = {
  [EXIT_CODE_TIMEOUT]: "timeout",
  [EXIT_CODE_ABORTED]: "aborted",
  [EXIT_NO_AGENT_BROWSER]: "no-agent-browser",
  [TOOL_ENV_FAILED_EXIT]: "tool-env-failed",
};

const SESSION_PREFIX = "xum-layout-";
/**
 * Each run keeps agent-browser's session files (socket, pid, config) in a folder of its own,
 * `<parent>/<session>`, and CLOSE removes it. agent-browser leaves a config file behind for every
 * session name, so in its default folder a unique name per publish would pile up one file per
 * publish in the user's home. A private folder also keeps the session out of `session list` and
 * so out of Xum's Browser tab. The parent is short on purpose: a Unix socket path caps at 108 bytes.
 */
const SOCKET_DIR_PARENT = "/tmp";
/**
 * The backstop when CLOSE does not land (see above): the daemon shuts itself down once it has
 * been idle this long. A command in flight does not count as idle (an 8 s eval survived a 5 s
 * idle timeout), and the run's own calls follow each other within milliseconds.
 */
const IDLE_TIMEOUT = "10s";
/**
 * Chrome flags that send every connection of the whole browser to a dead end. `set offline on`
 * covers only the tab it ran on: a window the page opens (window.open, a target=_blank form or
 * link) is another tab with its own network. Nothing listens on port 9, loopback goes through
 * the proxy too (`<-loopback>`), no host resolves, and WebRTC may not use UDP outside the proxy.
 * They travel in agent-browser's own `--args`, comma separated (none of them holds a comma), and
 * never in AGENT_BROWSER_ARGS, which the sweep clears. They apply when the browser launches, and
 * every call carries them: a call whose launch settings differ from the running browser's can
 * restart it, and a restarted browser has no emulation left.
 */
const BROWSER_NETWORK_OFF_ARGS = [
  "--proxy-server=127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
].join(",");
/** How long CLOSE waits for `close` before it removes the socket folder anyway. */
const CLOSE_WAIT_SECONDS = 2;
/**
 * Three passes at the schema's bound (LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS, 4201 findings), each
 * finding about 110 bytes of JSON plus its selector (at most five parts of about 30 bytes, so
 * 256 bytes in all): 3 x 4201 x 256 is about 3.1 MiB, and 4 MiB leaves room for the envelopes
 * and the frames. A run whose output is cut has records without their end line, and those count
 * as missing.
 */
const MAX_RUN_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CLOSE_OUTPUT_BYTES = 4096;

const FRAME_START = "@@xum-layout";
const FRAME_END = "@@xum-layout-end";

/**
 * Values reach the scripts only through env vars and stdin: nothing from the artifact path or
 * the page is spliced into the shell text, and the page script never travels in argv.
 *
 * The audit must only ever drive the browser it launched. So every inherited AGENT_BROWSER_*
 * variable is unset (an inherited AGENT_BROWSER_CDP would attach to an existing browser and
 * navigate a live tab; the profile, provider and engine variables change which browser runs and
 * what it restores), and only what the run sets is exported. An explicit `--config` replaces the
 * user-level and project agent-browser configs, which can name the same things; the run writes
 * an empty one into its own folder. `env` feeds only the sweep's sed: its output (values
 * included) never reaches stdout or stderr. `cd /` keeps the daemon outside the workspace. Every
 * call carries the same flags and the same folder, `close` included, so it addresses the same
 * daemon.
 *
 * tool_env gives the run its exported environment (PATH above all: that is how agent-browser is
 * found) and nothing else. The scripts below do not run in the shell that sourced it: that shell
 * replaces itself with a new one (see inNewShell), so no shell state tool_env left behind (IFS,
 * a readonly or unexported variable, a function, a shell option) can change what they do. A new
 * shell starts with the default IFS, the default options and no readonly variable, so the
 * sweep's `unset` cannot fail. Outside this boundary, because tool_env is trusted project code that can run anything:
 * a tool_env that exports the run's own XUM_LAYOUT_* names, or that puts another `env`, `sed`
 * or `agent-browser` on PATH.
 */
const SHELL_COMMON = String.raw`
for v in $(env | sed -n 's/^\(AGENT_BROWSER_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
export AGENT_BROWSER_SOCKET_DIR="$XUM_LAYOUT_SOCKET_DIR"
ab_wrap=
ab() { $ab_wrap agent-browser --session "$XUM_LAYOUT_SESSION" --config "$XUM_LAYOUT_SOCKET_DIR/config.json" --idle-timeout ${IDLE_TIMEOUT} --args "$XUM_LAYOUT_BROWSER_ARGS" "$@"; }
cd / || exit ${EXIT_SETUP_FAILED}
`;

// A run that ends early (no agent-browser, a tool_env that fails) leaves the page script on
// stdin unread. The exec is told that this is fine (`stdinMayGoUnread`), so the exit code still
// says why nothing ran.
//
// The page is agent-written and its scripts run in a normal browser, so the network is off for
// the whole browser from its launch (BROWSER_NETWORK_OFF_ARGS, on every `ab` call), and `set
// offline on` turns it off for the tab as well, before the first `open`. A script, image, style
// sheet, socket or window of the page cannot reach a host. file:// pages and relative files still
// load. A run that cannot turn it off stops (fail closed) and every width reads "not checked".
const RUN_SCRIPT = String.raw`
command -v agent-browser >/dev/null 2>&1 || exit ${EXIT_NO_AGENT_BROWSER}
page_script=$(cat) || exit ${EXIT_SETUP_FAILED}
${SHELL_COMMON}
# Plain mkdir: it fails on a path that already exists, so the run never adopts a folder it did
# not make, and CLOSE never removes one.
mkdir -m 700 "$XUM_LAYOUT_SOCKET_DIR" || exit ${EXIT_SETUP_FAILED}
# This run made the folder, so it removes it when it cannot go on: CLOSE is skipped for this exit.
printf '{}' > "$XUM_LAYOUT_SOCKET_DIR/config.json" || { rm -rf -- "$XUM_LAYOUT_SOCKET_DIR"; exit ${EXIT_SETUP_FAILED}; }
ab set offline on </dev/null >/dev/null 2>&1 || exit ${EXIT_OFFLINE_FAILED}
set -- $XUM_LAYOUT_VIEWPORTS
while [ "$#" -ge 2 ]; do
  width=$1; height=$2; shift 2
  ab set viewport "$width" "$height" </dev/null >/dev/null 2>&1 && ab open "$XUM_LAYOUT_URL" </dev/null >/dev/null 2>&1
  status=$?
  envelope=
  if [ "$status" -eq 0 ]; then
    envelope=$(printf '%s' "$page_script" | ab --json eval --stdin 2>/dev/null)
    status=$?
  fi
  printf '${FRAME_START} %s %s\n%s\n${FRAME_END}\n' "$width" "$status" "$envelope"
  [ "$status" -eq 0 ] || break
done
`;

// Removes the run's socket folder, and nothing that is not one. CLOSE ends with it. It also runs
// by itself after a CLOSE that did not end well: it then sources no tool_env and calls no
// agent-browser, so what made CLOSE lose (a loaded host, a close that never answers) cannot make
// it lose the same way. That run has its own short time, after the audit's budget. Without it,
// audits on a host with a load average above 50 left their folders behind.
const REMOVE_SOCKET_DIR = String.raw`
case "$XUM_LAYOUT_SOCKET_DIR" in
  ${SOCKET_DIR_PARENT}/${SESSION_PREFIX}*) rm -rf -- "$XUM_LAYOUT_SOCKET_DIR" ;;
esac
`;

// The folder is removed whether or not the close worked. A busy daemon does not answer the close
// (see the top of this file), so where `timeout` exists the wait is cut short and the folder is
// removed under the daemon, which then exits on its own. When this exec is killed before it
// gets there (no `timeout` on stock macOS, or a host too loaded to finish in the close reserve),
// REMOVE_SOCKET_DIR runs again by itself. Only when that fails too, or when Xum itself dies
// mid-audit, the folder stays in /tmp with one small config file.
const CLOSE_SCRIPT = String.raw`
${SHELL_COMMON}
command -v timeout >/dev/null 2>&1 && ab_wrap="timeout ${CLOSE_WAIT_SECONDS}"
ab close </dev/null >/dev/null 2>&1
${REMOVE_SOCKET_DIR}`;

/** The time of the removal that runs by itself after a failed CLOSE. */
const REMOVE_TIMEOUT_SECONDS = 5;

/**
 * The text that runs `script` in a new shell, in place of the shell that sourced tool_env: only
 * the environment crosses an exec. `exec` keeps the process, so a timeout or a cancel still
 * kills the run, and stdin goes straight to the script. /bin/sh, not a name or a variable that
 * tool_env could have changed: the scripts are POSIX sh.
 *
 * Where /bin/sh is bash, an exported SHELLOPTS or BASHOPTS would switch the old shell's options
 * on again in the new one (`set -e; export SHELLOPTS` would end RUN at a failed eval, before
 * its record, and CLOSE at a failed close, before it removes the folder). The runtime's shell
 * is bash, so `export -n` takes the export off both.
 */
function inNewShell(script: string): string {
  return `export -n SHELLOPTS BASHOPTS 2>/dev/null\nexec /bin/sh -c ${shellQuote(script)}\n`;
}

export interface LayoutRunInput {
  runtime: Runtime;
  /** The bash tool's cwd: tool_env is sourced here. */
  cwd: string;
  /** The tool_env to source, for trusted projects only; null to source none. */
  toolEnvPath: string | null;
  /** `file://` URL of the artifact, in the runtime's namespace. */
  fileUrl: string;
  /** The expression to evaluate in the page: it resolves to the page result. */
  pageScript: string;
  /** Absolute time by which the run and the close must both be over. */
  deadlineMs: number;
  abortSignal?: AbortSignal;
  /**
   * Folders the run reads besides cwd: where the macOS agent sandbox applies (local runtimes, when
   * the user turned it on), the browser could not open the artifact without them.
   */
  sandboxReadPaths?: string[];
}

interface RunRecord {
  status: number;
  envelope: string;
}

const RECORD_PATTERN = new RegExp(
  `^${FRAME_START} (\\d+) (\\d+)\\n([\\s\\S]*?)\\n${FRAME_END}$`,
  "gm"
);

/** Width to record. A record without its end line never matches, so it counts as missing. */
function parseRecords(stdout: string): Map<number, RunRecord> {
  const records = new Map<number, RunRecord>();
  for (const [, width, status, envelope] of stdout.matchAll(RECORD_PATTERN)) {
    records.set(Number(width), { status: Number(status), envelope });
  }
  return records;
}

const EvalEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ result: LayoutAuditPagePassSchema }),
});

function parsePagePass(envelope: string) {
  try {
    const parsed = EvalEnvelopeSchema.safeParse(JSON.parse(envelope));
    return parsed.success ? parsed.data.data.result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the pass came from the artifact. A window the page opens takes over the browser's
 * active tab, and the audit script then measures that tab: its address (an error page, say) is
 * not the artifact's. The URL built here (over SSH, with encodeURIComponent) can escape more than
 * the browser does, so the decoded paths are compared, not the strings, and a hash or a query
 * that the page changed does not matter.
 */
function isArtifactPage(href: string, fileUrl: string): boolean {
  try {
    const page = new URL(href);
    const artifact = new URL(fileUrl);
    // The host too: a file URL with an authority (a UNC share) names another machine.
    return (
      page.protocol === artifact.protocol &&
      page.host === artifact.host &&
      decodeURIComponent(page.pathname) === decodeURIComponent(artifact.pathname)
    );
  } catch {
    return false;
  }
}

function outcomeOf(
  viewport: LayoutAuditViewport,
  record: RunRecord,
  fileUrl: string
): ViewportOutcome {
  if (record.status !== 0 && record.envelope === "") {
    return { viewport, status: "failed", reason: "browser-failed" };
  }
  const pass = record.status === 0 ? parsePagePass(record.envelope) : undefined;
  if (pass === undefined || !isArtifactPage(pass.href, fileUrl)) {
    return { viewport, status: "failed", reason: "script-failed" };
  }
  // A browser that ignored the viewport measured another layout: that is no result.
  if (pass.viewportWidth !== viewport.width) {
    return { viewport, status: "failed", reason: "wrong-viewport" };
  }
  return pass.complete
    ? { viewport, status: "complete", findings: pass.findings }
    : { viewport, status: "unsettled" };
}

/** One outcome per width, in run order. Every width without a record is "not checked". */
function outcomesOf(run: ExecResult, fileUrl: string): ViewportOutcome[] {
  const records = parseRecords(run.stdout);
  let lastFailure: FailedReason | undefined;
  return LAYOUT_AUDIT_VIEWPORTS.map((viewport) => {
    const record = records.get(viewport.width);
    const outcome: ViewportOutcome =
      record === undefined
        ? {
            viewport,
            status: "failed",
            reason: EXIT_REASONS[run.exitCode] ?? lastFailure ?? "browser-failed",
          }
        : outcomeOf(viewport, record, fileUrl);
    if (outcome.status === "failed") lastFailure = outcome.reason;
    return outcome;
  });
}

/** Never throws: a runtime that cannot exec at all is one more way to be "not checked". */
async function execOrFail(
  runtime: Runtime,
  command: string,
  options: Parameters<typeof execBuffered>[2]
): Promise<ExecResult> {
  try {
    return await execBuffered(runtime, command, options);
  } catch (error) {
    log.debug("layout audit exec failed", { error });
    const exitCode = options.abortSignal?.aborted ? EXIT_CODE_ABORTED : EXEC_FAILED_EXIT;
    return { stdout: "", stderr: "", exitCode, duration: 0 };
  }
}

export async function runLayoutPasses(input: LayoutRunInput): Promise<ViewportOutcome[]> {
  const remainingMs = Math.max(input.deadlineMs - Date.now(), 0);
  // Setup used the whole budget: a launch now would hand the runtime a zero timeout, which some
  // runtimes read as no limit, so a page that hangs could hold the publish past its budget.
  if (remainingMs <= 0) return failedOutcomes("timeout");
  // A third of a short budget, so a test budget still leaves the run most of its time.
  const closeMs = Math.min(LAYOUT_AUDIT_CLOSE_RESERVE_MS, remainingMs / 3);
  const session = `${SESSION_PREFIX}${crypto.randomBytes(6).toString("hex")}`;
  const sessionEnv = {
    XUM_LAYOUT_SESSION: session,
    XUM_LAYOUT_SOCKET_DIR: `${SOCKET_DIR_PARENT}/${session}`,
    XUM_LAYOUT_BROWSER_ARGS: BROWSER_NETWORK_OFF_ARGS,
  };
  const { prelude, pathEnv } = toolEnvPrelude(input.toolEnvPath);
  const run = await execOrFail(input.runtime, prelude + inNewShell(RUN_SCRIPT), {
    cwd: input.cwd,
    pathEnv,
    env: {
      ...sessionEnv,
      XUM_LAYOUT_URL: input.fileUrl,
      XUM_LAYOUT_VIEWPORTS: LAYOUT_AUDIT_VIEWPORTS.flatMap((v) => [v.width, v.height]).join(" "),
    },
    stdin: input.pageScript,
    stdinMayGoUnread: true,
    sandboxReadPaths: input.sandboxReadPaths,
    timeout: (remainingMs - closeMs) / 1000,
    abortSignal: input.abortSignal,
    maxOutputBytes: MAX_RUN_OUTPUT_BYTES,
  });
  if (!NEVER_LAUNCHED_EXITS.has(run.exitCode)) {
    const close = await execOrFail(input.runtime, prelude + inNewShell(CLOSE_SCRIPT), {
      cwd: input.cwd,
      pathEnv,
      env: sessionEnv,
      timeout: closeMs / 1000,
      maxOutputBytes: MAX_CLOSE_OUTPUT_BYTES,
    });
    if (close.exitCode !== 0) {
      await execOrFail(input.runtime, inNewShell(REMOVE_SOCKET_DIR), {
        cwd: input.cwd,
        env: sessionEnv,
        timeout: REMOVE_TIMEOUT_SECONDS,
        maxOutputBytes: MAX_CLOSE_OUTPUT_BYTES,
      });
    }
  }
  return outcomesOf(run, input.fileUrl);
}
