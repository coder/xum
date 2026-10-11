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
} from "@/node/services/events/eventSpine";
import type { PluginHookContextEntry } from "@/common/types/message";
import type { CompletedMessagePart } from "@/common/types/stream";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { renderPluginHookContextEntry } from "@/node/utils/messages/renderPluginHookContextForProvider";

/** Block reasons are shown to the user; longer ones are cut. */
const MESSAGE_SEND_BLOCK_REASON_MAX_CHARS = 500;
/** Total rendered context per message; entries past it are dropped (same cap as request.assemble). */
const MESSAGE_SEND_CONTEXT_MAX_CHARS = 64 * 1024;

export type MessageSendHookOutcome =
  | { kind: "none" }
  | { kind: "context"; entries: PluginHookContextEntry[] }
  | { kind: "blocked"; pluginName: string; reason: string };

export async function runMessageSendHooks(
  spine: EventSpine,
  workspaceId: string,
  input: { text: string; origin: MessageSendOrigin }
): Promise<MessageSendHookOutcome> {
  if (!spine.hasMiddleware("message.send")) return { kind: "none" };
  const ctx: MessageSendContext = {
    workspaceId,
    origin: input.origin,
    text: input.text,
    additionalContext: [],
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
  const kept: PluginHookContextEntry[] = [];
  let size = 0;
  for (const entry of ctx.additionalContext) {
    const text = entry.text.trim();
    if (text.length === 0) continue;
    // Charge the whole rendered block (plugin ID, wrapper, escaping), not just the text: many
    // tiny entries or a long plugin ID must not slip past the cap.
    const rendered = renderPluginHookContextEntry({ pluginId: entry.pluginId, text }).length;
    if (size + rendered > MESSAGE_SEND_CONTEXT_MAX_CHARS) {
      log.warn("Prompt hooks: message.send context over the cap; dropping the rest", {
        workspaceId,
      });
      break;
    }
    kept.push({ pluginId: entry.pluginId, text });
    size += rendered;
  }
  return kept.length > 0 ? { kind: "context", entries: kept } : { kind: "none" };
}

/** turn.stop reply text is cut to this length. */
const TURN_STOP_TEXT_MAX_CHARS = 16 * 1024;
/** A continuation prompt is a new user row; longer prompts are cut. */
const TURN_STOP_PROMPT_MAX_CHARS = 32_000;

export type TurnStopHookOutcome = { kind: "none" } | { kind: "continue"; prompt: string };

export async function runTurnStopHooks(
  spine: EventSpine,
  workspaceId: string,
  input: Pick<TurnStopContext, "messageId" | "lastAssistantMessage" | "stopHookActive">
): Promise<TurnStopHookOutcome> {
  if (!spine.hasMiddleware("turn.stop")) return { kind: "none" };
  const ctx: TurnStopContext = { workspaceId, ...input, continueReasons: [] };
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
  if (ctx.halted != null) return { kind: "none" };
  const prompt = ctx.continueReasons
    .map((reason) => reason.trim())
    .filter((reason) => reason.length > 0)
    .join("\n\n")
    .slice(0, TURN_STOP_PROMPT_MAX_CHARS);
  return prompt.length > 0 ? { kind: "continue", prompt } : { kind: "none" };
}

/**
 * The reply's trailing text run (Codex last_assistant_message). Text before a later tool call is
 * an intermediate step, not the reply, so a turn that ends on a tool part gets null (#6067).
 * Reasoning parts are skipped. Taken from the stream-end parts, not a history read, so rows
 * appended after the reply cannot hide it (#6062).
 */
export function lastAssistantText(parts: readonly CompletedMessagePart[]): string | null {
  let text = "";
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part.type === "reasoning") continue;
    if (part.type !== "text") break;
    text = part.text + text;
  }
  return text.trim().length > 0 ? text.slice(0, TURN_STOP_TEXT_MAX_CHARS) : null;
}
