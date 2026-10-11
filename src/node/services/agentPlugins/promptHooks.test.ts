import { describe, expect, test } from "bun:test";
import { EventSpine } from "@/node/services/events/eventSpine";
import { runMessageSendHooks } from "./promptHooks";
import { renderPluginHookContextEntry } from "@/node/utils/messages/renderPluginHookContextForProvider";

const input = { text: "hello", origin: "user" as const };

describe("runMessageSendHooks", () => {
  test("joins context in chain order and drops entries past the size cap", async () => {
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push(
        { pluginId: "a", text: " one " },
        { pluginId: "b", text: "   " },
        { pluginId: "c", text: "two" },
        { pluginId: "d", text: "x".repeat(64 * 1024) }
      );
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({
      kind: "context",
      entries: [
        { pluginId: "a", text: "one" },
        { pluginId: "c", text: "two" },
      ],
    });
  });

  test("the cap counts each rendered block, so many tiny entries cannot exceed it", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6rNI3i): counting only the text let 65,536 one-character entries
    // through, each rendered with its plugin ID and wrapper.
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      for (let i = 0; i < 64 * 1024; i++) ctx.additionalContext.push({ pluginId: "p", text: "x" });
    });

    const outcome = await runMessageSendHooks(spine, "ws", input);

    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    const renderedChars = outcome.entries
      .map(renderPluginHookContextEntry)
      .reduce((sum, block) => sum + block.length, 0);
    expect(renderedChars).toBeLessThanOrEqual(64 * 1024);
    expect(outcome.entries.length).toBeLessThan(64 * 1024);
  });

  test("a throwing consumer fails open: the message goes out unchanged", async () => {
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push({ pluginId: "healthy", text: "from a healthy plugin" });
    });
    spine.useBefore("message.send", () => {
      throw new Error("broken plugin");
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({ kind: "none" });
  });
});
