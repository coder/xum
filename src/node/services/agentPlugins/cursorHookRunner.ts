/**
 * Runs trusted Cursor command hooks (cursorHooks.ts).
 * Source: https://cursor.com/docs/hooks.md. Contract: Cursor plugin RFC section 5.
 *
 * SECURITY AUDIT: this is the first plugin code that starts a host process on a hook event. The
 * command is plugin-controlled and runs as written (D17). The consent boundary is the user's trust
 * of the exact hooks.json entry plus the file review at install and update (D1, D30). Every call
 * re-checks, at that moment, the start conditions of RFC 5.4: no kill switch (D6), a local runtime
 * (D7), the trust gate (`deps.checkHook`), an input under HOOK_INPUT_MAX_CHARS, and no user Stop.
 * The process gets the minimal host environment plus the Cursor variables, never Xum's own.
 *
 * Failure rule (D8): none of these events can block, so every failure is ignored with a log line
 * and one chat notice per workspace and hook. A user Stop kills the process group and shows none.
 */
import assert from "node:assert";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { showOneLineControls } from "@/common/utils/agentPluginReviewText";
import { getErrorMessage } from "@/common/utils/errors";
import {
  HOOK_INPUT_MAX_CHARS,
  PLUGIN_HOOK_ORDER_BASE,
  effectiveHookTimeoutSeconds,
} from "@/constants/pluginHooks";
import type { Runtime } from "@/node/runtime/Runtime";
import { streamToStringCapped } from "@/node/runtime/streamUtils";
import type {
  EventSpine,
  ToolExecuteContext,
  TurnStopContext,
  TurnStopContinueReason,
} from "@/node/services/events/eventSpine";
import { log } from "@/node/services/log";
import { resolvePathWithinCwd } from "@/node/services/tools/fileCommon";
import { isAgentToolsDisabled, isTerminalsDisabled } from "@/node/utils/agentToolsDisabled";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import type { PluginHookDefinition } from "./codexHooks";
import { isPlainObject } from "./manifest";

const HOOK_OUTPUT_MAX_BYTES = 64 * 1024;
/**
 * The read cap: four bytes over the limit, because the capped reader drops a code point that the
 * cap splits (at most three bytes), and an output over the limit must still read as over it.
 */
const HOOK_OUTPUT_READ_BYTES = HOOK_OUTPUT_MAX_BYTES + 4;
const OUTPUT_CLOSE_GRACE_SECONDS = 2;
const EXIT_CODE_NOT_FOUND = 127;
const FILE_EDIT_TOOLS = new Set(["file_edit_replace_string", "file_edit_insert"]);

export type CursorHookGate = "allowed" | "refused" | "trust-store-unreadable";

export interface CursorHookRunnerDeps {
  /** Project trusted, this exact hash trusted, and the plugin still declares the hook. */
  checkHook(hook: PluginHookDefinition): Promise<CursorHookGate>;
  /** The workspace's runtime; a hook process starts only when its location is "local". */
  runtime: Runtime;
  /** A chat notice for the user; it never reaches the model. */
  notifyUser(message: string): void;
}

export interface CursorHookRegistration {
  workspaceId: string;
  pluginName: string;
  /** computePluginInstanceId of the plugin folder: its stop hooks' counts are its own. */
  pluginInstanceId: string;
  pluginRoot: string;
  transcriptPath: string;
  /** CURSOR_VERSION and `cursor_version`: `xum-<version>` (D18). */
  cursorVersion: string;
  order: number;
  hooks: PluginHookDefinition[];
  deps: CursorHookRunnerDeps;
}

type CallResult =
  | { kind: "output"; output: Record<string, unknown> }
  | { kind: "skipped" }
  | { kind: "aborted" }
  | { kind: "failed"; reason: string };

interface CallContext {
  workspaceRoot: string;
  /** Absent outside a model turn; JSON.stringify then leaves the field out of the input. */
  generationId: string | undefined;
  model: string | undefined;
  abortSignal: AbortSignal | undefined;
}

export function registerCursorPluginHooks(
  spine: EventSpine,
  registration: CursorHookRegistration
): () => void {
  assert(
    Number.isInteger(registration.order) && registration.order >= 0,
    "Cursor hook order must be a discovery index"
  );
  const runnable = registration.hooks.filter(
    (hook) => hook.status === "runnable" && hook.handler.type === "cursor-command"
  );
  const forEvent = (event: string) => runnable.filter((hook) => hook.event === event);
  const scope = {
    workspaceId: registration.workspaceId,
    order: PLUGIN_HOOK_ORDER_BASE + registration.order,
  };
  const notified = new Set<string>();
  const runner = { registration, notified };
  const unregisters: Array<() => void> = [];
  const afterResponse = forEvent("afterAgentResponse");
  const stop = forEvent("stop");
  if (afterResponse.length + stop.length > 0) {
    unregisters.push(
      spine.useBefore(
        "turn.stop",
        (ctx) => runTurnStopHooks(ctx, afterResponse, stop, runner),
        scope
      )
    );
  }
  const afterEdit = forEvent("afterFileEdit");
  if (afterEdit.length > 0) {
    unregisters.push(
      spine.use(
        "tool.execute",
        async (ctx, next) => {
          await next();
          await runAfterFileEditHooks(ctx, afterEdit, runner);
        },
        scope
      )
    );
  }
  return () => unregisters.forEach((unregister) => unregister());
}

interface Runner {
  registration: CursorHookRegistration;
  notified: Set<string>;
}

async function runTurnStopHooks(
  ctx: TurnStopContext,
  afterResponse: PluginHookDefinition[],
  stop: PluginHookDefinition[],
  runner: Runner
): Promise<void> {
  if (ctx.cwd === undefined) {
    log.warn("Cursor hooks: the workspace root is unknown; skipping turn.stop hooks", {
      workspaceId: runner.registration.workspaceId,
    });
    return;
  }
  const call: CallContext = {
    workspaceRoot: ctx.cwd,
    generationId: ctx.messageId,
    model: ctx.model,
    abortSignal: ctx.abortSignal,
  };
  for (const hook of afterResponse) {
    // A turn that ends on a tool part has no reply text (#6067): Cursor's field is then empty.
    await runHook(hook, { text: ctx.lastAssistantMessage ?? "" }, call, runner);
  }
  for (const hook of stop) {
    // loop_count: continuations of this user turn from any source (RFC section 6).
    const fields = { status: "completed", loop_count: ctx.turnContinuations };
    const reason = continueReasonOf(hook, await runHook(hook, fields, call, runner), runner);
    if (reason !== undefined) ctx.continueReasons.push(reason);
  }
}

function continueReasonOf(
  hook: PluginHookDefinition,
  result: CallResult,
  runner: Runner
): TurnStopContinueReason | undefined {
  if (result.kind !== "output") return undefined;
  const followup = result.output.followup_message;
  if (typeof followup !== "string") {
    if (followup !== undefined) reportFailure(hook, "its followup_message is not a string", runner);
    return undefined;
  }
  if (followup.trim().length === 0) return undefined;
  return {
    text: followup,
    pluginName: runner.registration.pluginName,
    hookKey: `${runner.registration.pluginInstanceId}:${hook.key}`,
    loopLimit: commandOf(hook).loopLimit,
  };
}

function fileEditOf(ctx: ToolExecuteContext): { filePath: string; edits: unknown[] } | null {
  if (!FILE_EDIT_TOOLS.has(ctx.toolName) || !ctx.executed) return null;
  // The tool's own result: a post hook that blocked the edit replaced `result`, not the file.
  if (!isPlainObject(ctx.terminalResult) || ctx.terminalResult.success !== true) return null;
  const args = ctx.args;
  if (!isPlainObject(args) || typeof args.path !== "string") return null;
  const edit =
    ctx.toolName === "file_edit_insert"
      ? { old_string: "", new_string: args.content }
      : { old_string: args.old_string, new_string: args.new_string };
  const { resolvedPath } = resolvePathWithinCwd(args.path, ctx.host.cwd, ctx.host.runtime);
  return { filePath: resolvedPath, edits: [edit] };
}

async function runAfterFileEditHooks(
  ctx: ToolExecuteContext,
  hooks: PluginHookDefinition[],
  runner: Runner
): Promise<void> {
  const edit = fileEditOf(ctx);
  if (edit === null) return;
  const call: CallContext = {
    workspaceRoot: ctx.host.cwd,
    generationId: ctx.host.turn?.turnId,
    model: ctx.host.turn?.model,
    abortSignal: ctx.abortSignal,
  };
  for (const hook of hooks) {
    await runHook(hook, { file_path: edit.filePath, edits: edit.edits }, call, runner);
  }
}

async function runHook(
  hook: PluginHookDefinition,
  eventFields: Record<string, unknown>,
  call: CallContext,
  runner: Runner
): Promise<CallResult> {
  const result = await runGuarded(hook, eventFields, call, runner.registration);
  if (result.kind === "failed") reportFailure(hook, result.reason, runner);
  return result;
}

/** Fail-soft: a throw (the trust read, a spawn error) is a failed call, never a broken hook point. */
async function runGuarded(
  hook: PluginHookDefinition,
  eventFields: Record<string, unknown>,
  call: CallContext,
  registration: CursorHookRegistration
): Promise<CallResult> {
  try {
    return (
      (await refusedStart(hook, call, registration)) ??
      (await startAndRead(hook, eventFields, call, registration))
    );
  } catch (error) {
    if (isAborted(call.abortSignal)) return { kind: "aborted" };
    return { kind: "failed", reason: getErrorMessage(error) };
  }
}

function commandOf(hook: PluginHookDefinition) {
  const handler = hook.handler;
  assert(handler.type === "cursor-command", "only command hooks register");
  return handler;
}

async function refusedStart(
  hook: PluginHookDefinition,
  call: CallContext,
  registration: CursorHookRegistration
): Promise<CallResult | undefined> {
  const blocked = startBlocker(registration);
  if (blocked !== undefined) {
    log.debug(`Cursor hooks: not starting '${registration.pluginName}' ${hook.event}`, {
      workspaceId: registration.workspaceId,
      key: hook.key,
      reason: blocked,
    });
    return { kind: "skipped" };
  }
  if (isAborted(call.abortSignal)) return { kind: "aborted" };
  const gate = await registration.deps.checkHook(hook);
  // A Stop during the trust read: the call must not start after it.
  if (isAborted(call.abortSignal)) return { kind: "aborted" };
  return GATE_RESULTS[gate];
}

const GATE_RESULTS: Record<CursorHookGate, CallResult | undefined> = {
  allowed: undefined,
  refused: { kind: "skipped" },
  "trust-store-unreadable": { kind: "failed", reason: "Xum cannot read its hook trust store" },
};

async function startAndRead(
  hook: PluginHookDefinition,
  eventFields: Record<string, unknown>,
  call: CallContext,
  registration: CursorHookRegistration
): Promise<CallResult> {
  const handler = commandOf(hook);
  const input = JSON.stringify({
    conversation_id: registration.workspaceId,
    generation_id: call.generationId,
    model: call.model,
    hook_event_name: hook.event,
    cursor_version: registration.cursorVersion,
    workspace_roots: [call.workspaceRoot],
    user_email: null,
    transcript_path: registration.transcriptPath,
    ...eventFields,
  });
  if (input.length > HOOK_INPUT_MAX_CHARS) {
    return { kind: "failed", reason: `its input is over ${HOOK_INPUT_MAX_CHARS} characters` };
  }
  const seconds = effectiveHookTimeoutSeconds(handler.timeoutSeconds);
  const exit = await execHook(handler.command, input, {
    // Cursor runs stop from the workspace root, the rest from the
    // plugin folder. The command is not rewritten (D17): `./x.sh` in stop looks in the workspace.
    cwd: hook.event === "stop" ? call.workspaceRoot : registration.pluginRoot,
    env: hookEnvironment(registration, call.workspaceRoot),
    seconds,
    abortSignal: call.abortSignal,
    runtime: registration.deps.runtime,
  });
  // Stop wins over everything the process did: an aborted call applies nothing.
  if (isAborted(call.abortSignal) || exit.kind === "aborted") return { kind: "aborted" };
  if (exit.kind === "failed") return exit;
  const failure = exitFailure(exit.exitCode, handler.command, seconds);
  return failure !== undefined ? { kind: "failed", reason: failure } : parseOutput(exit.stdout);
}

function startBlocker(registration: CursorHookRegistration): string | undefined {
  if (isAgentToolsDisabled()) return "XUM_DISABLE_AGENT_TOOLS";
  if (isTerminalsDisabled()) return "XUM_DISABLE_TERMINALS";
  if (projectAutomationDisabled()) return "XUM_DISABLE_PROJECT_AUTOMATION";
  if (registration.deps.runtime.location !== "local") return "not a local workspace";
  return undefined;
}

function hookEnvironment(
  registration: CursorHookRegistration,
  workspaceRoot: string
): Record<string, string> {
  const env: Record<string, string> = {
    CURSOR_PROJECT_DIR: workspaceRoot,
    CLAUDE_PROJECT_DIR: workspaceRoot,
    CURSOR_PLUGIN_ROOT: registration.pluginRoot,
    CURSOR_TRANSCRIPT_PATH: registration.transcriptPath,
    CURSOR_VERSION: registration.cursorVersion,
  };
  for (const name of ["PATH", "HOME"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

type ExecResult =
  | { kind: "exited"; exitCode: number; stdout: string }
  | { kind: "aborted" }
  | { kind: "failed"; reason: string };

/**
 * Start the command, feed it the input, and read both pipes while it runs: stdout up to the cap,
 * stderr discarded. Draining both keeps a hook that writes past a cap from stalling on a full pipe.
 */
async function execHook(
  command: string,
  input: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    seconds: number;
    abortSignal: AbortSignal | undefined;
    runtime: Runtime;
  }
): Promise<ExecResult> {
  let stream;
  try {
    stream = await options.runtime.exec(command, {
      cwd: options.cwd,
      env: options.env,
      hostEnv: "minimal",
      timeout: options.seconds,
      ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    });
  } catch (error) {
    if (options.abortSignal?.aborted === true) return { kind: "aborted" };
    return { kind: "failed", reason: `it could not start: ${getErrorMessage(error)}` };
  }
  // Aborting `release` cancels the three pipes, which frees their readers, writer and handles.
  const release = new AbortController();
  const read = (pipe: ReadableStream<Uint8Array>, maxBytes: number) =>
    streamToStringCapped(
      pipe.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: release.signal }),
      maxBytes
    );
  const settled = Promise.all([
    stream.exitCode,
    read(stream.stdout, HOOK_OUTPUT_READ_BYTES),
    read(stream.stderr, 0),
    writeInput(stream.stdin, input, release.signal),
  ]);
  // The runtime kills the process group at the timeout, but a process that left the group (job
  // control, setsid) can hold the pipes open after it: the call must still end.
  const ended = await settledBy(settled, (options.seconds + OUTPUT_CLOSE_GRACE_SECONDS) * 1000);
  if (ended === undefined) {
    // Xum cannot kill a process outside the group, but the call stops holding its pipes, so
    // repeated calls do not pile up readers and handles (Codex review).
    settled.catch(() => undefined);
    release.abort();
    return {
      kind: "failed",
      reason: `its output stayed open past its ${options.seconds}s timeout`,
    };
  }
  const [exitCode, output] = ended;
  if (exitCode === EXIT_CODE_ABORTED) return { kind: "aborted" };
  return { kind: "exited", exitCode, stdout: output };
}

/** The promise's value, or undefined once `ms` passed first (the promise is then left alone). */
async function settledBy<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeInput(
  stdin: WritableStream<Uint8Array>,
  input: string,
  release: AbortSignal
): Promise<void> {
  const writer = stdin.getWriter();
  // A process that never reads a full pipe would hold the write (and the pipe) forever.
  const abort = () => {
    // Nothing waits on this: the call already failed, and the write below settles with it.
    void writer.abort().catch(() => undefined);
  };
  release.addEventListener("abort", abort, { once: true });
  try {
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  } catch {
    // EPIPE: the process ended or closed stdin first, or the call let go of the pipe.
  } finally {
    release.removeEventListener("abort", abort);
  }
}

function exitFailure(exitCode: number, command: string, seconds: number): string | undefined {
  switch (exitCode) {
    case 0:
      return undefined;
    case EXIT_CODE_TIMEOUT:
      return `timed out after ${seconds}s`;
    case EXIT_CODE_NOT_FOUND:
      // The shell gives 127 for a missing command and for a missing command inside it (jq, bun),
      // and Xum keeps no stderr to tell them apart, so the reason names both. The command is
      // plugin text: its control characters are marked, so a bidi character cannot reorder the
      // notice.
      return `\`${showOneLineControls(command)}\`: a command or one of its dependencies was not found (exit 127)`;
    case 2:
      return "exit code 2; this event cannot block";
    default:
      return `exit code ${exitCode}`;
  }
}

function parseOutput(stdout: string): CallResult {
  if (Buffer.byteLength(stdout, "utf8") > HOOK_OUTPUT_MAX_BYTES) {
    return { kind: "failed", reason: `invalid output: over ${HOOK_OUTPUT_MAX_BYTES} bytes` };
  }
  if (stdout.trim().length === 0) return { kind: "output", output: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "failed", reason: "invalid output: not JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { kind: "failed", reason: "invalid output: not a JSON object" };
  }
  if (parsed.permission === "deny") {
    return { kind: "failed", reason: 'permission "deny"; this event cannot block' };
  }
  return { kind: "output", output: parsed };
}

/** A function, not an inline read: TypeScript would keep a narrowed `aborted` across an await. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function reportFailure(hook: PluginHookDefinition, reason: string, runner: Runner): void {
  const { registration } = runner;
  log.warn(`Cursor hooks: '${registration.pluginName}' ${hook.event} hook failed (${reason})`, {
    workspaceId: registration.workspaceId,
    key: hook.key,
  });
  if (runner.notified.has(hook.key)) return;
  runner.notified.add(hook.key);
  registration.deps.notifyUser(
    `hook ${hook.event} failed (${reason}). Turn the hook off in Settings > Plugins.`
  );
}
