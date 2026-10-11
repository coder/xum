import { describe, expect, test } from "bun:test";
import { EventSpine } from "@/node/services/events/eventSpine";
import { runMessageSendHooks } from "./promptHooks";

const input = { text: "hello", origin: "user" as const, canBlock: true };

describe("runMessageSendHooks", () => {
  test("the first block ends the chain; its reason is trimmed", async () => {
    const spine = new EventSpine();
    const seen: string[] = [];
    spine.useBefore("message.send", (ctx) => {
      seen.push("guard");
      ctx.blocked = { pluginName: "guard", reason: "  no secrets  " };
    });
    spine.useBefore("message.send", () => {
      seen.push("later");
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({
      kind: "blocked",
      pluginName: "guard",
      reason: "no secrets",
    });
    expect(seen).toEqual(["guard"]);
  });

  test("a send no plugin may block runs the whole chain and ignores every block", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6rN7oi): an ignored block must not hide the send from later hooks.
    const spine = new EventSpine();
    const seen: string[] = [];
    spine.useBefore("message.send", (ctx) => {
      seen.push("guard");
      ctx.blocked = { pluginName: "guard", reason: "no" };
    });
    spine.useBefore("message.send", (ctx) => {
      seen.push(`later:${ctx.blocked === undefined}`);
    });

    expect(
      await runMessageSendHooks(spine, "ws", { ...input, origin: "goal", canBlock: false })
    ).toEqual({ kind: "none" });
    expect(seen).toEqual(["guard", "later:true"]);
  });

  test("a throwing consumer fails open: the message goes out unchanged", async () => {
    const spine = new EventSpine();
    spine.useBefore("message.send", () => undefined);
    spine.useBefore("message.send", () => {
      throw new Error("broken plugin");
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({ kind: "none" });
  });
});
