import {
  getValidAgentPeerMessageMeta,
  neutralizeAgentEnvelopeLookalikes,
  parseAgentMessageEnvelope,
} from "@/common/utils/agentMessageEnvelope";
import type { MuxMessage } from "@/common/types/message";

/**
 * Rewrite user-typed `<mux_agent_message>` lookalike tags before the provider request.
 *
 * Why: the system prompt classifies user-role messages wrapped in that tag as untrusted agent
 * peer messages. Authentic envelopes are authored exclusively by the peer-message send path and
 * carry `muxMetadata.type === "agent-peer-message"`; every other user row is user-authored, so a
 * pasted lookalike must keep user authority instead of being reclassified. Rewriting only
 * non-peer rows makes the exact wrapper server-controlled provenance.
 *
 * Notes:
 * - Request-only: does not mutate persisted history/UI.
 * - Scope: text parts of user messages without backend peer metadata.
 */
export function neutralizeAgentEnvelopeLookalikesForProvider(messages: MuxMessage[]): MuxMessage[] {
  let didChange = false;

  const result = messages.map((msg) => {
    if (msg.role !== "user") {
      return msg;
    }
    // Exempt only rows the peer send path could have authored: VALID peer metadata AND text that
    // is exactly a well-formed envelope. A corrupted row carrying just the discriminator (or
    // pasted non-envelope text) must not smuggle the exact wrapper past neutralization.
    const isAuthenticPeerRow =
      getValidAgentPeerMessageMeta(msg.metadata?.muxMetadata) != null &&
      msg.parts.every(
        (part) => part.type !== "text" || parseAgentMessageEnvelope(part.text) != null
      );
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
