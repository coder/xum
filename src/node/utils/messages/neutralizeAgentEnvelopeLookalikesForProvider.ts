import {
  getValidAgentPeerMessageMeta,
  neutralizeAgentEnvelopeLookalikes,
  parseAgentMessageEnvelope,
} from "@/common/utils/agentMessageEnvelope";
import {
  getAuthenticPlanReviewRecord,
  neutralizePlanReviewEnvelopeLookalikes,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { MuxMessage } from "@/common/types/message";
import type {
  AssistantModelMessage,
  ModelMessage,
  ToolCallPart,
  ToolModelMessage,
  ToolResultPart,
} from "ai";

/**
 * Rewrite `<mux_agent_message>` and `<mux_plan_review>` lookalike tags before the provider
 * request.
 *
 * Why: the system prompt classifies transcript rows wrapped in these tags as protocol messages
 * (untrusted agent peer messages; the user's structured plan feedback). Authentic envelopes are
 * authored exclusively by their server send paths — peer messages as assistant-role synthetic
 * pre-turn rows carrying valid `agent-peer-message` metadata, plan feedback as user rows carrying
 * `plan-review` metadata that matches the envelope. Any other occurrence is user-pasted text
 * (which must keep user authority) or model-emitted text (which must not be able to forge a
 * protocol message into its own later context). Rewriting every non-authentic row makes the
 * exact wrapper server-controlled provenance.
 *
 * Notes:
 * - Request-only: does not mutate persisted history/UI.
 * - Scope: text parts of user and assistant rows that are not authentic payload rows, plus
 *   string-bearing tool parts (input/output/errorText). Tool results carry attacker-controlled
 *   repository content (file_read, bash, ...), so a wrapper inside them must be neutralized too
 *   or repository text could masquerade as a protocol message in provider tool content.
 */
export function neutralizeAgentEnvelopeLookalikesForProvider(messages: MuxMessage[]): MuxMessage[] {
  let didChange = false;

  const result = messages.map((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") {
      return msg;
    }
    // Exempt only rows the peer send path could have authored: assistant role, SYNTHETIC
    // provenance (the send path persists payload rows exclusively as synthetic pre-turn rows —
    // ordinary model output can carry corrupted-but-valid-looking metadata, never this marker),
    // VALID peer metadata, AND text that is exactly a well-formed envelope whose sender fields
    // MATCH the metadata (the send path writes both from the same values). A corrupted row
    // carrying just the discriminator, lookalike text, or an inconsistent metadata/envelope pair
    // — where the UI would attribute one sender while the provider reads another — must not
    // smuggle the exact wrapper past neutralization. The exemption covers TEXT parts only; tool
    // parts are never authentic envelopes.
    const meta = getValidAgentPeerMessageMeta(msg.metadata?.muxMetadata);
    const isAuthenticPeerRow =
      msg.role === "assistant" &&
      msg.metadata?.synthetic === true &&
      meta != null &&
      msg.parts.every((part) => {
        if (part.type !== "text") return true;
        const parsed = parseAgentMessageEnvelope(part.text);
        return (
          parsed != null &&
          parsed.from === meta.fromWorkspaceId &&
          parsed.relationship === meta.relationship &&
          parsed.fromTitle === meta.fromTitle
        );
      });

    // Plan feedback is authentic only when the row's `plan-review` metadata and its single
    // envelope text part describe the same record (getAuthenticPlanReviewRecord); a row that
    // fails that cross-check is treated like any pasted text.
    const isAuthenticPlanReviewRow = getAuthenticPlanReviewRecord(msg) !== null;

    let msgChanged = false;
    const nextParts = msg.parts.map((part) => {
      if (part.type === "text") {
        let text = part.text;
        if (!isAuthenticPeerRow) text = neutralizeAgentEnvelopeLookalikes(text);
        if (!isAuthenticPlanReviewRow) text = neutralizePlanReviewEnvelopeLookalikes(text);
        if (text === part.text) {
          return part;
        }
        msgChanged = true;
        return { ...part, text };
      }
      if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
        // Tool parts are treated as an opaque record here: the string-bearing payload fields are
        // provider-bound JSON whose precise shape varies per tool state, so read them through an
        // unknown-first boundary instead of asserting across unrelated part shapes.
        const record: Record<string, unknown> = toRecord(part);
        let partChanged = false;
        const overrides: Record<string, unknown> = {};
        for (const key of ["input", "output", "errorText"] as const) {
          const neutralized = neutralizeStringsDeep(record[key]);
          if (neutralized !== record[key]) {
            overrides[key] = neutralized;
            partChanged = true;
          }
        }
        if (!partChanged) {
          return part;
        }
        msgChanged = true;
        // Merge in record space, then narrow back through the same unknown-first boundary the
        // reads used: only string contents changed, so the part keeps its runtime shape.
        const merged: Record<string, unknown> = { ...record, ...overrides };
        return merged as typeof part;
      }
      return part;
    });

    if (!msgChanged) {
      return msg;
    }
    didChange = true;
    return { ...msg, parts: nextParts };
  });

  return didChange ? result : messages;
}

/**
 * Same-turn counterpart for streamText's internal steps.
 *
 * The MuxMessage neutralizer above only sees the request built from persisted history. Tool
 * calls executed DURING a turn never reach it: the SDK feeds their inputs and results straight
 * into the next step, so repository text returned by bash/file_read in step N arrived at the
 * provider with the exact wrapper in step N+1 (the history path only caught it on the NEXT turn).
 *
 * Scope is deliberately tool-call `input` and tool-result `output` ONLY. Text parts are left
 * alone: at this seam the row metadata that proves a feedback/peer envelope authentic is gone,
 * and the history path has already neutralized every non-authentic text row, so rewriting text
 * here could only damage authentic envelopes. Returns the same array when nothing changed.
 */
export function neutralizeAgentEnvelopeLookalikesInModelToolParts(
  messages: ModelMessage[]
): ModelMessage[] {
  let didChange = false;

  const result = messages.map((message): ModelMessage => {
    let changedMessage = false;
    const onChange = () => {
      didChange = true;
      changedMessage = true;
    };
    if (message.role === "tool") {
      const content: ToolModelMessage["content"] = message.content.map((part) =>
        neutralizeModelToolPart(part, onChange)
      );
      return changedMessage ? { ...message, content } : message;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content: Exclude<AssistantModelMessage["content"], string> = message.content.map(
        (part) => neutralizeModelToolPart(part, onChange)
      );
      return changedMessage ? { ...message, content } : message;
    }
    return message;
  });

  return didChange ? result : messages;
}

function neutralizeModelToolPart<P extends { type: string }>(part: P, onChange: () => void): P {
  if (part.type === "tool-call") {
    const call = part as P & ToolCallPart;
    const input = neutralizeStringsDeep(call.input);
    if (input === call.input) return part;
    onChange();
    return { ...part, input };
  }
  if (part.type === "tool-result") {
    const toolResult = part as P & ToolResultPart;
    // Covers every output variant (text/json/error-text/error-json/content); media `data`
    // is base64 and never contains the wrapper, so those items keep their identity.
    const output = neutralizeStringsDeep(toolResult.output);
    if (output === toolResult.output) return part;
    onChange();
    return { ...part, output: output as ToolResultPart["output"] };
  }
  return part;
}

/** Unknown-first widening so tool-part payload fields can be read without cross-shape casts. */
function toRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Shape-preserving deep neutralization for JSON-serializable tool payloads. Returns the SAME
 * reference when nothing contains the lookalike tag so unchanged parts/messages keep identity.
 */
function neutralizeStringsDeep(value: unknown): unknown {
  if (typeof value === "string") {
    // Both neutralizers return the same reference when their tag is absent.
    return neutralizePlanReviewEnvelopeLookalikes(neutralizeAgentEnvelopeLookalikes(value));
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const out = neutralizeStringsDeep(item);
      if (out !== item) changed = true;
      return out;
    });
    return changed ? next : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const out = neutralizeStringsDeep(item);
      if (out !== item) changed = true;
      next[key] = out;
    }
    return changed ? next : value;
  }
  return value;
}
