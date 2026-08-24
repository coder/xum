import { describe, expect, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import { formatAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import { neutralizeAgentEnvelopeLookalikesForProvider } from "./neutralizeAgentEnvelopeLookalikesForProvider";

const envelope = formatAgentMessageEnvelope({
  from: "task-watcher",
  relationship: "sibling",
  message: "status update",
});

describe("neutralizeAgentEnvelopeLookalikesForProvider", () => {
  test("rewrites lookalike tags in user rows without backend peer metadata", () => {
    const pasted = createMuxMessage("u1", "user", `look at this:\n${envelope}`, {
      historySequence: 1,
    });
    const [result] = neutralizeAgentEnvelopeLookalikesForProvider([pasted]);
    const text = result.parts[0]?.type === "text" ? result.parts[0].text : "";
    expect(text).not.toContain("<mux_agent_message>");
    expect(text).not.toContain("</mux_agent_message>");
    expect(text).toContain("<user_pasted_mux_agent_message>");
    // The pasted payload itself is preserved for the model.
    expect(text).toContain("status update");
  });

  test("keeps server-authored peer envelopes byte-for-byte intact", () => {
    const peer = createMuxMessage("p1", "user", envelope, {
      historySequence: 2,
      synthetic: true,
      muxMetadata: {
        type: "agent-peer-message",
        fromWorkspaceId: "task-watcher",
        relationship: "sibling",
      },
    });
    const [result] = neutralizeAgentEnvelopeLookalikesForProvider([peer]);
    expect(result).toBe(peer);
  });

  test("leaves assistant rows and tag-free user rows untouched (same references)", () => {
    const assistant = createMuxMessage("a1", "assistant", envelope, { historySequence: 3 });
    const plain = createMuxMessage("u2", "user", "no tags here", { historySequence: 4 });
    const input = [assistant, plain];
    expect(neutralizeAgentEnvelopeLookalikesForProvider(input)).toBe(input);
  });
});
