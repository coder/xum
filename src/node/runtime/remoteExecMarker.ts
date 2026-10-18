import { randomUUID } from "node:crypto";
import assert from "@/common/utils/assert";

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
 * POSIX sh that sends SIGTERM to every process whose environment holds exactly `marker`, then
 * SIGKILL after 1 s to the ones left. Without /proc (a macOS host) it prints NO_PROC_MESSAGE to
 * stderr and exits 0: the command keeps running there.
 */
export function buildMarkerKillScript(marker: ExecMarker): string {
  assertExecMarker(marker);
  // The kill command itself carries another marker, so it never matches itself.
  return [
    `m='${marker}'`,
    `if [ ! -d /proc/self ]; then echo '${NO_PROC_MESSAGE}' >&2; exit 0; fi`,
    "marked() { for d in /proc/[0-9]*; do " +
      'if tr "\\000" "\\n" < "$d/environ" 2>/dev/null | grep -qxF "$m"; then echo "${d#/proc/}"; fi; ' +
      "done; }",
    'p=$(marked); [ -z "$p" ] && exit 0',
    "kill -TERM $p 2>/dev/null",
    "sleep 1",
    'p=$(marked); [ -n "$p" ] && kill -KILL $p 2>/dev/null',
    "exit 0",
  ].join("\n");
}
