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
import calibration from "./__fixtures__/contextBudgetClaudeTokenizer.json";
import {
  checkAssembledRequestBudgetForModel,
  createContextBudgetAnchor,
  estimateAnchoredRequestTokensForModel,
  estimateAssembledRequestTokensForModel,
  estimateFreshRequestTokensForModel,
  estimateToolResultTokensForModel,
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

  test("encrypted OpenAI reasoning does not inflate either count or mutate the request", async () => {
    const payload = (encrypted: string) => ({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Check the result.",
              providerOptions: { openai: { reasoningEncryptedContent: encrypted } },
            },
          ],
        },
      ],
    });
    const encrypted = "a0b1c2d3e4f5".repeat(4000);
    const request = payload(encrypted);
    expect(estimateAssembledRequestTokens(request)).toBe(
      estimateAssembledRequestTokens(payload("short"))
    );
    expect(
      await checkAssembledRequestBudgetForModel(request, { model, modelContextLimit: 10000 })
    ).toBeUndefined();
    expect(request.messages[0].content[0].providerOptions.openai.reasoningEncryptedContent).toBe(
      encrypted
    );
  });

  test.each([
    "text",
    "other-openai-field",
    "other-provider",
    "nested-field",
    "non-string",
  ] as const)("reasoning still counts %s beside encrypted OpenAI metadata", async (kind) => {
    const large = "a0b1c2d3e4f5".repeat(4000);
    const request = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: kind === "text" ? large : "Check the result.",
              providerOptions: {
                openai: {
                  reasoningEncryptedContent: kind === "non-string" ? { text: large } : large,
                  ...(kind === "other-openai-field" ? { extra: large } : {}),
                  ...(kind === "nested-field"
                    ? { extra: { reasoningEncryptedContent: large } }
                    : {}),
                },
                ...(kind === "other-provider" ? { xai: { reasoningEncryptedContent: large } } : {}),
              },
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
});
