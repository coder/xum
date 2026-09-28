/**
 * Mid-turn thinking-level override state.
 *
 * One holder object is created per turn by AgentSession (at durable turn
 * acceptance) and threaded BY REFERENCE down through AIService into
 * StreamManager's request config — the same shared-mutable-state pattern as
 * ToolSearchStreamState. The renderer's thinking slider writes `pending` via
 * AgentSession.setActiveTurnThinkingLevel; StreamManager consumes it at the
 * next prepareStep (which runs before every model step, including step 1, so
 * changes during the PREPARING window apply to the turn's first request).
 *
 * Node-runtime-local: carries a callback, so it does not belong in
 * src/common/types (never crosses IPC).
 */
import type { ModelMessage } from "ai";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";
import type { ThinkingLevel } from "@/common/types/thinking";

/** What an Auto-routed stream is running on right now, as StreamManager's stream state has it. */
export interface LiveTurnRouting {
  model: string;
  thinkingLevel: ThinkingLevel | undefined;
  autoModelRouting: AutoModelRoutingRecord;
}

export interface ActiveTurnThinkingOverride {
  /** Raw level requested mid-turn; consumed at the next prepareStep (incl. step 1). */
  pending?: ThinkingLevel;
  /**
   * The user moved the slider during this turn. Auto's stuck-turn escalation
   * (autoThinkingEscalation.ts) writes `pending` too, but defers to the user for
   * the rest of the turn once this is set.
   */
  manual?: boolean;
  /** Effective level after the most recent successful application. */
  applied?: ThinkingLevel;
  /** Sink wired by StreamManager to the owning streamInfo (metadata). */
  onApplied?: (level: ThinkingLevel) => void;
  /**
   * Sink wired by AgentSession for Auto-routed turns: StreamManager reports every mid-turn
   * change to what the stream runs on (an applied slider move or Auto raise, a refusal
   * fallback). The session's stream context is what a mid-stream compaction follow-up is
   * built from after the stream is stopped, so it must follow, or the resumed turn drops
   * back to the tier's model and level and re-arms a claim the user withdrew.
   */
  onLiveRoutingChanged?: (live: LiveTurnRouting) => void;
}

/**
 * Result of rebuilding provider options for a mid-turn thinking-level change.
 * `null` from the rebuild closure means "not applicable / no-op" (e.g. the
 * clamped level equals the current one, or the transition would require a
 * different model instance) — the pending override is then dropped for this
 * turn and the persisted setting still covers the next turn.
 */
export interface RebuiltThinkingProviderOptions {
  effectiveLevel: ThinkingLevel;
  providerOptions: Record<string, unknown>;
}

export type RebuildProviderOptionsForThinkingLevel = (
  level: ThinkingLevel
) => RebuiltThinkingProviderOptions | null;

/**
 * Step-0 message rebuild for a thinking override consumed after stream
 * construction (a slider write can race startStream's awaits, landing after
 * the pre-construction quiescence fold). Message preparation is
 * thinking-level-dependent, so an options-only rebuild would send messages
 * transformed for the wrong mode. Returns the fully prepared first-step
 * messages; implementations also emit a superseding turn envelope so replay
 * matches the wire request.
 */
export type RebuildFirstStepForThinkingLevel = (
  effectiveLevel: ThinkingLevel,
  providerOptions: Record<string, unknown>
) => Promise<ModelMessage[]>;
