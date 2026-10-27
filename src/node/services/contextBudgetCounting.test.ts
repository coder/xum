import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { jsonSchema, tool } from "ai";
import * as tokenizerModule from "@/node/utils/main/tokenizer";
import { OUTPUT_RESERVE_TOKENS } from "@/common/constants/contextBudget";
import {
  getContextBudgetHardCeiling,
  prepareAssembledRequestTokenCount,
  type AssembledRequestBudgetInput,
} from "@/common/utils/compaction/contextBudget";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import { CLAUDE_ENCODING_BUDGET_FACTOR } from "@/constants/tokenizerCorrection";
import calibration from "./__fixtures__/contextBudgetClaudeTokenizer.json";
import {
  checkAssembledRequestBudgetForModel,
  createContextBudgetAnchor,
  createTurnBudgetAnchor,
  estimateAnchoredRequestTokensForModel,
  estimateAssembledRequestTokensForModel,
  estimateFreshRequestTokensForModel,
  estimateToolResultTokensForModel,
  measureAssembledRequestBudgetForModel,
} from "./contextBudgetCounting";

const model = "openai:gpt-4o";
afterEach(() => mock.restore());

// Character heuristic alone; the tests below show where real encoding must exceed it.
const estimateAssembledRequestTokens = (payload: AssembledRequestBudgetInput) =>
  prepareAssembledRequestTokenCount(payload).heuristicTokens;

describe("real-encoding budget guards", () => {
  test.each([
    { name: "empty arrays", value: Array.from({ length: 10000 }, () => []) },
    { name: "empty objects", value: Array.from({ length: 10000 }, () => ({})) },
    { name: "escaped controls", value: { ["\u0000".repeat(1000)]: "\u0000".repeat(6000) } },
  ])("JSON $name cannot evade settled or assembled token budgets", async ({ value }) => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    const direct = await tokenizer.countTokens(JSON.stringify(value));
    const limit = 12000;
    expect(direct).toBeGreaterThan(getContextBudgetHardCeiling(limit));
    expect(await estimateToolResultTokensForModel(value, { model })).toBeGreaterThanOrEqual(direct);
    const payload = {
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "structured",
              toolName: "read",
              output: { type: "json", value },
            },
          ],
        },
      ],
    };
    expect(
      (await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: limit }))
        ?.type
    ).toBe("context_budget_exceeded");
  });

  test("structure-only aliases remain bounded and cycles do not hide visible escaped text", async () => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    const count = spyOn(tokenizer, "countTokens");
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValue(tokenizer);
    const shared: unknown[] = [];
    const aliases = Array.from({ length: 1500 }, () => shared);
    const encoded = await tokenizer.countTokens(JSON.stringify(aliases));
    count.mockClear();
    expect(await estimateToolResultTokensForModel(aliases, { model })).toBeGreaterThanOrEqual(
      encoded
    );
    expect(count.mock.calls.length).toBeLessThanOrEqual(1);
    const cyclic: { value: string; self?: unknown } = { value: "\u0000".repeat(1000) };
    const plain = await estimateToolResultTokensForModel(cyclic, { model });
    cyclic.self = cyclic;
    const withCycle = await estimateToolResultTokensForModel(cyclic, { model });
    expect(withCycle).toBeGreaterThanOrEqual(plain);
    expect(Number.isFinite(withCycle)).toBe(true);
  });

  test("bypass warmed approx-4 without changing ordinary callers for CJK, emoji and dense identifiers", async () => {
    const keys = [
      "XUM_APPROX_TOKENIZER",
      "MUX_APPROX_TOKENIZER",
      "XUM_FORCE_REAL_TOKENIZER",
      "MUX_FORCE_REAL_TOKENIZER",
    ] as const;
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.XUM_APPROX_TOKENIZER = "1";
      delete process.env.XUM_FORCE_REAL_TOKENIZER;
      delete process.env.MUX_FORCE_REAL_TOKENIZER;
      const approximate = await tokenizerModule.getTokenizerForModel(model);
      expect(approximate.encoding).toBe("approx-4");
      const limit = 10000;
      const ceiling = getContextBudgetHardCeiling(limit);
      for (const text of ["漢".repeat(10000), "🦊".repeat(4000), "a0b1c2d3e4f5".repeat(1500)]) {
        const warmCount = await approximate.countTokens(text);
        const payload = { system: "Short system", messages: [{ role: "user", content: text }] };
        expect(warmCount).toBeLessThan(ceiling);
        expect(estimateAssembledRequestTokens(payload)).toBeLessThan(ceiling);
        const rejected = await checkAssembledRequestBudgetForModel(payload, {
          model,
          modelContextLimit: limit,
        });
        expect(rejected?.type).toBe("context_budget_exceeded");
        expect(rejected?.estimate).toBeGreaterThan(ceiling);
        expect(
          await estimateFreshRequestTokensForModel(
            { userText: text, systemFloorTokens: 0, modelContextLimit: limit },
            { model }
          )
        ).toBeGreaterThan(ceiling);
        const stillApproximate = await tokenizerModule.getTokenizerForModel(model);
        expect(stillApproximate.encoding).toBe("approx-4");
        expect(await stillApproximate.countTokens(text)).toBe(warmCount);
      }
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  }, 20000);

  test("ordinary fitting ASCII/CJK prompts and ASCII schemas stay usable", async () => {
    const payload = {
      system: "Follow the project conventions. ".repeat(20),
      messages: [{ role: "user", content: "你好，请解释这个函数。" }],
      tools: {
        inspect: tool({
          description: "Inspect project code. ".repeat(100),
          inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } } }),
        }),
      },
    };
    expect(
      await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: 10000 })
    ).toBeUndefined();
    expect(
      await estimateFreshRequestTokensForModel(
        { userText: "Explain this function.", modelContextLimit: 4096 },
        { model }
      )
    ).toBeLessThan(getContextBudgetHardCeiling(4096));
  });

  test.each([4096, 8192])(
    "keeps fitting requests usable and blocks oversized ones with a %d-token window",
    async (modelContextLimit) => {
      const fitting = { system: "instructions", messages: [{ role: "user", content: "hello" }] };
      expect(
        await checkAssembledRequestBudgetForModel(fitting, { model, modelContextLimit })
      ).toBeUndefined();
      const oversized = {
        messages: [{ role: "user", content: "x".repeat(modelContextLimit * 4) }],
      };
      expect(
        await checkAssembledRequestBudgetForModel(oversized, { model, modelContextLimit })
      ).toMatchObject({
        type: "context_budget_exceeded",
        model,
        hardCeiling: getContextBudgetHardCeiling(modelContextLimit),
      });
    }
  );

  test("per-attempt preflight blocks smaller fallback windows with exact-ceiling semantics and skips unknown limits", async () => {
    // Common English words encode far below the 4-chars-per-token heuristic, so the
    // heuristic is the exact estimate and the ceiling boundary is deterministic.
    const payload = {
      system: "s".repeat(1000),
      messages: [{ role: "user", content: "hello world ".repeat(30_000) }],
    };
    const estimate = estimateAssembledRequestTokens(payload);
    expect(
      await checkAssembledRequestBudgetForModel(payload, {
        model,
        modelContextLimit: estimate + OUTPUT_RESERVE_TOKENS,
      })
    ).toBeUndefined();
    expect(
      await checkAssembledRequestBudgetForModel(payload, {
        model,
        modelContextLimit: estimate + OUTPUT_RESERVE_TOKENS - 1,
      })
    ).toEqual({ type: "context_budget_exceeded", model, estimate, hardCeiling: estimate - 1 });
    expect(
      await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: undefined })
    ).toBeUndefined();
  });

  test.each([
    {
      name: "OpenAI encrypted reasoning",
      type: "reasoning",
      options: (v: string) => ({ openai: { reasoningEncryptedContent: v } }),
    },
    {
      name: "an Anthropic thinking signature",
      type: "reasoning",
      options: (v: string) => ({ anthropic: { signature: v } }),
    },
    {
      name: "Anthropic redacted thinking",
      type: "reasoning",
      options: (v: string) => ({ anthropic: { redactedData: v } }),
    },
    {
      name: "a Google thought signature",
      type: "text",
      options: (v: string) => ({ google: { thoughtSignature: v } }),
    },
    {
      name: "OpenRouter reasoning details",
      type: "tool-call",
      options: (v: string) => ({
        openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: v }] },
      }),
    },
  ])("$name does not inflate either count or mutate the request", async ({ type, options }) => {
    const payload = (secret: string) => ({
      messages: [
        {
          role: "assistant",
          content: [
            {
              ...(type === "tool-call"
                ? { type, toolCallId: "call", toolName: "read", input: {} }
                : { type, text: "Check the result." }),
              providerOptions: options(secret),
            },
          ],
        },
      ],
    });
    const secret = "a0b1c2d3e4f5".repeat(4000);
    const request = payload(secret);
    expect(estimateAssembledRequestTokens(request)).toBe(
      estimateAssembledRequestTokens(payload("short"))
    );
    expect(
      await checkAssembledRequestBudgetForModel(request, { model, modelContextLimit: 10000 })
    ).toBeUndefined();
    expect(request.messages[0].content[0].providerOptions).toEqual(options(secret));
  });

  test("reasoning text still counts beside replay metadata", async () => {
    const large = "a0b1c2d3e4f5".repeat(4000);
    const request = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: large,
              providerOptions: { openai: { reasoningEncryptedContent: large } },
            },
          ],
        },
      ],
    };
    expect(estimateAssembledRequestTokens(request)).toBeGreaterThan(
      getContextBudgetHardCeiling(10000)
    );
    expect(
      (await checkAssembledRequestBudgetForModel(request, { model, modelContextLimit: 10000 }))
        ?.type
    ).toBe("context_budget_exceeded");
  });

  test("request options on a user part still count", async () => {
    // Anthropic sends a document part's context option to the model as text.
    const attachment = {
      type: "file",
      mediaType: "application/pdf",
      data: "JVBERi0xLjQ=",
      providerOptions: { anthropic: { context: "a0b1c2d3e4f5".repeat(4000) } },
    };
    const request = { messages: [{ role: "user", content: [attachment] }] };
    expect(
      (await checkAssembledRequestBudgetForModel(request, { model, modelContextLimit: 10000 }))
        ?.type
    ).toBe("context_budget_exceeded");
    expect(
      await estimateFreshRequestTokensForModel(
        { userText: "Summarize it.", attachments: [attachment], modelContextLimit: 10000 },
        { model }
      )
    ).toBeGreaterThan(getContextBudgetHardCeiling(10000));
  });

  test.each(["tool-json", "tool-content", "tool-input", "user-text"] as const)(
    "reasoning metadata lookalikes remain counted in %s",
    async (kind) => {
      const reasoning = {
        type: "reasoning",
        text: "Check the result.",
        providerOptions: { openai: { reasoningEncryptedContent: "a0b1c2d3e4f5".repeat(4000) } },
      };
      const value = { role: "assistant", content: [reasoning] };
      const request = {
        messages:
          kind === "user-text"
            ? [{ role: "user", content: JSON.stringify(value) }]
            : kind === "tool-input"
              ? [
                  {
                    role: "assistant",
                    content: [
                      { type: "tool-call", toolName: "read", toolCallId: "call", input: value },
                    ],
                  },
                ]
              : [
                  {
                    role: "tool",
                    content: [
                      {
                        type: "tool-result",
                        toolCallId: "call",
                        toolName: "read",
                        output:
                          kind === "tool-json"
                            ? { type: "json", value }
                            : { type: "content", value: [reasoning] },
                      },
                    ],
                  },
                ],
      };
      expect(estimateAssembledRequestTokens(request)).toBeGreaterThan(
        getContextBudgetHardCeiling(10000)
      );
      expect(
        (await checkAssembledRequestBudgetForModel(request, { model, modelContextLimit: 10000 }))
          ?.type
      ).toBe("context_budget_exceeded");
      expect(await estimateToolResultTokensForModel(value, { model })).toBeGreaterThan(
        getContextBudgetHardCeiling(10000)
      );
    }
  );

  test("counts system/schema text but excludes nested media bytes", async () => {
    const count = (bytes: string) =>
      estimateToolResultTokensForModel(
        { data: [{ type: "media", data: bytes, mediaType: "image/png" }] },
        { model }
      );
    expect(await count("x".repeat(100000))).toBe(await count("abc"));
    const payload = {
      messages: [{ role: "user", content: "small" }],
      tools: {
        huge: tool({
          description: "漢".repeat(10000),
          inputSchema: jsonSchema({ type: "object" }),
        }),
      },
    };
    expect(
      (await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: 10000 }))
        ?.type
    ).toBe("context_budget_exceeded");
  });

  test.each(["user", "tool-text", "json-image", "json-file", "json-message"] as const)(
    "data URLs remain counted text in %s rather than impersonating media",
    async (kind) => {
      const data = "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000);
      const output =
        kind === "tool-text"
          ? { type: "text", value: data }
          : {
              type: "json",
              value:
                kind === "json-image"
                  ? { type: "image", image: data, data, mimeType: "image/png" }
                  : kind === "json-file"
                    ? { type: "file", url: data, data, mediaType: "image/png" }
                    : { role: "user", content: [{ type: "image", image: data }] },
            };
      const payload = {
        messages:
          kind === "user"
            ? [{ role: "user", content: data }]
            : [
                {
                  role: "tool",
                  content: [
                    { type: "tool-result", toolCallId: "result", toolName: "read", output },
                  ],
                },
              ],
      };
      expect(
        (await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: 10000 }))
          ?.type
      ).toBe("context_budget_exceeded");
      if (kind === "user")
        expect(
          await estimateFreshRequestTokensForModel(
            { userText: data, systemFloorTokens: 0, modelContextLimit: 10000 },
            { model }
          )
        ).toBeGreaterThan(getContextBudgetHardCeiling(10000));
      else
        expect(await estimateToolResultTokensForModel(output, { model })).toBeGreaterThan(
          getContextBudgetHardCeiling(10000)
        );
    }
  );

  test.each(["image-data", "file-data", "image-url", "file-url", "file"] as const)(
    "only actual SDK content outputs give %s payloads media semantics",
    async (type) => {
      const data = "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000);
      const part =
        type === "file"
          ? { type, mediaType: "image/png", data: { type: "data", data } }
          : type.endsWith("-url")
            ? { type, url: data, mediaType: "image/png" }
            : { type, data, mediaType: "image/png" };
      const content = { type: "content", value: [part] };
      const payload = (output: unknown) => ({
        messages: [
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "result", toolName: "read", output }],
          },
        ],
      });
      expect(
        await checkAssembledRequestBudgetForModel(payload(content), {
          model,
          modelContextLimit: 10000,
        })
      ).toBeUndefined();
      expect(
        (
          await checkAssembledRequestBudgetForModel(payload({ type: "json", value: content }), {
            model,
            modelContextLimit: 10000,
          })
        )?.type
      ).toBe("context_budget_exceeded");
    }
  );

  test("SDK inline text-file data remains text rather than an image allowance", async () => {
    expect(
      (
        await checkAssembledRequestBudgetForModel(
          {
            messages: [
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "result",
                    toolName: "read",
                    output: {
                      type: "content",
                      value: [
                        {
                          type: "file",
                          mediaType: "text/plain",
                          data: {
                            type: "text",
                            text: "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
          { model, modelContextLimit: 10000 }
        )
      )?.type
    ).toBe("context_budget_exceeded");
  });

  test("a shared media-shaped object still counts as text when serialized inside tool JSON", async () => {
    const image = { type: "image", image: "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000) };
    expect(
      (
        await checkAssembledRequestBudgetForModel(
          {
            messages: [
              { role: "user", content: [image] },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "result",
                    toolName: "read",
                    output: { type: "json", value: image },
                  },
                ],
              },
            ],
          },
          { model, modelContextLimit: 10000 }
        )
      )?.type
    ).toBe("context_budget_exceeded");
  });

  test.each(["image", "file"] as const)(
    "genuine model %s parts stay bounded but their extra text does not",
    async (type) => {
      const payload = (data: string) => ({
        messages: [
          {
            role: "user",
            content: [
              type === "image"
                ? { type, image: data }
                : { type, data, mediaType: "application/pdf" },
            ],
          },
        ],
      });
      for (const data of [
        "data:image/png;base64,abc",
        "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000),
      ]) {
        expect(
          await checkAssembledRequestBudgetForModel(payload(data), {
            model,
            modelContextLimit: 10000,
          })
        ).toBeUndefined();
      }
      expect(
        (
          await checkAssembledRequestBudgetForModel(
            {
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type,
                      data: "abc",
                      image: "abc",
                      mediaType: "image/png",
                      caption: "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000),
                    },
                  ],
                },
              ],
            },
            { model, modelContextLimit: 10000 }
          )
        )?.type
      ).toBe("context_budget_exceeded");
    }
  );

  test("bounded chunk counts cover direct encoding around Unicode and identifier boundaries", async () => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    for (const text of [
      "a".repeat(4095) + "🦊漢字".repeat(100),
      "a0b1c2d3e4f5".repeat(500),
      "你好世界".repeat(1300),
    ]) {
      const direct = await tokenizer.countTokens(text);
      expect(await estimateToolResultTokensForModel(text, { model })).toBeGreaterThanOrEqual(
        direct
      );
    }
  }, 10000);

  test("huge repeated ASCII completes with bounded real-encoding calls", async () => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    const count = spyOn(tokenizer, "countTokens");
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValue(tokenizer);
    const rejected = await checkAssembledRequestBudgetForModel(
      { system: "x".repeat(1_500_000), messages: [] },
      { model, modelContextLimit: 10000 }
    );
    expect(rejected?.type).toBe("context_budget_exceeded");
    expect(count.mock.calls.length).toBeLessThan(30);
    expect(
      count.mock.calls.every(
        ([text]) => text.length <= 4096 && Buffer.from(text).toString("utf8") === text
      )
    ).toBe(true);
  }, 10000);

  test("encoding initialization and counting failures do not downgrade to character heuristics", async () => {
    const failure = new Error("encoding unavailable");
    spyOn(tokenizerModule, "getTokenizerForModel").mockRejectedValueOnce(failure);
    expect(
      await estimateFreshRequestTokensForModel({ userText: "hello" }, { model }).catch(
        (error: unknown) => error
      )
    ).toBe(failure);
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValueOnce({
      encoding: "real",
      countTokens: () => Promise.reject(failure),
    });
    expect(
      await checkAssembledRequestBudgetForModel(
        { messages: [{ role: "user", content: "hello" }] },
        { model, modelContextLimit: 10000 }
      ).catch((error: unknown) => error)
    ).toBe(failure);
  });
});

describe("claude-encoding budget correction (#5219)", () => {
  // A tool-heavy request whose provider input tokens were recorded with Anthropic count_tokens.
  const asTools = (
    defs: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>
  ) =>
    Object.fromEntries(
      defs.map((t) => [
        t.name,
        tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as JSONSchema7) }),
      ])
    );
  const estimate = async (target: string, request: AssembledRequestBudgetInput) =>
    (
      await estimateAssembledRequestTokensForModel(request, {
        model: target,
        modelContextLimit: 1e7,
      })
    )?.estimate ?? Number.NaN;
  const direct = async (target: string, text: string) =>
    (
      await tokenizerModule.getTokenizerForModel(target, undefined, { requireRealEncoding: true })
    ).countTokens(text);

  test("a new-tokenizer Claude request is estimated at or above its recorded provider count", async () => {
    const request = {
      system: calibration.request.system,
      messages: calibration.request.messages,
      tools: asTools(calibration.request.tools),
    };
    expect(await estimate("anthropic:claude-opus-5-5", request)).toBeGreaterThanOrEqual(
      calibration.providerInputTokens["claude-opus-5-5"]
    );
  });

  test("claude-encoded counts are scaled; OpenAI-encoded counts are not", async () => {
    // Token-dense text, so the encoded count (not the character heuristic) decides the estimate.
    const text = "a0b1c2d3e4f5".repeat(1500);
    const claude = "anthropic:claude-opus-5-5";
    const openai = "openai:gpt-5.5-pro";
    const claudeDirect = await direct(claude, text);
    const openaiDirect = await direct(openai, text);
    // Scaled well past the chunk and framing slack (a few percent) every estimate adds.
    expect(
      (await estimateToolResultTokensForModel(text, { model: claude })) - claudeDirect
    ).toBeGreaterThan(claudeDirect / 3);
    expect(
      (await estimateToolResultTokensForModel(text, { model: openai })) - openaiDirect
    ).toBeLessThanOrEqual(openaiDirect / 20);
  });

  test.each([
    [
      "claude-opus-5-5",
      calibration.oneToolProviderTokens["claude-opus-5-5"],
      calibration.smallToolsProviderTokens["claude-opus-5-5"],
    ],
    [
      "claude-sonnet-4-6",
      calibration.oneToolProviderTokens["claude-sonnet-4-6"],
      calibration.smallToolsProviderTokens["claude-sonnet-4-6"],
    ],
  ] as const)(
    "%s tool framing grows with the tool count and covers the provider's tool cost",
    async (id, oneToolTokens, allToolsTokens) => {
      const target = `anthropic:${id}`;
      const bare = { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] };
      const none = await estimate(target, bare);
      const one = await estimate(target, {
        ...bare,
        tools: asTools(calibration.smallTools.slice(0, 1)),
      });
      const all = await estimate(target, { ...bare, tools: asTools(calibration.smallTools) });
      expect(one - none).toBeGreaterThanOrEqual(oneToolTokens);
      expect(all - none).toBeGreaterThanOrEqual(allToolsTokens);
      expect(all).toBeGreaterThan(one);
    }
  );
});

describe("anchored request estimate (#4858)", () => {
  const system = "system prompt ".repeat(50);
  const tools = { read: tool({ description: "Read a file", inputSchema: jsonSchema({}) }) };
  const activeTools = ["read"];
  const prefix = [
    { role: "user", content: "long history ".repeat(4000) },
    { role: "assistant", content: "answer ".repeat(2000) },
  ];
  const delta = [{ role: "user", content: "follow-up question ".repeat(20) }];
  const payload = { system, tools, messages: [...prefix, ...delta] };
  const options = { model, modelContextLimit: 200_000, activeTools };
  const usage = { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 };
  const anchor = createContextBudgetAnchor(
    { model, system, tools, activeTools, messages: prefix },
    { usage }
  )!;

  test("an exact append costs the provider count plus the estimated appended messages", async () => {
    const full = (await estimateAssembledRequestTokensForModel(payload, options))!.estimate;
    const deltaOnly = (await estimateAssembledRequestTokensForModel({ messages: delta }, options))!
      .estimate;
    const anchored = await estimateAnchoredRequestTokensForModel(payload, options, anchor);
    expect(anchored).toEqual({
      estimate: 1000 + deltaOnly,
      hardCeiling: getContextBudgetHardCeiling(200_000),
    });
    expect(anchored!.estimate).toBeLessThan(full);
  });

  test.each([
    ["another model", { payload, options: { ...options, model: "openai:gpt-4.1" } }],
    ["another system prompt", { payload: { ...payload, system: `${system}` + "!" }, options }],
    ["another tool set", { payload: { ...payload, tools: { ...tools } }, options }],
    ["other advertised tools", { payload, options: { ...options, activeTools: [] } }],
    [
      "a rewritten prefix message",
      { payload: { ...payload, messages: [{ ...prefix[0] }, prefix[1], ...delta] }, options },
    ],
    ["a shorter message list", { payload: { ...payload, messages: prefix.slice(0, 1) }, options }],
  ])("%s falls back to the full estimate", async (_name, input) => {
    expect(
      await estimateAnchoredRequestTokensForModel(input.payload, input.options, anchor)
    ).toEqual(await estimateAssembledRequestTokensForModel(input.payload, input.options));
  });

  test("usage without positive input yields no anchor", () => {
    const request = { model, system, tools, activeTools, messages: prefix };
    expect(createContextBudgetAnchor(request, { usage: undefined })).toBeUndefined();
    expect(
      createContextBudgetAnchor(request, { usage: { inputTokens: 0, outputTokens: 5 } })
    ).toBeUndefined();
  });

  test("cache or reasoning details without an input total yield no anchor", () => {
    const request = { model, system, tools, activeTools, messages: prefix };
    expect(
      createContextBudgetAnchor(request, {
        usage: {
          outputTokens: 80,
          inputTokenDetails: { cacheReadTokens: 600, cacheWriteTokens: 0 },
          outputTokenDetails: { reasoningTokens: 50 },
        },
      })
    ).toBeUndefined();
  });

  test("reasoning reported only in provider metadata is added; unreported reasoning falls back", () => {
    const request = { model, system, tools, activeTools, messages: prefix };
    const usage = { inputTokens: 1000, outputTokens: 80 };
    const reasoning = [{ type: "reasoning", text: "" }];
    expect(
      createContextBudgetAnchor(request, {
        usage,
        providerMetadata: { openai: { reasoningTokens: 50 } },
        reasoning,
      })?.providerTokens
    ).toBe(1050);
    expect(createContextBudgetAnchor(request, { usage, reasoning })).toBeUndefined();
    expect(createContextBudgetAnchor(request, { usage })?.providerTokens).toBe(1000);
  });

  test("cache reads are counted once and replayed reasoning is added", () => {
    const cached = createContextBudgetAnchor(
      { model, system, tools, activeTools, messages: prefix },
      {
        usage: {
          inputTokens: 1000,
          outputTokens: 80,
          inputTokenDetails: { cacheReadTokens: 600, noCacheTokens: 400, cacheWriteTokens: 0 },
          outputTokenDetails: { reasoningTokens: 50, textTokens: 30 },
        },
      }
    );
    expect(cached?.providerTokens).toBe(1050);
  });

  test("an anchored request above the hard ceiling is refused", async () => {
    const hardCeiling = getContextBudgetHardCeiling(200_000);
    const heavy = { ...anchor, providerTokens: hardCeiling };
    expect((await checkAssembledRequestBudgetForModel(payload, options, heavy))?.type).toBe(
      "context_budget_exceeded"
    );
    expect(await checkAssembledRequestBudgetForModel(payload, options, anchor)).toBeUndefined();
  });

  // #5286: turn-start stage decisions read this measure, so it must be the count the check enforces.
  test.each([
    ["a fitting request", 200_000],
    ["an over-ceiling request", 4_000],
  ])("%s measures the estimate the turn-start check enforces", async (_name, limit) => {
    const opts = { ...options, modelContextLimit: limit };
    const measured = await measureAssembledRequestBudgetForModel(payload, opts);
    const full = (await estimateAssembledRequestTokensForModel(payload, opts))!;
    expect(measured).toMatchObject(full);
    expect(measured!.exceeded).toEqual(await checkAssembledRequestBudgetForModel(payload, opts));
    expect(measured!.exceeded != null).toBe(limit < 200_000);
  });

  // The refusal is serialized to the frontend as a SendMessageError.
  test("an anchored over-ceiling refusal carries only the refusal fields", async () => {
    const opts = { ...options, modelContextLimit: 4_000 };
    const heavyAnchor = createContextBudgetAnchor(
      { model, system, tools, activeTools, messages: prefix },
      { usage: { ...usage, inputTokens: 5_000 } }
    )!;
    const measured = (await measureAssembledRequestBudgetForModel(payload, opts, heavyAnchor))!;
    expect(measured.exceeded).toStrictEqual({
      type: "context_budget_exceeded",
      model,
      estimate: measured.estimate,
      hardCeiling: getContextBudgetHardCeiling(4_000),
    });
  });
});

describe("turn-start anchor (#7662)", () => {
  const history = [{ role: "user", content: "long history ".repeat(4000) }];
  const reply = { role: "assistant", content: "answer ".repeat(2000) };
  const prompt = { role: "user", content: "follow-up question ".repeat(20) };
  const payload = { messages: [...history, reply, prompt] };
  const options = { model, modelContextLimit: 200_000 };
  const system = "Answer briefly and cite the files you read.";
  const systemTokens = async (forModel: string) =>
    (await tokenizerModule.getTokenizerForModel(forModel)).countTokens(system);
  const request: {
    model: string;
    metadataModel?: string;
    agentId: string;
    routeProvider: string;
    system: string;
  } = { model, agentId: "exec", routeProvider: "openai", system };
  const anchorFor = async (
    metadata?: Partial<MuxMetadata>,
    overrides?: Partial<typeof request>,
    parts?: MuxMessage["parts"]
  ) => {
    const reply = createMuxMessage(
      "a1",
      "assistant",
      parts == null ? "answer" : "",
      {
        model,
        agentId: "exec",
        routeProvider: "openai",
        systemMessageTokens: await systemTokens(overrides?.model ?? model),
        contextUsage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
        ...metadata,
      },
      parts
    );
    return createTurnBudgetAnchor([createMuxMessage("u1", "user", "hi"), reply], {
      ...request,
      ...overrides,
    });
  };

  test("costs the previous reply's input plus the messages from its last step on", async () => {
    const anchored = await estimateAnchoredRequestTokensForModel(
      payload,
      options,
      await anchorFor()
    );
    const delta = (await estimateAssembledRequestTokensForModel(
      { messages: [reply, prompt] },
      options
    ))!.estimate;
    expect(anchored).toEqual({
      estimate: 1000 + delta,
      hardCeiling: getContextBudgetHardCeiling(200_000),
    });
    expect(anchored!.estimate).toBeLessThan(
      (await estimateAssembledRequestTokensForModel(payload, options))!.estimate
    );
  });

  test("counts cache reads and writes once, and adds the reply's reasoning and system growth", async () => {
    const contextUsage = {
      inputTokens: 1000,
      outputTokens: 80,
      cachedInputTokens: 600,
      reasoningTokens: 50,
      totalTokens: 1080,
    };
    // Rows keep cache writes in provider metadata: 300 uncached + 600 read + 100 written.
    const contextProviderMetadata = { anthropic: { cacheCreationInputTokens: 100 } };
    const sent = await systemTokens(model);
    expect((await anchorFor({ contextUsage, contextProviderMetadata }))?.providerTokens).toBe(1050);
    const grown = { contextUsage, systemMessageTokens: sent - 30 };
    expect((await anchorFor(grown))?.providerTokens).toBe(1080);
    const shrunk = { contextUsage, systemMessageTokens: sent + 30 };
    expect((await anchorFor(shrunk))?.providerTokens).toBe(1050);
    // Claude-encoded growth is scaled like every other claude count (#5219). Tests default to
    // the approximate tokenizer, which has no claude encoding.
    const original = process.env.XUM_FORCE_REAL_TOKENIZER;
    process.env.XUM_FORCE_REAL_TOKENIZER = "1";
    try {
      const claude = "anthropic:claude-opus-5-5";
      const claudeGrown = {
        model: claude,
        metadataModel: claude,
        contextUsage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
        systemMessageTokens: (await systemTokens(claude)) - 30,
      };
      const claudeRequest = { model: claude, metadataModel: claude };
      expect((await anchorFor(claudeGrown, claudeRequest))?.providerTokens).toBe(
        1000 + Math.ceil(30 * CLAUDE_ENCODING_BUDGET_FACTOR)
      );
    } finally {
      if (original == null) delete process.env.XUM_FORCE_REAL_TOKENIZER;
      else process.env.XUM_FORCE_REAL_TOKENIZER = original;
    }
  });

  test.each<[string, Partial<MuxMetadata>, Partial<typeof request>]>([
    ["a partial reply", { partial: true }, {}],
    ["a synthetic reply", { synthetic: true }, {}],
    ["a failed reply", { error: "boom" }, {}],
    ["a reply with an error type", { errorType: "unknown" }, {}],
    ["a compaction summary", { compacted: "user" }, {}],
    ["a context boundary", { compactionBoundary: true }, {}],
    ["a reply without usage", { contextUsage: undefined }, {}],
    [
      "a reply without input",
      { contextUsage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 } },
      {},
    ],
    ["a reply without its system count", { systemMessageTokens: undefined }, {}],
    ["a reply without its model", { model: undefined }, {}],
    ["another model", {}, { model: "openai:gpt-4.1" }],
    // A providers.jsonc mapping changes the resolved model and keeps the model.
    ["another resolved model", { metadataModel: "openai:gpt-4.1" }, { metadataModel: model }],
    ["a reply without its resolved model", {}, { metadataModel: model }],
    ["another route", {}, { routeProvider: "openrouter" }],
    ["another agent", {}, { agentId: "plan" }],
  ])("%s yields no turn anchor", async (_name, metadata, overrides) => {
    expect(await anchorFor(metadata, overrides)).toBeUndefined();
  });

  // The next request replays the last step's thinking at its full count; the estimator sees at
  // most its summary text (Anthropic redacted thinking and OpenAI encrypted reasoning have none).
  const thinking = { type: "reasoning" as const, text: "" };
  const text = (value: string) => ({ type: "text" as const, text: value });
  test.each<[string, MuxMessage["parts"], Partial<MuxMetadata>, number | undefined]>([
    ["last-step reasoning without a reported count", [thinking], {}, undefined],
    [
      "last-step reasoning counted only in provider metadata",
      [thinking],
      { contextProviderMetadata: { openai: { reasoningTokens: 40 } } },
      1040,
    ],
    [
      "reasoning only before the last step",
      [thinking, text("step one"), text("answer")],
      { stepStartPartIndices: [0, 2] },
      1000,
    ],
  ])("a reply with %s", async (_name, parts, metadata, providerTokens) => {
    expect((await anchorFor(metadata, {}, parts))?.providerTokens).toBe(providerTokens);
  });

  test("a reply marked as not compacted still anchors", async () => {
    expect((await anchorFor({ compacted: false }))?.providerTokens).toBe(1000);
  });

  test("a row without a route or agent still anchors; history without a reply does not", async () => {
    expect(await anchorFor({ agentId: undefined, routeProvider: undefined })).toBeDefined();
    expect(
      await createTurnBudgetAnchor([createMuxMessage("u1", "user", "hi")], request)
    ).toBeUndefined();
  });

  test.each([
    ["no assistant message", { messages: [...history, prompt] }, options],
    ["another model", payload, { ...options, model: "openai:gpt-4.1" }],
  ])("%s falls back to the full estimate", async (_name, input, opts) => {
    expect(await estimateAnchoredRequestTokensForModel(input, opts, await anchorFor())).toEqual(
      await estimateAssembledRequestTokensForModel(input, opts)
    );
  });
});

describe("repeated native tool references (#5413)", () => {
  // Anthropic expands every tool_reference into the full definition, repeats included.
  const claude = "anthropic:claude-opus-5-5";
  const tools = {
    read: tool({ description: "Read a file", inputSchema: jsonSchema({}) }),
    mcp_big: tool({
      description: "Deploy the selected release to the target environment. ".repeat(60),
      inputSchema: jsonSchema({
        type: "object",
        properties: { release: { type: "string", description: "Release id. ".repeat(40) } },
      }),
    }),
  };
  const loaded = ["read", "mcp_big"];
  const user = { role: "user", content: [{ type: "text", text: "Deploy the release." }] };
  const search = (id: string) => [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: id,
          toolName: "tool_catalog_search",
          input: { query: "x" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "tool_catalog_search",
          output: {
            type: "content",
            value: [
              {
                type: "custom",
                providerOptions: { anthropic: { type: "tool-reference", toolName: "mcp_big" } },
              },
            ],
          },
        },
      ],
    },
  ];
  const once = [user, ...search("s1")];
  const twice = [...once, ...search("s2")];
  const options = { model: claude, modelContextLimit: 200_000, activeTools: loaded };
  const estimate = async (messages: unknown[], activeTools: string[]) =>
    (await estimateAssembledRequestTokensForModel(
      { tools, messages },
      { ...options, activeTools }
    ))!.estimate;

  test("each repeated reference charges the expanded schema again", async () => {
    const schemaCost = (await estimate([user], loaded)) - (await estimate([user], ["read"]));
    expect((await estimate(twice, loaded)) - (await estimate(once, loaded))).toBeGreaterThanOrEqual(
      schemaCost
    );
  });

  test("an appended repeat reference falls back to the full estimate", async () => {
    const anchor = createContextBudgetAnchor(
      { model: claude, system: undefined, tools, activeTools: loaded, messages: once },
      { usage: { inputTokens: 1000, outputTokens: 10 } }
    );
    expect(anchor).toBeDefined();
    const payload = { tools, messages: twice };
    expect(await estimateAnchoredRequestTokensForModel(payload, options, anchor)).toEqual(
      await estimateAssembledRequestTokensForModel(payload, options)
    );
  });

  test("a reference after the turn anchor's reply falls back to the full estimate", async () => {
    const turnAnchor = { model: claude, providerTokens: 1000 };
    const payload = { tools, messages: once };
    expect(await estimateAnchoredRequestTokensForModel(payload, options, turnAnchor)).toEqual(
      await estimateAssembledRequestTokensForModel(payload, options)
    );
  });
});
