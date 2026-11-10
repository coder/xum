import { randomBytes } from "crypto";
import { z } from "zod";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import {
  LAYOUT_AUDIT_CLOSE_RESERVE_MS,
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditViewport,
} from "@/common/constants/artifactLayoutAudit";
import { LayoutAuditPagePassSchema } from "@/common/types/artifactLayoutAudit";
import { TOOL_ENV_FAILED_EXIT, toolEnvPrelude } from "@/node/services/artifactCapabilities";
import type { FailedReason, ViewportOutcome } from "@/node/services/layoutAudit/viewportOutcome";
import { log } from "@/node/services/log";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered, type ExecResult } from "@/node/utils/runtime/helpers";

/**
 * Runs the page script in agent-browser on the workspace's runtime: the browser has to be on the
 * machine where agent-browser and the artifact file are. Two execs, never more:
 *
 * 1. RUN opens one fresh browser session and, for each width in run order, sets the viewport,
 *    loads the file anew, evaluates the script and prints one framed record. It stops at the
 *    first failure. Records printed before a timeout or an abort are kept; a record whose end
 *    line is missing is treated as not printed.
 * 2. CLOSE closes this run's session by name, in its own exec with its own time reserve and no
 *    abort signal, so it runs after a timeout or a cancel too. agent-browser's daemon outlives a
 *    killed CLI. Never `close --all`: other sessions on this host are not ours.
 *
 * agent-browser's JSON envelope stays inside this file.
 */

// Run-script exit codes. Each one happens before any browser is launched.
const EXIT_NO_AGENT_BROWSER = 127;
const EXIT_SCRIPT_UNREADABLE = 4;
/** The exec itself failed (the runtime threw), so there is no real exit code. */
const EXEC_FAILED_EXIT = -1;
const NEVER_LAUNCHED_EXITS: ReadonlySet<number> = new Set([
  EXIT_NO_AGENT_BROWSER,
  TOOL_ENV_FAILED_EXIT,
  EXIT_SCRIPT_UNREADABLE,
]);

/** Why a width has no record, by how the run ended. Anything else inherits the last failure. */
const EXIT_REASONS: Readonly<Partial<Record<number, FailedReason>>> = {
  [EXIT_CODE_TIMEOUT]: "timeout",
  [EXIT_CODE_ABORTED]: "aborted",
  [EXIT_NO_AGENT_BROWSER]: "no-agent-browser",
  [TOOL_ENV_FAILED_EXIT]: "tool-env-failed",
};

/** Not our session, our namespace: its sockets and restore state stay apart from the user's. */
const NAMESPACE = "xum-layout";
const SESSION_PREFIX = `${NAMESPACE}-`;
/** The backstop if CLOSE never lands: the daemon shuts itself down. */
const IDLE_TIMEOUT = "30s";
/** The run prints at most a few records of findings; this bounds a page that floods it. */
const MAX_RUN_OUTPUT_BYTES = 512 * 1024;
const MAX_CLOSE_OUTPUT_BYTES = 4096;

const FRAME_START = "@@xum-layout";
const FRAME_END = "@@xum-layout-end";

/**
 * Values reach the scripts only through env vars and stdin: nothing from the artifact path or
 * the page is spliced into the shell text, and the page script never travels in argv. The
 * identity and state variables that would change which browser runs, or what it restores, are
 * unset (the flags below win over the rest of the env). `cd /` puts the daemon outside the
 * project and workspace, so Xum's Browser tab never adopts it and no project agent-browser.json
 * applies. Every call carries the same flags, `close` included, so it addresses the same daemon.
 */
const SHELL_COMMON = String.raw`
unset AGENT_BROWSER_SESSION AGENT_BROWSER_SESSION_NAME AGENT_BROWSER_RESTORE AGENT_BROWSER_STATE AGENT_BROWSER_INIT_SCRIPTS AGENT_BROWSER_ENABLE AGENT_BROWSER_HEADED AGENT_BROWSER_PROFILE AGENT_BROWSER_AUTO_CONNECT AGENT_BROWSER_PROVIDER AGENT_BROWSER_ENGINE
ab() { agent-browser --namespace ${NAMESPACE} --session "$XUM_LAYOUT_SESSION" --headed false --idle-timeout ${IDLE_TIMEOUT} "$@"; }
cd / || exit ${EXIT_SCRIPT_UNREADABLE}
`;

// Reads stdin before anything can exit: a script that ends without reading the page script
// (no agent-browser, a failing tool_env) would turn the write of tens of KB into a broken pipe,
// and the audit would report the wrong reason.
const READ_STDIN = String.raw`
page_script=$(cat) || exit ${EXIT_SCRIPT_UNREADABLE}
`;

const RUN_SCRIPT = String.raw`
command -v agent-browser >/dev/null 2>&1 || exit ${EXIT_NO_AGENT_BROWSER}
${SHELL_COMMON}
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

const CLOSE_SCRIPT = String.raw`
${SHELL_COMMON}
ab close </dev/null >/dev/null 2>&1
`;

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

function outcomeOf(viewport: LayoutAuditViewport, record: RunRecord): ViewportOutcome {
  if (record.status !== 0 && record.envelope === "") {
    return { viewport, status: "failed", reason: "browser-failed" };
  }
  const pass = record.status === 0 ? parsePagePass(record.envelope) : undefined;
  if (pass === undefined) return { viewport, status: "failed", reason: "script-failed" };
  // A browser that ignored the viewport measured another layout: that is no result.
  if (pass.viewportWidth !== viewport.width) {
    return { viewport, status: "failed", reason: "wrong-viewport" };
  }
  return pass.complete
    ? { viewport, status: "complete", findings: pass.findings }
    : { viewport, status: "unsettled" };
}

/** One outcome per width, in run order. Every width without a record is "not checked". */
function outcomesOf(run: ExecResult): ViewportOutcome[] {
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
        : outcomeOf(viewport, record);
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
  // A third of a short budget, so a test budget still leaves the run most of its time.
  const closeMs = Math.min(LAYOUT_AUDIT_CLOSE_RESERVE_MS, remainingMs / 3);
  const session = `${SESSION_PREFIX}${randomBytes(6).toString("hex")}`;
  const { prelude, pathEnv } = toolEnvPrelude(input.toolEnvPath);
  const run = await execOrFail(input.runtime, READ_STDIN + prelude + RUN_SCRIPT, {
    cwd: input.cwd,
    pathEnv,
    env: {
      XUM_LAYOUT_SESSION: session,
      XUM_LAYOUT_URL: input.fileUrl,
      XUM_LAYOUT_VIEWPORTS: LAYOUT_AUDIT_VIEWPORTS.flatMap((v) => [v.width, v.height]).join(" "),
    },
    stdin: input.pageScript,
    timeout: (remainingMs - closeMs) / 1000,
    abortSignal: input.abortSignal,
    maxOutputBytes: MAX_RUN_OUTPUT_BYTES,
  });
  if (!NEVER_LAUNCHED_EXITS.has(run.exitCode)) {
    await execOrFail(input.runtime, prelude + CLOSE_SCRIPT, {
      cwd: input.cwd,
      pathEnv,
      env: { XUM_LAYOUT_SESSION: session },
      timeout: closeMs / 1000,
      maxOutputBytes: MAX_CLOSE_OUTPUT_BYTES,
    });
  }
  return outcomesOf(run);
}
