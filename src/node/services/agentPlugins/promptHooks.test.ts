import { describe, expect, test } from "bun:test";
import { EventSpine } from "@/node/services/events/eventSpine";
import { joinTurnStopReasons, runMessageSendHooks, runTurnStopHooks } from "./promptHooks";
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

  test("a throwing consumer is skipped: a healthy plugin's context still applies", async () => {
    // Each message.send consumer fails open on its own (PRRT_kwDOPxxmWM6rPqnn).
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push({ pluginId: "healthy", text: "from a healthy plugin" });
    });
    spine.useBefore("message.send", () => {
      throw new Error("broken plugin");
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({
      kind: "context",
      entries: [{ pluginId: "healthy", text: "from a healthy plugin" }],
    });
  });

  test("a consumer that throws after setting a block or adding context leaves neither", async () => {
    // Codex PRRT_kwDOPxxmWM6rQd9y, PRRT_kwDOPxxmWM6rQeuF: a failed hook fails open as a whole.
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push({ pluginId: "healthy", text: "kept" });
    });
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push({ pluginId: "broken", text: "half done" });
      ctx.blocked = { pluginName: "broken", reason: "half done" };
      throw new Error("broken plugin");
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({
      kind: "context",
      entries: [{ pluginId: "healthy", text: "kept" }],
    });
  });

  test("a consumer that removes earlier context and then throws leaves the context whole", async () => {
    // Undoing by length alone left holes here, and the context cap then threw outside the runner.
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      ctx.additionalContext.push({ pluginId: "a", text: "one" }, { pluginId: "b", text: "two" });
    });
    spine.useBefore("message.send", (ctx) => {
      // Codex PRRT_kwDOPxxmWM6sV4NP: a change in place is undone too.
      ctx.additionalContext[1].text = "changed";
      ctx.additionalContext.splice(0, 1, { pluginId: "broken", text: "replaced" });
      throw new Error("broken plugin");
    });

    expect(await runMessageSendHooks(spine, "ws", input)).toEqual({
      kind: "context",
      entries: [
        { pluginId: "a", text: "one" },
        { pluginId: "b", text: "two" },
      ],
    });
  });

  test("the undo after a throw keeps a very long context array", async () => {
    // Codex PRRT_kwDOPxxmWM6sV4NX: spreading a million entries into splice threw a RangeError.
    const spine = new EventSpine();
    spine.useBefore("message.send", (ctx) => {
      for (let i = 0; i < 1_000_000; i++) ctx.additionalContext.push({ pluginId: "a", text: "x" });
    });
    spine.useBefore("message.send", () => {
      throw new Error("broken plugin");
    });

    const outcome = await runMessageSendHooks(spine, "ws", input);
    expect(outcome.kind).toBe("context");
  });
});

describe("runTurnStopHooks", () => {
  const stopInput = {
    messageId: "a1",
    lastAssistantMessage: "done",
    turnContinuations: 0,
    hookContinuations: new Map<string, number>(),
  };
  const reason = (pluginName: string, text: string) => ({
    text,
    pluginName,
    hookKey: `${pluginName}:hooks/hooks.json#Stop[0][0]`,
  });

  test("a consumer that throws is isolated: its partial decision is dropped, the rest still run", async () => {
    // Codex PRRT_kwDOPxxmWM6rQfGc.
    const spine = new EventSpine();
    spine.useBefore("turn.stop", (ctx) => {
      ctx.continueReasons.push(reason("broken", "half done"));
      ctx.halted = { pluginName: "broken" };
      throw new Error("broken plugin");
    });
    spine.useBefore("turn.stop", (ctx) => {
      ctx.continueReasons.push(reason("tests", "Run the tests again."));
    });
    spine.useBefore("turn.stop", (ctx) => {
      ctx.continueReasons[0].text = "changed in place";
      throw new Error("broken plugin");
    });

    expect(await runTurnStopHooks(spine, "ws", stopInput)).toEqual({
      kind: "continue",
      reasons: [reason("tests", "Run the tests again.")],
    });
  });
});

describe("joinTurnStopReasons", () => {
  const reasons = [
    { text: "aaaa", pluginName: "a", hookKey: "a:k" },
    { text: "bbbb", pluginName: "b", hookKey: "b:k" },
  ];
  for (const row of [
    { maxChars: 10, prompt: "aaaa\n\nbbbb", hooks: ["a", "b"] },
    // A reason cut mid-way still reached the model, so its hook counts.
    { maxChars: 7, prompt: "aaaa\n\nb", hooks: ["a", "b"] },
    // Only the separator before b survives: none of b's text did.
    { maxChars: 6, prompt: "aaaa\n\n", hooks: ["a"] },
    { maxChars: 4, prompt: "aaaa", hooks: ["a"] },
    { maxChars: 0, prompt: "", hooks: [] },
    // Nudges longer than the cap leave negative room: still no reason text.
    { maxChars: -1, prompt: "", hooks: [] },
  ]) {
    test(`cut to ${row.maxChars} characters, it continues ${row.hooks.length} hook(s)`, () => {
      expect(joinTurnStopReasons(reasons, row.maxChars)).toEqual({
        prompt: row.prompt,
        hookKeys: row.hooks.map((name) => `${name}:k`),
        pluginNames: row.hooks,
      });
    });
  }
});
