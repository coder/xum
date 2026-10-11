import { describe, expect, test } from "bun:test";
import { EventSpine } from "@/node/services/events/eventSpine";
import { runMessageSendHooks } from "./promptHooks";
import { renderPluginHookContextEntry } from "@/node/utils/messages/renderPluginHookContextForProvider";

const input = { text: "hello", origin: "user" as const, canBlock: true };

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

  test("a send no plugin may block keeps the context added before an ignored block", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6rN8CX).
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push({ pluginId: "notes", text: "Read the runbook." });
    });
    spine.useBefore("message.send", (ctx) => {
      ctx.blocked = { pluginName: "guard", reason: "no" };
    });
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push({ pluginId: "later", text: "Also this." });
    });

    expect(
      await runMessageSendHooks(spine, "ws", { ...input, origin: "task", canBlock: false })
    ).toEqual({
      kind: "context",
      entries: [
        { pluginId: "notes", text: "Read the runbook." },
        { pluginId: "later", text: "Also this." },
      ],
    });
  });

  test("a throwing consumer cannot skip a later plugin's block", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rPqnn): one broken plugin must not bypass another's send policy.
    const spine = new EventSpine();
    spine.useBefore("message.send", () => {
      throw new Error("broken plugin");
    });
    spine.useBefore("message.send", (ctx) => {
      ctx.blocked = { pluginName: "guard", reason: "no secrets" };
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({
      kind: "blocked",
      pluginName: "guard",
      reason: "no secrets",
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
