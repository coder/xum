/**
 * Mid-turn thinking escalation for turns whose thinking level Auto chose.
 *
 * Auto classifies a prompt once, before the turn starts. When the model then gets
 * stuck (every tool call in the last few steps failed, or one identical call keeps
 * being replayed), the tier's thinking level was too low for this prompt, so the
 * remaining steps run one level higher instead of spinning. The signal is read
 * from the step transcript StreamManager already has, so it costs nothing until it
 * fires; no evaluator call runs per step. The user's slider always wins: a manual
 * mid-turn change (`ActiveTurnThinkingOverride.manual`) disables escalation for the
 * rest of the turn.
 *
 * Node-runtime-local like thinkingOverride.ts; the persisted shape is
 * `AutoModelRoutingEscalation` on the routing record.
 */
import type { ModelMessage } from "ai";
import type { AutoModelRoutingEscalation } from "@/common/types/autoModelRouting";
import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";
import { stableStringify } from "@/common/utils/stableStringify";
import {
  AUTO_THINKING_ESCALATION_MAX_PER_TURN,
  AUTO_THINKING_ESCALATION_WAIT_TOOLS,
  AUTO_THINKING_ESCALATION_WINDOW_STEPS,
} from "@/constants/autoModelRouting";

export interface AutoThinkingEscalationState {
  /** Level the remaining steps run at as far as escalation knows (tier level, then each raise). */
  level: ThinkingLevel;
  /** Tool steps already judged by an earlier raise; they never count toward the next one. */
  stepsJudged: number;
  /**
   * Raises carried from an earlier stream of this turn judged steps that a resume still has
   * in its transcript but a compaction follow-up does not (it starts behind a new boundary).
   * Until the first proposal sees the transcript, `stepsJudged` is the carried count and is
   * then clamped to the steps actually present.
   */
  judgedStepsCarried: boolean;
  /** Set once a raise could not be applied (model ceiling); later steps stop trying. */
  exhausted: boolean;
  escalations: AutoModelRoutingEscalation[];
  /** Persists the raises so far into the turn's routing record. */
  onEscalated: (escalations: AutoModelRoutingEscalation[]) => void;
}

/**
 * `escalations` seeds the per-turn cap from raises an earlier stream of the same turn
 * already applied (a resume or compaction follow-up carries them on its record), and the
 * judged-step boundary from the last raise (each records the step it applied to), so the
 * steps that earned an earlier raise cannot earn the next one again.
 */
export function createAutoThinkingEscalationState(
  level: ThinkingLevel,
  escalations: AutoModelRoutingEscalation[],
  onEscalated: AutoThinkingEscalationState["onEscalated"]
): AutoThinkingEscalationState {
  const lastRaise = escalations.at(-1);
  return {
    level,
    stepsJudged: lastRaise ? lastRaise.step - 1 : 0,
    judgedStepsCarried: lastRaise != null,
    exhausted: false,
    escalations,
    onEscalated,
  };
}

/** One model step of the current turn that called tools: its calls and how they ended. */
export interface TurnToolStep {
  calls: Array<{
    /** Tool name plus canonical input, so an identical replay compares equal. */
    key: string;
    toolName: string;
    /** Canonical result, once one arrived; equal keys mean the replay made no progress. */
    resultKey?: string;
    failed: boolean;
  }>;
  /** True when every result the step received was an error. */
  allFailed: boolean;
}

function isFailedToolOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const { type, value } = output as { type?: unknown; value?: unknown };
  if (type === "error-text" || type === "error-json") return true;
  // Mux tools report failures as ordinary JSON results ({ success: false, error }), the
  // same shapes the transcript marks as failed.
  if (type !== "json" || typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.success === false || ("error" in record && record.error != null);
}

/**
 * Tool steps of the current turn: the assistant/tool message pairs after the last user
 * message. Steps without tool calls (text-only answers) are not steps a stuck model
 * repeats, so they do not count.
 */
export function collectTurnToolSteps(messages: ModelMessage[]): TurnToolStep[] {
  let lastUserIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") lastUserIndex = index;
  }
  const steps: TurnToolStep[] = [];
  let current:
    | (TurnToolStep & { byCallId: Map<string, TurnToolStep["calls"][number]> })
    | undefined;
  for (const message of messages.slice(lastUserIndex + 1)) {
    if (message.role === "assistant") {
      current = undefined;
      if (typeof message.content === "string") continue;
      const calls = message.content.filter((part) => part.type === "tool-call");
      if (calls.length === 0) continue;
      current = { calls: [], byCallId: new Map(), allFailed: false };
      for (const call of calls) {
        const entry = {
          key: `${call.toolName}:${stableStringify(call.input)}`,
          toolName: call.toolName,
          failed: false,
        };
        current.calls.push(entry);
        current.byCallId.set(call.toolCallId, entry);
      }
      steps.push(current);
    } else if (message.role === "tool" && current) {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const entry = current.byCallId.get(part.toolCallId);
        if (entry == null) continue;
        entry.resultKey = stableStringify(part.output);
        entry.failed = isFailedToolOutput(part.output);
      }
      const answered = current.calls.filter((call) => call.resultKey != null);
      current.allFailed = answered.length > 0 && answered.every((call) => call.failed);
    }
  }
  return steps;
}

/** The stuck signal in the trailing window of steps, phrased for the badge; undefined when none. */
export function detectStuckReason(
  steps: TurnToolStep[],
  windowSteps = AUTO_THINKING_ESCALATION_WINDOW_STEPS
): string | undefined {
  if (steps.length < windowSteps) return undefined;
  const window = steps.slice(-windowSteps);
  if (window.every((step) => step.allFailed)) {
    return `${windowSteps} consecutive steps with only failing tool calls`;
  }
  // A replay counts only when it made no progress (same call, same result every time);
  // re-issuing a wait tool while a long task runs is what those tools are for.
  const [first, ...rest] = window;
  const replayed = first.calls.find(
    (call) =>
      call.resultKey != null &&
      !AUTO_THINKING_ESCALATION_WAIT_TOOLS.includes(call.toolName) &&
      rest.every((step) =>
        step.calls.some((other) => other.key === call.key && other.resultKey === call.resultKey)
      )
  );
  return replayed
    ? `the same ${replayed.toolName} call and result repeated ${windowSteps} times`
    : undefined;
}

export function nextThinkingLevel(level: ThinkingLevel): ThinkingLevel | undefined {
  return THINKING_LEVELS[THINKING_LEVELS.indexOf(level) + 1];
}

/**
 * Decide whether the step about to run should be raised, given the transcript so far.
 * Returns the raise to request; the caller applies it through the same override path
 * the slider uses and reports back with `recordAutoThinkingEscalation` or
 * `markAutoThinkingEscalationExhausted`.
 */
export function proposeAutoThinkingEscalation(
  state: AutoThinkingEscalationState,
  stepMessages: ModelMessage[]
): { from: ThinkingLevel; to: ThinkingLevel; step: number; reason: string } | undefined {
  if (state.exhausted || state.escalations.length >= AUTO_THINKING_ESCALATION_MAX_PER_TURN) {
    return undefined;
  }
  const steps = collectTurnToolSteps(stepMessages);
  if (state.judgedStepsCarried) {
    state.stepsJudged = Math.min(state.stepsJudged, steps.length);
    state.judgedStepsCarried = false;
  }
  const reason = detectStuckReason(steps.slice(state.stepsJudged));
  if (reason == null) return undefined;
  const to = nextThinkingLevel(state.level);
  if (to == null) {
    state.exhausted = true;
    return undefined;
  }
  // Whatever the outcome, these steps have had their say.
  state.stepsJudged = steps.length;
  return { from: state.level, to, step: steps.length + 1, reason };
}

export function recordAutoThinkingEscalation(
  state: AutoThinkingEscalationState,
  escalation: AutoModelRoutingEscalation
): void {
  state.level = escalation.to;
  state.escalations = [...state.escalations, escalation];
  state.onEscalated(state.escalations);
}

export function markAutoThinkingEscalationExhausted(state: AutoThinkingEscalationState): void {
  state.exhausted = true;
}

/**
 * A mid-turn model swap (refusal fallback) moves the level the stream runs at; later raises
 * climb from there, and a ceiling the refused model hit says nothing about the new one.
 */
export function rebaseAutoThinkingEscalation(
  state: AutoThinkingEscalationState,
  level: ThinkingLevel
): void {
  state.level = level;
  state.exhausted = false;
}
