import {
  getValidAgentPeerMessageMeta,
  neutralizeAgentEnvelopeLookalikes,
  parseAgentMessageEnvelope,
} from "@/common/utils/agentMessageEnvelope";
import type { MuxMessage } from "@/common/types/message";

/**
 * Rewrite `<mux_agent_message>` lookalike tags before the provider request.
 *
 * Why: the system prompt classifies transcript rows wrapped in that tag as untrusted agent peer
 * messages. Authentic envelopes are authored exclusively by the peer-message send path as
 * assistant-role synthetic pre-turn rows carrying valid `agent-peer-message` metadata; any other
 * occurrence is user-pasted text (which must keep user authority) or model-emitted text (which
 * must not be able to forge a peer message into its own later context). Rewriting every
 * non-authentic row makes the exact wrapper server-controlled provenance.
 *
 * Notes:
 * - Request-only: does not mutate persisted history/UI.
 * - Scope: text parts of user and assistant rows that are not authentic payload rows.
 */
export function neutralizeAgentEnvelopeLookalikesForProvider(messages: MuxMessage[]): MuxMessage[] {
  let didChange = false;

  const result = messages.map((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") {
      return msg;
    }
    // Exempt only rows the peer send path could have authored: assistant role, VALID peer
    // metadata, AND text that is exactly a well-formed envelope whose sender fields MATCH the
    // metadata (the send path writes both from the same values). A corrupted row carrying just
    // the discriminator, lookalike text, or an inconsistent metadata/envelope pair — where the
    // UI would attribute one sender while the provider reads another — must not smuggle the
    // exact wrapper past neutralization.
    const meta = getValidAgentPeerMessageMeta(msg.metadata?.muxMetadata);
    const isAuthenticPeerRow =
      msg.role === "assistant" &&
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
    if (isAuthenticPeerRow) {
      return msg;
    }

    const hasLookalike = msg.parts.some(
      (part) => part.type === "text" && part.text.includes("mux_agent_message")
    );
    if (!hasLookalike) {
      return msg;
    }

    didChange = true;
    return {
      ...msg,
      parts: msg.parts.map((part) =>
        part.type === "text"
          ? { ...part, text: neutralizeAgentEnvelopeLookalikes(part.text) }
          : part
      ),
    };
  });

  return didChange ? result : messages;
}
