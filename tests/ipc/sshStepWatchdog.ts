/**
 * #6588: ssh integration tests sometimes ran into jest's timeout in the merge queue, and that
 * message does not say which step hung. A watched ssh test records its current step; a watchdog
 * fails it before jest's limit with that step, the last init lines and the SSH pool's health.
 */
import type { SSHServerConfig } from "../runtime/test-fixtures/ssh-fixture";
import { sshConnectionPool } from "../../src/node/runtime/sshConnectionPool";
import { isInitOutput } from "@/common/orpc/types";
import type { InitStateManager } from "../../src/node/services/initStateManager";
import type { StreamCollector } from "./streamCollector";

export interface SshStepContext {
  step: string;
  /** The init lines seen so far (read when a message is built). */
  initLines: () => string[];
}

/** The init output lines a stream collector has seen. */
export function initOutputLines(collector: StreamCollector): string[] {
  return collector.getEvents().flatMap((e) => (isInitOutput(e) ? [e.line] : []));
}

export function describeSsh(sshConfig: SSHServerConfig | undefined, ctx: SshStepContext): string {
  const health =
    sshConfig &&
    sshConnectionPool.getConnectionHealth({
      host: "testuser@localhost",
      port: sshConfig.port,
      identityFile: sshConfig.privateKeyPath,
    });
  return (
    `Last init lines: ${JSON.stringify(ctx.initLines().slice(-5))}. ` +
    // CI runs the default OpenSSH transport. The SSH2 pool exposes no health to read.
    `OpenSSH pool: ${JSON.stringify(health ?? null)}`
  );
}

/**
 * #6870: the backend's own view of a workspace's init, with each line's offset from the init
 * start. It tells a stuck init (status running: the last line names the step, `idleMs` says how
 * long it has been silent) from an init that ended while the test's subscriber missed init-end.
 */
export function describeBackendInit(
  initStateManager: InitStateManager,
  workspaceId: string,
  nowMs = Date.now()
): string {
  const state = initStateManager.getInitState(workspaceId);
  if (state == null) return "Backend init state: none.";
  const lastAt = state.lines.at(-1)?.timestamp ?? state.startTime;
  const summary = {
    status: state.status,
    phase: state.phase,
    exitCode: state.exitCode,
    runMs: (state.endTime ?? nowMs) - state.startTime,
    idleMs: state.endTime == null ? nowMs - lastAt : undefined,
    lines: state.lines.slice(-8).map((l) => `+${l.timestamp - state.startTime} ${l.line}`),
  };
  return `Backend init state: ${JSON.stringify(summary)}`;
}

/**
 * Runs an ssh test body under a watchdog that fails after `watchdogMs` (set it below the jest
 * timeout). `getSshConfig` is read when the watchdog fires: the server starts in `beforeAll`.
 */
export async function runWatchedSshTest(
  watchdogMs: number,
  getSshConfig: () => SSHServerConfig | undefined,
  body: (ctx: SshStepContext) => Promise<void>
): Promise<void> {
  const ctx: SshStepContext = { step: "setup", initLines: () => [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const where = `still in step "${ctx.step}" after ${watchdogMs} ms`;
      reject(new Error(`ssh test ${where} (#6588). ${describeSsh(getSshConfig(), ctx)}`));
    }, watchdogMs);
  });
  try {
    await Promise.race([body(ctx), watchdog]);
  } finally {
    clearTimeout(timer);
  }
}
