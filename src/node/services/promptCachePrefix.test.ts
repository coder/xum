import { describe, expect, test } from "bun:test";
import {
  comparePromptCachePrefix,
  describePromptCacheBreak,
  fingerprintAnthropicRequest,
  type PromptCachePrefixBreak,
} from "./promptCachePrefix";

interface Message {
  role: string;
  content: unknown[];
}
const MARKER = { cache_control: { type: "ephemeral" } };
const TOOLS = [
  { name: "read_file", input_schema: { type: "object" } },
  { name: "bash", input_schema: { type: "object" } },
];
const call = (id: string, name: string) => ({ type: "tool_use", id, name, input: { id } });
const result = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });

/** Turn 1 so far: the user asked and the model read a file. */
function baseMessages(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "Summarize README.md" }] },
    { role: "assistant", content: [call("c1", "read_file")] },
    { role: "user", content: [result("c1", "x".repeat(15_000))] },
  ];
}

/** Mirrors the wire wrapper: cache markers on the last tool, the system block and the last block. */
function body(messages: Message[], tools: object[] = TOOLS, system = "You are Xum.") {
  const marked = structuredClone(messages);
  Object.assign(marked.at(-1)?.content.at(-1) ?? {}, MARKER);
  return {
    tools: tools.map((tool, index) => (index === tools.length - 1 ? { ...tool, ...MARKER } : tool)),
    system: [{ type: "text", text: system, ...MARKER }],
    messages: marked,
  };
}

function compare(previous: Record<string, unknown>, next: Record<string, unknown>) {
  return comparePromptCachePrefix(
    fingerprintAnthropicRequest(previous),
    fingerprintAnthropicRequest(next)
  );
}

function expectBreak(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const comparison = compare(previous, next);
  if (comparison.kind !== "break") throw new Error("expected a prefix break");
  return comparison satisfies PromptCachePrefixBreak;
}

// Blocks before the conversation's third content block: 2 tools, 1 system, user text, tool_use.
const FIRST_RESULT_INDEX = 5;

describe("comparePromptCachePrefix", () => {
  test("an appended step extends the prefix even though the cache markers moved", () => {
    const next = [
      ...baseMessages(),
      { role: "assistant", content: [call("c2", "bash")] },
      { role: "user", content: [result("c2", "README.md")] },
    ];
    expect(compare(body(baseMessages()), body(next))).toEqual({ kind: "extends" });
  });

  test("next turn's user text merged into the previous user message still extends", () => {
    const merged = baseMessages();
    merged[2].content.push({ type: "text", text: "Now fix the typo" });
    expect(compare(body(baseMessages()), body(merged)).kind).toBe("extends");
  });

  test("the gateway prompt form ignores providerOptions cache markers", () => {
    const gateway = (marker: boolean, extra: unknown[]) => ({
      tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }],
      prompt: [
        { role: "system", content: "You are Xum." },
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
          ...(marker
            ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
            : {}),
        },
        ...extra,
      ],
    });
    const step = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash" }],
    };
    expect(compare(gateway(true, []), gateway(false, [step])).kind).toBe("extends");
  });

  test("a truncated tool result breaks at that result and names its tool", () => {
    const truncated = baseMessages();
    truncated[2].content = [result("c1", "x".repeat(12_000))];
    const comparison = expectBreak(body(baseMessages()), body(truncated));
    expect(comparison).toMatchObject({
      section: "messages",
      blockIndex: FIRST_RESULT_INDEX,
      previous: { role: "user", type: "tool_result", toolName: "read_file" },
      next: { role: "user", type: "tool_result", toolName: "read_file" },
    });
    expect(comparison.previous.length - comparison.next!.length).toBe(3_000);
  });

  test("sequential steps replayed as one parallel call break where the steps merged", () => {
    const steps = [
      ...baseMessages(),
      { role: "assistant", content: [call("c2", "bash")] },
      { role: "user", content: [result("c2", "README.md")] },
    ];
    const merged = [
      steps[0],
      { role: "assistant", content: [...steps[1].content, ...steps[3].content] },
      { role: "user", content: [...steps[2].content, ...steps[4].content] },
    ];
    expect(expectBreak(body(steps), body(merged))).toMatchObject({
      section: "messages",
      blockIndex: FIRST_RESULT_INDEX,
      previous: { role: "user", type: "tool_result", toolName: "read_file" },
      next: { role: "assistant", type: "tool_use", toolName: "bash" },
    });
  });

  test("a tool connected late breaks in the tools section", () => {
    const tools = [...TOOLS, { name: "mcp_search", input_schema: { type: "object" } }];
    expect(expectBreak(body(baseMessages()), body(baseMessages(), tools))).toMatchObject({
      section: "tools",
      blockIndex: TOOLS.length,
      previous: { role: "system", type: "text" },
      next: { role: "tool", type: "tool", toolName: "mcp_search" },
    });
  });

  test("an edited system block breaks in the system section without leaking its text", () => {
    const edited = body(baseMessages(), TOOLS, "You are Xum. Today is Monday.");
    const comparison = expectBreak(body(baseMessages()), edited);
    expect(comparison).toMatchObject({ section: "system", blockIndex: TOOLS.length });
    expect(describePromptCacheBreak(comparison)).not.toContain("Monday");
  });

  test("the default direct tool caller echoed in-turn still extends; another caller breaks", () => {
    // In-turn steps echo Anthropic's `caller: { type: "direct" }`; the rebuild omits it.
    const inTurn = baseMessages();
    Object.assign(inTurn[1].content[0] as object, { caller: { type: "direct" } });
    const rebuilt = [
      ...baseMessages(),
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];
    expect(compare(body(inTurn), body(rebuilt)).kind).toBe("extends");

    // The AI SDK prompt form carries it in providerOptions.anthropic.
    const promptCall = (extra: object) => ({
      tools: TOOLS,
      prompt: [
        { role: "user", content: [{ type: "text", text: "Read it" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {}, ...extra }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c1", toolName: "bash", output: {}, ...extra },
          ],
        },
      ],
    });
    expect(
      compare(
        promptCall({ providerOptions: { anthropic: { caller: { type: "direct" } } } }),
        promptCall({})
      ).kind
    ).toBe("extends");

    const programmatic = baseMessages();
    Object.assign(programmatic[1].content[0] as object, {
      caller: { type: "code_execution_20250825", tool_id: "srv_1" },
    });
    expect(compare(body(programmatic), body(rebuilt))).toMatchObject({
      kind: "break",
      blockIndex: TOOLS.length + 2,
    });
  });

  test("a shorter next request breaks with no next block", () => {
    const comparison = expectBreak(body(baseMessages()), body(baseMessages().slice(0, 2)));
    expect(comparison).toMatchObject({
      blockIndex: FIRST_RESULT_INDEX,
      previous: { type: "tool_result" },
    });
    expect(comparison.next).toBeUndefined();
  });
});
