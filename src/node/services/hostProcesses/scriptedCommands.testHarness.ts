/**
 * A script table of host commands, and HostProcesses on it, for tests that must not spawn a
 * process or open a socket. FakeRuntime.exec (5a PR 10) reuses the table.
 *
 * A command that has no entry rejects with an error that names it, so a test sees which spawn
 * its code reached. Outcomes reject like execFileAsync does: an Error whose message is the
 * stderr (or the exit code) and that carries code, signal, stdout and stderr.
 */
import type { HostProcess, HostProcesses } from "./hostProcesses";

export interface ScriptedCall {
  file: string;
  args: string[];
  cwd?: string;
}

/** What one command prints and how it exits. exitCode defaults to 0. */
export interface ScriptedOutcome {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * Command line (see commandLine) -> outcome. A function entry
 * gets the call, so it can act on it (for example delete the cwd) before it answers.
 */
export type ScriptTable = Record<
  string,
  ScriptedOutcome | ((call: ScriptedCall) => ScriptedOutcome | Promise<ScriptedOutcome>)
>;

// A token with no whitespace, quote or backslash stays as is. Any other token, and the empty
// one, is JSON-quoted.
const PLAIN_TOKEN = /^[^\s"\\]+$/;

/**
 * The table key of a call: the file and each arg, joined by spaces. Two different argv arrays
 * never share a key, so a caller that splits or joins args wrongly finds no entry: a plain token
 * cannot start with a quote, and a quoted token ends at its closing quote.
 * For example, git with ["show", "a b"] is `git show "a b"`, and git with ["show a", "b"] is
 * `git "show a" b`.
 */
export function commandLine(file: string, args: readonly string[]): string {
  return [file, ...args]
    .map((token) => (PLAIN_TOKEN.test(token) ? token : JSON.stringify(token)))
    .join(" ");
}

type ExecError = Error & {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

function execError(
  message: string,
  code: number | null,
  stdout: string,
  stderr: string,
  signal: string | null = null
) {
  const error = new Error(message) as ExecError;
  error.code = code;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

/**
 * The outcome of the entry for line, or undefined when the table has none. line is the key:
 * commandLine of the call for HostProcesses, the whole shell command for FakeRuntime.exec.
 */
export async function lookupScriptedCommand(
  table: ScriptTable,
  line: string,
  call: ScriptedCall
): Promise<ScriptedOutcome | undefined> {
  const entry = Object.hasOwn(table, line) ? table[line] : undefined;
  if (entry === undefined) return undefined;
  return typeof entry === "function" ? await entry(call) : entry;
}

/** Runs one call on the table, and rejects like execFileAsync on a non-zero exit. */
export async function runScriptedCommand(
  table: ScriptTable,
  call: ScriptedCall
): Promise<{ stdout: string; stderr: string }> {
  const outcome = await lookupScriptedCommand(table, commandLine(call.file, call.args), call);
  if (outcome === undefined) {
    throw execError(`No scripted command: ${commandLine(call.file, call.args)}`, null, "", "");
  }
  const stdout = outcome.stdout ?? "";
  const stderr = outcome.stderr ?? "";
  const exitCode = outcome.exitCode ?? 0;
  if (exitCode !== 0) {
    throw execError(
      stderr.trim() || `Command failed with exit code ${exitCode}`,
      exitCode,
      stdout,
      stderr
    );
  }
  return { stdout, stderr };
}

/**
 * The run, or a rejection once signal aborts. execFileAsync kills the child on abort, and the
 * close then rejects with "Command killed by signal SIGTERM", code null and signal SIGTERM.
 */
function untilAborted<T>(run: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return run;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(execError("Command killed by signal SIGTERM", null, "", "", "SIGTERM"));
    signal.addEventListener("abort", onAbort, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface ScriptedHostProcesses extends HostProcesses {
  /** Every execFile call, in order, answered or not. */
  readonly calls: ScriptedCall[];
}

/**
 * HostProcesses on a script table. fetchUrl answers only the URLs in `urls`, and each answer is
 * a factory because a Response body can be read once.
 */
export function createScriptedHostProcesses(
  commands: ScriptTable,
  urls: Record<string, () => Response> = {}
): ScriptedHostProcesses {
  const calls: ScriptedCall[] = [];
  return {
    calls,
    execFile: (file, args, options): HostProcess => {
      const call: ScriptedCall = { file, args: [...args], cwd: options?.cwd };
      calls.push(call);
      const signal = options?.signal;
      const result = signal?.aborted
        ? Promise.reject(execError("Command aborted before execution", null, "", ""))
        : untilAborted(runScriptedCommand(commands, call), signal);
      // As execFileAsync: a caller that disposes without awaiting must not see an unhandled
      // rejection.
      result.catch(() => undefined);
      return { result, [Symbol.dispose]: () => undefined };
    },
    fetchUrl: (url) => {
      const answer = Object.hasOwn(urls, url) ? urls[url] : undefined;
      return answer
        ? Promise.resolve(answer())
        : Promise.reject(new TypeError(`No scripted URL: ${url}`));
    },
  };
}
