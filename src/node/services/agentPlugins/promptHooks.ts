/**
 * The prompt hook points as typed calls: `message.send` (the Codex UserPromptSubmit event) and
 * `turn.stop` (the Codex Stop event).
 *
 * Consumers (plugin hook runners) register middleware on the event spine, ordered by plugin
 * discovery index: `useBefore("message.send", ...)` and `useBefore("turn.stop", ...)`. AIService
 * runs each chain; AgentSession applies the outcome (runPluginSendHooks, runTurnStopHooks).
 *
 * Fail-open, like every plugin hook: a throwing chain changes nothing and never blocks a send.
 */
import type {
  EventSpine,
  MessageSendContext,
  MessageSendOrigin,
  TurnStopContext,
  TurnStopContinueReason,
} from "@/node/services/events/eventSpine";
import { MAX_STOP_HOOK_CONTINUATIONS } from "@/constants/pluginHooks";
import type { PluginHookContextEntry } from "@/common/types/message";
import type { CompletedMessagePart } from "@/common/types/stream";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import {
  PLUGIN_HOOK_CONTEXT_MAX_CHARS,
  renderPluginHookContextEntry,
} from "@/node/utils/messages/renderPluginHookContextForProvider";

/** Block reasons are shown to the user; longer ones are cut. */
const MESSAGE_SEND_BLOCK_REASON_MAX_CHARS = 500;

export type MessageSendHookOutcome =
  | { kind: "none" }
  | { kind: "context"; entries: PluginHookContextEntry[] }
  | { kind: "blocked"; pluginName: string; reason: string };

export interface MessageSendHookInput {
  text: string;
  origin: MessageSendOrigin;
  /**
   * False for sends no plugin may refuse (automatic senders retry a refused send, so a block
   * would loop). Their blocks are ignored as they are set, so the chain keeps running: every
   * later hook still sees the send, independent of plugin order.
   */
  canBlock: boolean;
}

export async function runMessageSendHooks(
  spine: EventSpine,
  workspaceId: string,
  input: MessageSendHookInput & { cwd?: string; signal?: AbortSignal }
): Promise<MessageSendHookOutcome> {
  if (!spine.hasMiddlewareFor("message.send", workspaceId)) return { kind: "none" };
  const base = {
    workspaceId,
    origin: input.origin,
    text: input.text,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    signal: input.signal,
    additionalContext: [],
  };
  const ctx: MessageSendContext = input.canBlock
    ? base
    : {
        ...base,
        // useBefore ends the chain when `blocked` reads as set, so it never does here.
        get blocked() {
          return undefined;
        },
        set blocked(block: MessageSendContext["blocked"]) {
          if (block == null) return;
          log.warn("Prompt hooks: ignoring a block of an automatic send", {
            workspaceId,
            plugin: block.pluginName,
            origin: input.origin,
          });
        },
      };
  try {
    await spine.run("message.send", ctx);
  } catch (error) {
    log.warn("Prompt hooks: message.send failed; sending the message unchanged", {
      workspaceId,
      error: getErrorMessage(error),
    });
    return { kind: "none" };
  }
  if (ctx.blocked != null) {
    const reason = ctx.blocked.reason.trim() || "No reason given.";
    return {
      kind: "blocked",
      pluginName: ctx.blocked.pluginName,
      reason: reason.slice(0, MESSAGE_SEND_BLOCK_REASON_MAX_CHARS),
    };
  }
  const kept = capContextEntries(ctx.additionalContext, workspaceId);
  return kept.length > 0 ? { kind: "context", entries: kept } : { kind: "none" };
}

/** The non-blank entries, trimmed, in chain order, up to the rendered per-message cap. */
function capContextEntries(
  entries: readonly PluginHookContextEntry[],
  workspaceId: string
): PluginHookContextEntry[] {
  const kept: PluginHookContextEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const text = entry.text.trim();
    if (text.length === 0) continue;
    // Charge the whole rendered block (plugin ID, wrapper, escaping), not just the text: many
    // tiny entries or a long plugin ID must not slip past the cap. Escaping never shrinks text,
    // so the raw length is a lower bound: check it first, so a huge text is never escaped
    // (Codex PRRT_kwDOPxxmWM6reh6U, the rule persisted entries follow).
    const rendered =
      size + entry.pluginId.length + text.length > PLUGIN_HOOK_CONTEXT_MAX_CHARS
        ? Infinity
        : renderPluginHookContextEntry({ pluginId: entry.pluginId, text }).length;
    if (size + rendered > PLUGIN_HOOK_CONTEXT_MAX_CHARS) {
      log.warn("Prompt hooks: message.send context over the cap; dropping the rest", {
        workspaceId,
      });
      break;
    }
    kept.push({ pluginId: entry.pluginId, text });
    size += rendered;
  }
  return kept;
}

/** turn.stop reply text is cut to this length. */
const TURN_STOP_TEXT_MAX_CHARS = 16 * 1024;
const LEADING_LONE_LOW_SURROGATE = /^[\uDC00-\uDFFF]/;
/** A continuation prompt is a new user row; longer prompts are cut. */
export const TURN_STOP_PROMPT_MAX_CHARS = 32_000;

/** `halted`: a consumer said `continue: false`, so nothing (not even Xum's own nudges) continues. */
export type TurnStopHookOutcome =
  | { kind: "none" }
  | { kind: "halted" }
  | {
      kind: "continue";
      /** Trimmed, in chain order, each hook under its limit. joinTurnStopReasons builds the prompt. */
      reasons: TurnStopContinueReason[];
    };

export type TurnStopHookInput = Pick<
  TurnStopContext,
  | "messageId"
  | "lastAssistantMessage"
  | "model"
  | "turnContinuations"
  | "hookContinuations"
  | "abortSignal"
>;

/**
 * Runs the chain, then drops each reason whose hook reached its limit (its `loopLimit`, or the
 * shared default). The per-user-turn ceiling is the caller's.
 */
export async function runTurnStopHooks(
  spine: EventSpine,
  workspaceId: string,
  input: TurnStopHookInput & Pick<TurnStopContext, "cwd">
): Promise<TurnStopHookOutcome> {
  if (!spine.hasMiddlewareFor("turn.stop", workspaceId)) return { kind: "none" };
  const ctx: TurnStopContext = {
    workspaceId,
    ...input,
    stopHookActive: input.turnContinuations > 0,
    continueReasons: [],
  };
  try {
    await spine.run("turn.stop", ctx);
  } catch (error) {
    log.warn("Prompt hooks: turn.stop failed; ending the turn", {
      workspaceId,
      error: getErrorMessage(error),
    });
    return { kind: "none" };
  }
  // Codex: a `continue: false` from any Stop hook wins over every continuation.
  if (ctx.halted != null) return { kind: "halted" };
  const kept = ctx.continueReasons
    .map((reason) => ({ ...reason, text: reason.text.trim() }))
    .filter(
      (reason) => reason.text.length > 0 && hasContinuationsLeft(reason, input.hookContinuations)
    );
  return kept.length > 0 ? { kind: "continue", reasons: kept } : { kind: "none" };
}

const REASON_SEPARATOR = "\n\n";

/**
 * The reasons' prompt, cut to `maxChars`, and the hooks it continues: only those with some text
 * left after the cut, so a hook whose whole reason was cut away neither counts nor is named.
 */
export function joinTurnStopReasons(
  reasons: readonly TurnStopContinueReason[],
  maxChars: number
): { prompt: string; hookKeys: string[]; pluginNames: string[] } {
  // slice(0, negative) would cut from the end: no room means no reason text at all.
  const prompt = reasons
    .map((reason) => reason.text)
    .join(REASON_SEPARATOR)
    .slice(0, Math.max(0, maxChars));
  let start = 0;
  const inPrompt = reasons.filter((reason) => {
    const kept = start < prompt.length;
    start += reason.text.length + REASON_SEPARATOR.length;
    return kept;
  });
  return {
    prompt,
    hookKeys: [...new Set(inPrompt.map((reason) => reason.hookKey))],
    pluginNames: [...new Set(inPrompt.map((reason) => reason.pluginName))],
  };
}

function hasContinuationsLeft(
  reason: TurnStopContinueReason,
  counts: ReadonlyMap<string, number>
): boolean {
  if (reason.loopLimit === null) return true;
  const limit = reason.loopLimit ?? MAX_STOP_HOOK_CONTINUATIONS;
  return (counts.get(reason.hookKey) ?? 0) < limit;
}

/**
 * The reply's trailing text run (Codex last_assistant_message). Text before a later tool call is
 * an intermediate step, not the reply, so a turn that ends on a tool part gets null (#6067).
 * Reasoning parts are skipped. Taken from the stream-end parts, not a history read, so rows
 * appended after the reply cannot hide it (#6062). A long run keeps its end, because a completion
 * promise sits at the end of a reply.
 */
export function lastAssistantText(parts: readonly CompletedMessagePart[]): string | null {
  let text = "";
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part.type === "reasoning") continue;
    if (part.type !== "text") break;
    text = part.text + text;
  }
  if (text.trim().length === 0) return null;
  return text.slice(-TURN_STOP_TEXT_MAX_CHARS).replace(LEADING_LONE_LOW_SURROGATE, "");
}
