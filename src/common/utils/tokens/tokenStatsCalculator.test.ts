import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { EventLoopYielder } from "@/node/utils/concurrency/eventLoopYielder";
import * as tokenizerModule from "@/node/utils/main/tokenizer";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import {
  collectUniqueToolNames,
  countEncryptedWebSearchTokens,
  createDisplayUsage,
  extractSyncMetadata,
  extractToolOutputData,
  getConsumerInfoForToolCall,
  isEncryptedWebSearch,
  mergeResults,
  calculateTokenStats,
  type TokenCountJob,
} from "./tokenStatsCalculator";

describe("calculateTokenStats", () => {
  afterEach(() => {
    mock.restore();
  });

  // #4643: a 1.24M-row epoch submitted every message for counting in one synchronous loop and
  // blocked the whole server (pings, heartbeats, other subscriptions) for 10+ s.
  test("lets due timers run while it submits a long history for counting", async () => {
    let submissions = 0;
    let submissionsWhenTimerRan: number | undefined;
    const tokenizer: tokenizerModule.Tokenizer = {
      encoding: "test",
      countTokens: () => {
        submissions++;
        // Arm the timer mid-loop: a single yield before the loop would also let a timer armed
        // up front run, without un-blocking the loop itself.
        if (submissions === 1) {
          setTimeout(() => {
            submissionsWhenTimerRan = submissions;
          }, 0);
        }
        return Promise.resolve(1);
      },
    };
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValue(tokenizer);
    // Report every budget as spent so the check does not depend on how fast this machine is.
    spyOn(EventLoopYielder.prototype, "isDue").mockReturnValue(true);
    const messages = Array.from({ length: 4 }, (_, i) =>
      createMuxMessage(`m${i}`, i % 2 === 0 ? "user" : "assistant", `message ${i}`)
    );

    const stats = await calculateTokenStats(messages, "anthropic:claude-sonnet-4-5", null, {
      enableAgentReport: false,
    });

    expect(submissionsWhenTimerRan).toBeDefined();
    expect(submissionsWhenTimerRan!).toBeLessThan(messages.length);
    expect(submissions).toBe(messages.length);
    expect(stats.totalTokens).toBe(messages.length);
  });

  // Server mode treats an unhandled rejection as fatal, so a count that fails while the loop is
  // yielding must reach the caller, not the process (bun fails the test on an unhandled one).
  test("rejects with a count failure that happens while it yields", async () => {
    let calls = 0;
    const tokenizer: tokenizerModule.Tokenizer = {
      encoding: "test",
      countTokens: () =>
        ++calls === 1 ? Promise.reject(new Error("worker died")) : Promise.resolve(1),
    };
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValue(tokenizer);
    spyOn(EventLoopYielder.prototype, "isDue").mockReturnValue(true);
    const messages = Array.from({ length: 4 }, (_, i) =>
      createMuxMessage(`m${i}`, "user", `message ${i}`)
    );

    const failure = await calculateTokenStats(messages, "anthropic:claude-sonnet-4-5", null, {
      enableAgentReport: false,
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("worker died");
    expect(calls).toBe(messages.length);
  });
});

describe("createDisplayUsage", () => {
  test("uses usage.reasoningTokens when available", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      reasoningTokens: 100,
    };

    const result = createDisplayUsage(usage, "openai:gpt-5-pro");

    expect(result?.reasoning.tokens).toBe(100);
    expect(result?.output.tokens).toBe(400); // 500 - 100
  });

  test("falls back to providerMetadata.openai.reasoningTokens when usage.reasoningTokens is undefined", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      // reasoningTokens not provided
    };

    const providerMetadata = {
      openai: {
        reasoningTokens: 150,
        responseId: "resp_123",
        serviceTier: "default",
      },
    };

    const result = createDisplayUsage(usage, "openai:gpt-5-pro", providerMetadata);

    expect(result?.reasoning.tokens).toBe(150);
    expect(result?.output.tokens).toBe(350); // 500 - 150
  });

  test("uses 0 when both usage.reasoningTokens and providerMetadata.openai.reasoningTokens are undefined", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    };

    const providerMetadata = {
      openai: {
        responseId: "resp_123",
        serviceTier: "default",
      },
    };

    const result = createDisplayUsage(usage, "openai:gpt-5-pro", providerMetadata);

    expect(result?.reasoning.tokens).toBe(0);
    expect(result?.output.tokens).toBe(500); // All output tokens
  });

  test("prefers usage.reasoningTokens over providerMetadata when both exist", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      reasoningTokens: 100,
    };

    const providerMetadata = {
      openai: {
        reasoningTokens: 999, // Should be ignored
        responseId: "resp_123",
        serviceTier: "default",
      },
    };

    const result = createDisplayUsage(usage, "openai:gpt-5-pro", providerMetadata);

    expect(result?.reasoning.tokens).toBe(100); // Uses usage, not providerMetadata
    expect(result?.output.tokens).toBe(400); // 500 - 100
  });

  test("works with non-OpenAI providers that don't have providerMetadata.openai", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      reasoningTokens: 200,
    };

    const providerMetadata = {
      anthropic: {
        cacheCreationInputTokens: 50,
      },
    };

    const result = createDisplayUsage(
      usage,
      "anthropic:claude-sonnet-4-20250514",
      providerMetadata
    );

    expect(result?.reasoning.tokens).toBe(200);
    expect(result?.output.tokens).toBe(300); // 500 - 200
    expect(result?.cacheCreate.tokens).toBe(50); // Anthropic metadata still works
  });
});

describe("extractToolOutputData", () => {
  test("extracts value from nested structure", () => {
    const output = { type: "json", value: { foo: "bar" } };
    expect(extractToolOutputData(output)).toEqual({ foo: "bar" });
  });

  test("returns output as-is if not nested", () => {
    const output = { foo: "bar" };
    expect(extractToolOutputData(output)).toEqual({ foo: "bar" });
  });

  test("handles null", () => {
    expect(extractToolOutputData(null)).toBeNull();
  });

  test("handles primitives", () => {
    expect(extractToolOutputData("string")).toBe("string");
    expect(extractToolOutputData(123)).toBe(123);
  });
});

describe("isEncryptedWebSearch", () => {
  test("returns false for non-web_search tools", () => {
    const data = [{ encryptedContent: "abc" }];
    expect(isEncryptedWebSearch("Read", data)).toBe(false);
  });

  test("returns false for non-array data", () => {
    expect(isEncryptedWebSearch("web_search", { foo: "bar" })).toBe(false);
  });

  test("returns false for web_search without encrypted content", () => {
    const data = [{ title: "foo", url: "bar" }];
    expect(isEncryptedWebSearch("web_search", data)).toBe(false);
  });

  test("returns true for web_search with encrypted content", () => {
    const data = [{ encryptedContent: "abc123" }];
    expect(isEncryptedWebSearch("web_search", data)).toBe(true);
  });

  test("returns true if at least one item has encrypted content", () => {
    const data = [{ title: "foo" }, { encryptedContent: "abc123" }];
    expect(isEncryptedWebSearch("web_search", data)).toBe(true);
  });
});

describe("countEncryptedWebSearchTokens", () => {
  test("calculates tokens using heuristic", () => {
    const data = [{ encryptedContent: "a".repeat(100) }];
    // 100 chars * 0.75 = 75
    expect(countEncryptedWebSearchTokens(data)).toBe(75);
  });

  test("handles multiple items", () => {
    const data = [{ encryptedContent: "a".repeat(50) }, { encryptedContent: "b".repeat(50) }];
    // 100 chars * 0.75 = 75
    expect(countEncryptedWebSearchTokens(data)).toBe(75);
  });

  test("ignores items without encryptedContent", () => {
    const data = [{ title: "foo" }, { encryptedContent: "a".repeat(100) }];
    // Only counts encrypted content: 100 chars * 0.75 = 75
    expect(countEncryptedWebSearchTokens(data)).toBe(75);
  });

  test("rounds up", () => {
    const data = [{ encryptedContent: "abc" }];
    // 3 chars * 0.75 = 2.25, rounded up to 3
    expect(countEncryptedWebSearchTokens(data)).toBe(3);
  });
});

describe("collectUniqueToolNames", () => {
  test("collects tool names from assistant messages", () => {
    const messages: MuxMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "Read",
            toolCallId: "1",
            state: "input-available",
            input: {},
          },
          {
            type: "dynamic-tool",
            toolName: "Bash",
            toolCallId: "2",
            state: "input-available",
            input: {},
          },
        ],
      },
    ];

    const toolNames = collectUniqueToolNames(messages);
    expect(toolNames.size).toBe(2);
    expect(toolNames.has("Read")).toBe(true);
    expect(toolNames.has("Bash")).toBe(true);
  });

  test("deduplicates tool names", () => {
    const messages: MuxMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "Read",
            toolCallId: "1",
            state: "input-available",
            input: {},
          },
          {
            type: "dynamic-tool",
            toolName: "Read",
            toolCallId: "2",
            state: "input-available",
            input: {},
          },
        ],
      },
    ];

    const toolNames = collectUniqueToolNames(messages);
    expect(toolNames.size).toBe(1);
    expect(toolNames.has("Read")).toBe(true);
  });

  test("ignores user messages", () => {
    const messages: MuxMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ];

    const toolNames = collectUniqueToolNames(messages);
    expect(toolNames.size).toBe(0);
  });

  test("returns empty set for empty messages", () => {
    const toolNames = collectUniqueToolNames([]);
    expect(toolNames.size).toBe(0);
  });
});

describe("extractSyncMetadata", () => {
  test("accumulates system message tokens", () => {
    const messages: MuxMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [],
        metadata: { systemMessageTokens: 100 },
      },
      {
        id: "2",
        role: "assistant",
        parts: [],
        metadata: { systemMessageTokens: 200 },
      },
    ];

    const result = extractSyncMetadata(messages, "anthropic:claude-opus-4-1");
    expect(result.systemMessageTokens).toBe(300);
  });

  test("extracts usage history", () => {
    const messages: MuxMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [],
        metadata: {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
          model: "anthropic:claude-opus-4-1",
        },
      },
    ];

    const result = extractSyncMetadata(messages, "anthropic:claude-opus-4-1");
    expect(result.usageHistory.length).toBe(1);
    expect(result.usageHistory[0].input.tokens).toBe(100);
    expect(result.usageHistory[0].output.tokens).toBe(50);
  });

  test("ignores user messages", () => {
    const messages: MuxMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ];

    const result = extractSyncMetadata(messages, "anthropic:claude-opus-4-1");
    expect(result.systemMessageTokens).toBe(0);
    expect(result.usageHistory.length).toBe(0);
  });
});

test("resolves mapped metadata model for usage history costs", () => {
  const messages: MuxMessage[] = [
    {
      id: "1",
      role: "assistant",
      parts: [],
      metadata: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        model: "ollama:custom",
      },
    },
  ];

  const providersConfig = {
    ollama: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      models: [{ id: "custom", mappedToModel: "anthropic:claude-sonnet-4-6" }],
    },
  };

  const result = extractSyncMetadata(messages, "ollama:custom", providersConfig);
  expect(result.usageHistory.length).toBe(1);
  expect(result.usageHistory[0].input.cost_usd).not.toBeUndefined();
  expect(result.usageHistory[0].input.cost_usd).toBeGreaterThan(0);
});

describe("getConsumerInfoForToolCall", () => {
  test("labels task tool calls as task", () => {
    expect(
      getConsumerInfoForToolCall("task", { subagent_type: "exec", prompt: "hi", title: "t" })
    ).toEqual({
      consumer: "task",
      toolNameForDefinition: "task",
    });
  });

  test("defaults to tool name for other tools", () => {
    expect(getConsumerInfoForToolCall("file_edit_insert", { path: "x", content: "y" })).toEqual({
      consumer: "file_edit_insert",
      toolNameForDefinition: "file_edit_insert",
    });
  });
});

describe("mergeResults", () => {
  test("merges job results into consumer map", () => {
    const jobs: TokenCountJob[] = [
      { consumer: "User", promise: Promise.resolve(100) },
      { consumer: "Assistant", promise: Promise.resolve(200) },
    ];
    const results = [100, 200];
    const toolDefinitions = new Map<string, number>();
    const systemMessageTokens = 0;

    const consumerMap = mergeResults(jobs, results, toolDefinitions, systemMessageTokens);

    expect(consumerMap.get("User")).toMatchObject({ fixed: 0, variable: 100 });
    expect(consumerMap.get("Assistant")).toMatchObject({ fixed: 0, variable: 200 });
  });

  test("accumulates tokens for same consumer", () => {
    const jobs: TokenCountJob[] = [
      { consumer: "User", promise: Promise.resolve(100) },
      { consumer: "User", promise: Promise.resolve(50) },
    ];
    const results = [100, 50];
    const toolDefinitions = new Map<string, number>();
    const systemMessageTokens = 0;

    const consumerMap = mergeResults(jobs, results, toolDefinitions, systemMessageTokens);

    expect(consumerMap.get("User")).toMatchObject({ fixed: 0, variable: 150 });
  });

  test("adds tool definition tokens only once", () => {
    const jobs: TokenCountJob[] = [
      { consumer: "Read", promise: Promise.resolve(100) },
      { consumer: "Read", promise: Promise.resolve(50) },
    ];
    const results = [100, 50];
    const toolDefinitions = new Map<string, number>([["Read", 25]]);
    const systemMessageTokens = 0;

    const consumerMap = mergeResults(jobs, results, toolDefinitions, systemMessageTokens);

    // Fixed tokens added only once, variable tokens accumulated
    expect(consumerMap.get("Read")).toMatchObject({ fixed: 25, variable: 150 });
  });

  test("adds system message tokens", () => {
    const jobs: TokenCountJob[] = [];
    const results: number[] = [];
    const toolDefinitions = new Map<string, number>();
    const systemMessageTokens = 300;

    const consumerMap = mergeResults(jobs, results, toolDefinitions, systemMessageTokens);

    expect(consumerMap.get("System")).toMatchObject({ fixed: 0, variable: 300 });
  });

  test("skips zero token results", () => {
    const jobs: TokenCountJob[] = [
      { consumer: "User", promise: Promise.resolve(0) },
      { consumer: "Assistant", promise: Promise.resolve(100) },
    ];
    const results = [0, 100];
    const toolDefinitions = new Map<string, number>();
    const systemMessageTokens = 0;

    const consumerMap = mergeResults(jobs, results, toolDefinitions, systemMessageTokens);

    expect(consumerMap.has("User")).toBe(false);
    expect(consumerMap.get("Assistant")).toMatchObject({ fixed: 0, variable: 100 });
  });
});
