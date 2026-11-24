import { randomUUID } from "node:crypto";
import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";

/**
 * Marks every process of one remote exec so an abort can stop them on the remote side (#6923).
 *
 * Killing the local client does not stop a remote command: `docker exec` does not pass a signal
 * to the process it started, an OpenSSH client's exit sends none to a command without a pty, and
 * `devcontainer exec` runs through the container engine the same way. So each exec starts its
 * outermost remote process with `XUM_EXEC_ID=<uuid>` in its environment, every descendant
 * inherits it, and the abort runs a second command that signals exactly the processes that carry
 * this one marker. A process that clears its environment (`env -i`) escapes; this is best effort.
 */
export type ExecMarker = `XUM_EXEC_ID=${string}`;

/** The variable that carries the marker; reserved, so a caller's env cannot replace it. */
export const EXEC_MARKER_ENV_KEY = "XUM_EXEC_ID";

/** `env` without the reserved marker key: a caller's value would hide the command from a stop. */
export function withoutExecMarkerKey<T>(env: Record<string, T>): Record<string, T> {
  if (!(EXEC_MARKER_ENV_KEY in env)) return env;
  const { [EXEC_MARKER_ENV_KEY]: _dropped, ...rest } = env;
  return rest;
}

const MARKER_PATTERN = /^XUM_EXEC_ID=[0-9a-f-]{36}$/;

/** A new marker; unique per exec, so a kill never reaches another exec's processes. */
export function createExecMarker(): ExecMarker {
  return `XUM_EXEC_ID=${randomUUID()}`;
}

function assertExecMarker(marker: string): asserts marker is ExecMarker {
  // Only a marker of this exact shape reaches a remote shell (it is not quoted for one).
  assert(MARKER_PATTERN.test(marker), `Invalid exec marker: ${JSON.stringify(marker)}`);
}

/** `command`, run with the marker in the environment of its outermost process. */
export function withExecMarker(marker: ExecMarker, command: string): string {
  assertExecMarker(marker);
  return `env '${marker}' ${command}`;
}

/** What the kill script prints to stderr when the host has no /proc to search. */
export const NO_PROC_MESSAGE = "no /proc; cannot stop the aborted command";

/**
 * POSIX sh that sends SIGTERM to every process whose environment holds `marker`, then SIGKILL
 * after 1 s to the ones left. Without /proc (a macOS host) it prints NO_PROC_MESSAGE to stderr
 * and exits 0: the command keeps running there.
 */
export function buildMarkerKillScript(marker: ExecMarker): string {
  assertExecMarker(marker);
  // The kill command itself carries another marker, and `m` is not exported, so it never
  // matches itself. One grep scans every environ (no process per pid on a busy host); a
  // substring match is exact enough, since the marker holds a fresh UUID.
  return [
    `m='${marker}'`,
    `if [ ! -d /proc/self ]; then echo '${NO_PROC_MESSAGE}' >&2; exit 0; fi`,
    'marked() { for f in $(grep -lF -- "$m" /proc/[0-9]*/environ 2>/dev/null); do ' +
      'p=${f#/proc/}; echo "${p%/environ}"; done; }',
    // An abort right after exec returned can come before the command is visible: wait up to
    // about 2 s for it to appear.
    "p=$(marked); n=0",
    // `sleep 0.2` falls back to whole seconds where sleep takes no fractions.
    'while [ -z "$p" ] && [ $n -lt 10 ]; do sleep 0.2 2>/dev/null || sleep 1; p=$(marked); n=$((n + 1)); done',
    '[ -z "$p" ] && exit 0',
    "kill -TERM $p 2>/dev/null",
    "sleep 1",
    'p=$(marked); [ -n "$p" ] && kill -KILL $p 2>/dev/null',
    "exit 0",
  ].join("\n");
}

/**
 * The stops that aborts started and that have not finished. A runtime keeps one, so its callers
 * (and tests) can wait for them (awaitPendingStops) while an abort's result never waits.
 */
export class PendingStops {
  private readonly stops = new Set<Promise<void>>();

  /** Keeps `stop` observable until it settles, and logs a rejection. */
  track(stop: Promise<void>, label: string): void {
    this.stops.add(stop);
    stop
      .catch((error: unknown) => log.warn(`${label}: stopping an aborted command failed`, error))
      .finally(() => this.stops.delete(stop));
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.stops]);
  }
}

/**
 * Runs the kill script for `marker` through `exec`, drains it, and logs when it could not stop
 * the command (a failure, or a host without /proc). Never throws.
 */
export async function stopMarkedCommand(
  exec: (script: string) => Promise<ExecStreamLike>,
  marker: ExecMarker,
  label: string
): Promise<void> {
  try {
    const stream = await exec(buildMarkerKillScript(marker));
    await stream.stdin.close().catch(() => undefined);
    const [exitCode, stderr] = await Promise.all([
      stream.exitCode,
      readAll(stream.stderr),
      readAll(stream.stdout),
    ]);
    if (exitCode !== 0 || stderr.includes(NO_PROC_MESSAGE)) {
      log.warn(`${label}: could not stop an aborted command`, { exitCode, stderr: stderr.trim() });
    }
  } catch (error) {
    log.warn(`${label}: could not stop an aborted command`, error);
  }
}

/** The parts of an ExecStream that stopMarkedCommand reads. */
export interface ExecStreamLike {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  exitCode: Promise<number>;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}
