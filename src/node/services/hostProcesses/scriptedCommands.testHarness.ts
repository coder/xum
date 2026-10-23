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
 * Command line (file and args joined by spaces, see commandLine) -> outcome. A function entry
 * gets the call, so it can act on it (for example delete the cwd) before it answers.
 */
export type ScriptTable = Record<
  string,
  ScriptedOutcome | ((call: ScriptedCall) => ScriptedOutcome | Promise<ScriptedOutcome>)
>;

export function commandLine(file: string, args: readonly string[]): string {
  return [file, ...args].join(" ");
}

type ExecError = Error & {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

function execError(message: string, code: number | null, stdout: string, stderr: string) {
  const error = new Error(message) as ExecError;
  error.code = code;
  error.signal = null;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

/** Runs one call on the table. */
export async function runScriptedCommand(
  table: ScriptTable,
  call: ScriptedCall
): Promise<{ stdout: string; stderr: string }> {
  const line = commandLine(call.file, call.args);
  const entry = Object.hasOwn(table, line) ? table[line] : undefined;
  if (entry === undefined) {
    throw execError(`No scripted command: ${line}`, null, "", "");
  }
  const outcome = typeof entry === "function" ? await entry(call) : entry;
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
      const result = options?.signal?.aborted
        ? Promise.reject(execError("Command aborted before execution", null, "", ""))
        : runScriptedCommand(commands, call);
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
