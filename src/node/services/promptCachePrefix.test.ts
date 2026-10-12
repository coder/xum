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
function body(
  messages: Message[],
  tools: object[] = TOOLS,
  system = "You are Xum.",
  options: Record<string, unknown> = {}
) {
  const marked = structuredClone(messages);
  Object.assign(marked.at(-1)?.content.at(-1) ?? {}, MARKER);
  return {
    tools: tools.map((tool, index) => (index === tools.length - 1 ? { ...tool, ...MARKER } : tool)),
    system: [{ type: "text", text: system, ...MARKER }],
    messages: marked,
    ...options,
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

// Block order: 2 tools, the system sentinel, 1 system block, the messages
// sentinel, then the user text, the tool_use and the tool_result.
const SYSTEM_OPTIONS_INDEX = TOOLS.length;
const SYSTEM_INDEX = SYSTEM_OPTIONS_INDEX + 1;
const MESSAGE_OPTIONS_INDEX = SYSTEM_INDEX + 1;
const FIRST_TOOL_USE_INDEX = MESSAGE_OPTIONS_INDEX + 2;
const FIRST_RESULT_INDEX = FIRST_TOOL_USE_INDEX + 1;

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
      previous: { role: "request", type: "system_options" },
      next: { role: "tool", type: "tool", toolName: "mcp_search" },
    });
  });

  test("an edited system block breaks in the system section without leaking its text", () => {
    const edited = body(baseMessages(), TOOLS, "You are Xum. Today is Monday.");
    const comparison = expectBreak(body(baseMessages()), edited);
    expect(comparison).toMatchObject({ section: "system", blockIndex: SYSTEM_INDEX });
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
      blockIndex: FIRST_TOOL_USE_INDEX,
    });
  });

  test("unsigned reasoning the SDK drops is not a block; signed thinking is", () => {
    // The rebuild puts an unsigned "..." reasoning part before tool calls
    // (ensureAnthropicThinkingBeforeToolCalls); the AI SDK drops it before the wire.
    const promptWith = (reasoning: object[]) => ({
      tools: TOOLS,
      prompt: [
        { role: "user", content: [{ type: "text", text: "Read it" }] },
        {
          role: "assistant",
          content: [
            ...reasoning,
            { type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} },
          ],
        },
      ],
    });
    const placeholder = { type: "reasoning", text: "..." };
    expect(compare(promptWith([]), promptWith([placeholder])).kind).toBe("extends");
    expect(
      compare(
        promptWith([]),
        promptWith([{ ...placeholder, providerOptions: { anthropic: { cacheControl: {} } } }])
      ).kind
    ).toBe("extends");

    const signed = { ...placeholder, providerOptions: { anthropic: { signature: "sig" } } };
    expect(compare(promptWith([]), promptWith([signed]))).toMatchObject({ kind: "break" });
    const redacted = { ...placeholder, providerOptions: { anthropic: { redactedData: "x" } } };
    expect(compare(promptWith([]), promptWith([redacted]))).toMatchObject({ kind: "break" });
  });

  test("a system message's Anthropic options count; its cache marker does not", () => {
    const withOptions = (anthropic: object) => ({
      tools: TOOLS,
      prompt: [
        { role: "system", content: "You are Xum.", providerOptions: { anthropic } },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    });
    const marked = withOptions({ cacheControl: { type: "ephemeral" } });
    expect(compare(marked, withOptions({})).kind).toBe("extends");
    expect(compare(marked, withOptions({ clearAt: 2 }))).toMatchObject({
      kind: "break",
      section: "system",
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

describe("fingerprintAnthropicRequest follows Anthropic's cache invalidation table", () => {
  test.each([
    ["thinking", { thinking: { type: "enabled", budget_tokens: 4096 } }],
    ["output_config.effort", { output_config: { effort: "high" } }],
    ["tool_choice", { tool_choice: { type: "any" } }],
    [
      "disable_parallel_tool_use",
      { tool_choice: { type: "auto", disable_parallel_tool_use: true } },
    ],
  ])("changing %s breaks the messages cache, not tools or system", (_name, options) => {
    expect(
      expectBreak(body(baseMessages()), body(baseMessages(), TOOLS, undefined, options))
    ).toMatchObject({
      section: "messages",
      blockIndex: MESSAGE_OPTIONS_INDEX,
      previous: { role: "request", type: "message_options" },
    });
  });

  test("adding the first image breaks the messages cache; a later image extends", () => {
    const screenshot = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AA" },
    };
    const withImage = [
      ...baseMessages(),
      { role: "assistant", content: [call("c2", "computer")] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c2", content: [screenshot] }],
      },
    ];
    expect(expectBreak(body(baseMessages()), body(withImage))).toMatchObject({
      section: "messages",
      blockIndex: MESSAGE_OPTIONS_INDEX,
    });
    const another = [...withImage, { role: "user", content: [screenshot] }];
    expect(compare(body(withImage), body(another)).kind).toBe("extends");

    // The prompt form shows images as file parts with an image media type.
    const promptForm = (extra: unknown[]) => ({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }, ...extra],
    });
    const file = { type: "file", mediaType: "image/png", data: "AA" };
    expect(
      expectBreak(promptForm([]), promptForm([{ role: "user", content: [file] }]))
    ).toMatchObject({
      section: "messages",
      previous: { type: "message_options" },
    });
  });

  test("toggling native web search or citations breaks system, keeping every tool block", () => {
    const webSearch = { type: "web_search_20250305", name: "web_search", max_uses: 5 };
    expect(
      expectBreak(body(baseMessages()), body(baseMessages(), [...TOOLS, webSearch]))
    ).toMatchObject({ section: "system", blockIndex: SYSTEM_OPTIONS_INDEX });

    const promptTools = (extra: object[]) => ({
      tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }, ...extra],
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const providerTool = {
      type: "provider",
      id: "anthropic.web_fetch_20250910",
      name: "web_fetch",
      args: {},
    };
    expect(expectBreak(promptTools([]), promptTools([providerTool]))).toMatchObject({
      section: "system",
      blockIndex: 1,
    });

    const document = (citations: boolean) => [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "notes" },
            ...(citations ? { citations: { enabled: true } } : {}),
          },
        ],
      },
    ];
    expect(expectBreak(body(document(false)), body(document(true)))).toMatchObject({
      section: "system",
      blockIndex: SYSTEM_OPTIONS_INDEX,
    });
  });

  test("changing a native server tool's configuration breaks system, keeping every tool block", () => {
    const webSearch = (maxUses: number) => ({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: maxUses,
      ...MARKER,
    });
    expect(
      expectBreak(
        body(baseMessages(), [...TOOLS, webSearch(5)]),
        body(baseMessages(), [...TOOLS, webSearch(10)])
      )
    ).toMatchObject({ section: "system", blockIndex: SYSTEM_OPTIONS_INDEX });
    // The cache marker is not configuration. body() marks the last tool, so the
    // server tool goes first here.
    const { cache_control: _marker, ...unmarked } = webSearch(5);
    expect(
      compare(
        body(baseMessages(), [webSearch(5), ...TOOLS]),
        body(baseMessages(), [unmarked, ...TOOLS])
      ).kind
    ).toBe("extends");
  });

  test("switching Fast mode breaks system; an explicit standard speed is the default", () => {
    expect(
      expectBreak(body(baseMessages()), body(baseMessages(), TOOLS, undefined, { speed: "fast" }))
    ).toMatchObject({ section: "system", blockIndex: SYSTEM_OPTIONS_INDEX });
    expect(
      compare(body(baseMessages()), body(baseMessages(), TOOLS, undefined, { speed: "standard" }))
        .kind
    ).toBe("extends");
  });

  test("changing the structured-output format breaks system", () => {
    const format = (name: string) => ({
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: { type: "object", properties: { [name]: {} } } },
      },
    });
    expect(
      expectBreak(
        body(baseMessages(), TOOLS, undefined, format("a")),
        body(baseMessages(), TOOLS, undefined, format("b"))
      )
    ).toMatchObject({ section: "system", blockIndex: SYSTEM_OPTIONS_INDEX });
  });

  test("a request with server-side context editing is unsupported on either side", () => {
    const editing = {
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    };
    const plain = body(baseMessages());
    const withEditing = body(baseMessages(), TOOLS, undefined, editing);
    const unsupported = { kind: "unsupported", reason: "context_management" } as const;
    expect(compare(plain, withEditing)).toEqual(unsupported);
    expect(compare(withEditing, plain)).toEqual(unsupported);
    expect(compare(withEditing, withEditing)).toEqual(unsupported);
  });

  test("the first cited document inside a tool result breaks system", () => {
    const cited = {
      type: "search_result",
      source: "https://example.com",
      title: "Example",
      content: [{ type: "text", text: "notes" }],
      citations: { enabled: true },
    };
    const withResult = [
      ...baseMessages(),
      { role: "assistant", content: [call("c2", "search")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: [cited] }] },
    ];
    expect(expectBreak(body(baseMessages()), body(withResult))).toMatchObject({
      section: "system",
      blockIndex: SYSTEM_OPTIONS_INDEX,
    });

    // Prompt form: the tool-result output holds a document part with citations enabled.
    const promptForm = (extra: unknown[]) => ({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }, ...extra],
    });
    const document = {
      type: "file-data",
      data: "notes",
      mediaType: "text/plain",
      providerOptions: { anthropic: { citations: { enabled: true } } },
    };
    const toolResult = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "content", value: [document] },
        },
      ],
    };
    expect(expectBreak(promptForm([]), promptForm([toolResult]))).toMatchObject({
      section: "system",
      previous: { type: "system_options" },
    });
  });

  test("adding or changing a deferred tool extends the prefix", () => {
    const deferred = (description: string) => [
      ...TOOLS,
      { name: "zulip_send", description, input_schema: { type: "object" }, defer_loading: true },
    ];
    expect(compare(body(baseMessages()), body(baseMessages(), deferred("v1"))).kind).toBe(
      "extends"
    );
    expect(
      compare(body(baseMessages(), deferred("v1")), body(baseMessages(), deferred("v2"))).kind
    ).toBe("extends");

    const promptDeferred = {
      type: "function",
      name: "zulip_send",
      inputSchema: { type: "object" },
      providerOptions: { anthropic: { deferLoading: true } },
    };
    const promptBody = (tools: object[]) => ({
      tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }, ...tools],
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(compare(promptBody([]), promptBody([promptDeferred])).kind).toBe("extends");
  });

  test("a cache_control field inside a tool schema or tool input is application data", () => {
    const schema = (value: string) => [
      TOOLS[0],
      {
        name: "bash",
        input_schema: {
          type: "object",
          properties: { cache_control: { type: "string", description: value } },
        },
      },
    ];
    expect(
      expectBreak(body(baseMessages(), schema("a")), body(baseMessages(), schema("b")))
    ).toMatchObject({ section: "tools", blockIndex: 1 });

    const input = (value: string) => [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { cacheControl: value } }],
      },
      { role: "user", content: [result("c1", "ok")] },
    ];
    expect(expectBreak(body(input("a")), body(input("b")))).toMatchObject({
      section: "messages",
      blockIndex: FIRST_TOOL_USE_INDEX,
    });
  });

  test("an appended mid-conversation system message extends the prefix in place", () => {
    const prompt = (extra: unknown[]) => ({
      prompt: [
        { role: "system", content: "You are Xum." },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ...extra,
      ],
    });
    const reminder = { role: "system", content: "From now on, answer in French." };
    expect(compare(prompt([]), prompt([reminder])).kind).toBe("extends");
    // A changed leading system message still breaks the system section.
    const edited = prompt([]);
    edited.prompt[0] = { role: "system", content: "You are Xum. Today is Monday." };
    expect(expectBreak(prompt([]), edited)).toMatchObject({ section: "system", blockIndex: 1 });
  });

  test("only the anthropic providerOptions namespace counts", () => {
    const toolResult = (providerOptions: object) => ({
      prompt: [
        { role: "user", content: [{ type: "text", text: "find it" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "tool_search",
              output: {},
              providerOptions,
            },
          ],
        },
      ],
    });
    expect(
      compare(
        toolResult({ mux: { rawToolSearchOutput: "{}" } }),
        toolResult({ mux: { rawToolSearchOutput: '{"changed":true}' } })
      ).kind
    ).toBe("extends");
    expect(
      expectBreak(
        toolResult({ anthropic: { type: "tool-reference" } }),
        toolResult({ anthropic: { type: "tool-reference", toolName: "zulip_send" } })
      )
    ).toMatchObject({
      section: "messages",
      previous: { type: "tool-result", toolName: "tool_search" },
    });
  });
});
