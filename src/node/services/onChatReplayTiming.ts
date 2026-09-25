import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";

/**
 * Per-phase timing for one onChat replay (AgentSession.emitHistoricalEvents).
 *
 * Why (#4504): the renderer shows the transcript skeleton until `caught-up`, and the onChat
 * subscription delivers nothing until the whole replay finished. This breaks the server side of
 * that wait into phases so fixes can be ranked and proven. Instrumentation only: it must never
 * change what the replay emits.
 */

/** Stable message for the one structured line per replay; perf scenarios grep logs for it. */
export const ONCHAT_REPLAY_TIMING_LOG_MESSAGE = "onChat replay";

/** Replays at or above this total escalate from debug to info so slow switches show by default. */
export const ONCHAT_REPLAY_SLOW_LOG_THRESHOLD_MS = 1000;

export type OnChatReplayPhase =
  | "partialRead"
  | "historyLockWait"
  | "historyRead"
  | "fingerprint"
  | "olderHistoryCheck"
  | "emitRows"
  | "streamReplay"
  | "initReplay";

export interface OnChatReplayTiming {
  totalMs: number;
  /** Only phases that ran; repeated phases are summed. */
  phasesMs: Partial<Record<OnChatReplayPhase, number>>;
}

export interface OnChatReplayTimer {
  time<T>(phase: OnChatReplayPhase, fn: () => Promise<T>): Promise<T>;
  timeSync<T>(phase: OnChatReplayPhase, fn: () => T): T;
  /**
   * Time a locked read as two phases: `waitPhase` until `fn` reports the lock was acquired,
   * `workPhase` for the rest. If the lock is never reported, the whole call counts as wait.
   */
  timeLocked<T>(
    waitPhase: OnChatReplayPhase,
    workPhase: OnChatReplayPhase,
    fn: (onLockAcquired: () => void) => Promise<T>
  ): Promise<T>;
  finish(): OnChatReplayTiming;
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export function createOnChatReplayTimer(
  now: () => number = () => performance.now()
): OnChatReplayTimer {
  const startedAt = now();
  const phasesMs: Partial<Record<OnChatReplayPhase, number>> = {};
  const add = (phase: OnChatReplayPhase, elapsedMs: number): void => {
    assert(elapsedMs >= 0, `onChat replay phase ${phase} has negative duration ${elapsedMs}`);
    phasesMs[phase] = (phasesMs[phase] ?? 0) + elapsedMs;
  };

  return {
    async time(phase, fn) {
      const phaseStartedAt = now();
      try {
        return await fn();
      } finally {
        add(phase, now() - phaseStartedAt);
      }
    },
    timeSync(phase, fn) {
      const phaseStartedAt = now();
      try {
        return fn();
      } finally {
        add(phase, now() - phaseStartedAt);
      }
    },
    async timeLocked(waitPhase, workPhase, fn) {
      const phaseStartedAt = now();
      let lockAcquiredAt: number | undefined;
      try {
        return await fn(() => {
          lockAcquiredAt ??= now();
        });
      } finally {
        const endedAt = now();
        const acquiredAt = lockAcquiredAt ?? endedAt;
        add(waitPhase, acquiredAt - phaseStartedAt);
        add(workPhase, endedAt - acquiredAt);
      }
    },
    finish() {
      const rounded: Partial<Record<OnChatReplayPhase, number>> = {};
      for (const [phase, elapsedMs] of Object.entries(phasesMs) as Array<
        [OnChatReplayPhase, number]
      >) {
        rounded[phase] = roundMs(elapsedMs);
      }
      return { totalMs: roundMs(now() - startedAt), phasesMs: rounded };
    },
  };
}

/**
 * Emit the single per-replay line. Debug by default (every workspace switch replays), info
 * when the replay was slow enough that a user saw the skeleton for a noticeable time.
 */
export function logOnChatReplayTiming(
  fields: OnChatReplayTiming & { workspaceId: string } & Record<string, unknown>
): void {
  const emit = fields.totalMs >= ONCHAT_REPLAY_SLOW_LOG_THRESHOLD_MS ? log.info : log.debug;
  emit(ONCHAT_REPLAY_TIMING_LOG_MESSAGE, fields);
}
