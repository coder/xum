import { describe, expect, test } from "bun:test";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { maskTapeEvent } from "./contentMask";
import {
  reviveTapeEvent,
  STRUCTURAL_SENTINELS,
  syntheticChatEvents,
} from "./sessionTapes.testFixtures";

describe("maskTapeEvent (content-v1)", () => {
  test("masks letters and digits while keeping UTF-16 length and Markdown structure", () => {
    // é is one letter, 𝐀 is a supplementary-plane letter (two UTF-16 units), 😀 is a symbol.
    const delta = "Héllo, 𝐀b! 😀 42\n# Title\n- `code` [link](https://ex.am/p?q=1)";
    const event: WorkspaceChatMessage = {
      type: "stream-delta",
      workspaceId: "ws-1",
      messageId: "m-1",
      delta,
      tokens: 9,
      timestamp: 5,
    };

    const masked = maskTapeEvent(event);
    expect(masked).toEqual({
      ...event,
      delta: "xxxxx, xxx! 😀 00\n# xxxxx\n- `xxxx` [xxxx](xxxxx://xx.xx/x?x=0)",
    });
    expect((masked.delta as string).length).toBe(delta.length);
  });

  test("masks every content field and keeps structure verbatim across event types", () => {
    const events = syntheticChatEvents();
    const masked = events.map(maskTapeEvent);
    const text = JSON.stringify(masked);

    expect(text.toLowerCase()).not.toContain("secret");
    for (const sentinel of STRUCTURAL_SENTINELS) expect(text).toContain(sentinel);
    expect(masked.map((event) => event.type)).toEqual(events.map((event) => event.type));
  });

  test("masked synthetic events stay valid onChat events with nothing dropped by the schema", () => {
    for (const event of syntheticChatEvents()) {
      // As a replay loader sees it: stored as JSON, then Date fields revived.
      const stored = reviveTapeEvent(JSON.parse(JSON.stringify(maskTapeEvent(event))));
      const parsed = WorkspaceChatMessageSchema.safeParse(stored);
      expect(parsed.success).toBe(true);
      // `.catch()` fallbacks would silently drop fields; equality proves none were.
      expect(parsed.data).toEqual(stored as WorkspaceChatMessage);
    }
  });
});
