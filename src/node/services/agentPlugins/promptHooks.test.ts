import { describe, expect, test } from "bun:test";
import { EventSpine } from "@/node/services/events/eventSpine";
import { runMessageSendHooks } from "./promptHooks";

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
