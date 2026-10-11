/**
 * The `message.send` prompt hook point (the Codex UserPromptSubmit event) as one typed call.
 *
 * Consumers (plugin hook runners) register `useBefore("message.send", ...)` middleware on the
 * event spine, ordered by plugin discovery index. AIService runs the chain once per new message;
 * AgentSession applies the outcome (see AgentSession.runPluginSendHooks).
 *
 * Fail-open, like every plugin hook: a throwing chain changes nothing and never blocks a send.
 */
import type {
  EventSpine,
  MessageSendContext,
  MessageSendOrigin,
} from "@/node/services/events/eventSpine";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

/** Block reasons are shown to the user; longer ones are cut. */
const MESSAGE_SEND_BLOCK_REASON_MAX_CHARS = 500;

export type MessageSendHookOutcome =
  | { kind: "none" }
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
  input: MessageSendHookInput
): Promise<MessageSendHookOutcome> {
  if (!spine.hasMiddleware("message.send")) return { kind: "none" };
  const base = { workspaceId, origin: input.origin, text: input.text };
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
  return { kind: "none" };
}
