import { describe, expect, test } from "bun:test";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import {
  IMAGE_TOKEN_ESTIMATE,
  OUTPUT_RESERVE_TOKENS,
  WARNING_RESERVE_TOKENS,
} from "@/common/constants/contextBudget";
import {
  evaluateStepBudget,
  estimateFreshRequestTokens,
  estimateAssembledRequestTokens,
  estimateToolResultSize,
  checkAssembledRequestBudget,
  type StepBudgetInput,
} from "./contextBudget";

function evaluate(overrides: Partial<StepBudgetInput> = {}) {
  return evaluateStepBudget({
    contextTokens: 0,
    outputTokens: 0,
    toolResultChars: 0,
    imageParts: 0,
    modelContextLimit: 100_000,
    threshold: 0.7,
    warningEmitted: false,
    ...overrides,
  });
}

describe("step budget decisions", () => {
  test.each([
    [59_999, "continue"],
    [60_000, "warn"],
    [74_999, "warn"],
    [75_000, "rollover"],
  ] as const)("threshold boundary at %d", (contextTokens, decision) => {
    const result = evaluate({ contextTokens });
    expect(result.decision).toBe(decision);
    expect(result.flushOpportunity).toBe(decision !== "continue");
  });

  test("projects output, rounded tool text, and media without dropping the context baseline", () => {
    const result = evaluate({
      contextTokens: 55_000,
      outputTokens: 4_000,
      toolResultChars: 5,
      imageParts: 1,
    });
    expect(result.projected).toBe(55_000 + 4_000 + 2 + IMAGE_TOKEN_ESTIMATE);
    expect(result.decision).toBe("warn");
    expect(evaluate({ contextTokens: result.projected, warningEmitted: true }).decision).toBe(
      "continue"
    );
    expect(evaluate({ contextTokens: 75_000, warningEmitted: true }).decision).toBe("rollover");
  });

  test("hard ceiling overrides a higher configured threshold", () => {
    const hardCeiling = 100_000 - OUTPUT_RESERVE_TOKENS;
    expect(evaluate({ contextTokens: hardCeiling, threshold: 0.99 })).toMatchObject({
      decision: "rollover",
      flushOpportunity: false,
    });
    expect(
      evaluate({ contextTokens: hardCeiling - 1, threshold: 0.99, warningEmitted: true }).decision
    ).toBe("continue");
  });

  test("warning must fit strictly below the hard ceiling", () => {
    const contextTokens = 100_000 - OUTPUT_RESERVE_TOKENS - WARNING_RESERVE_TOKENS;
    expect(evaluate({ contextTokens, threshold: 0.99 })).toMatchObject({
      decision: "rollover",
      flushOpportunity: false,
    });
    expect(evaluate({ contextTokens: contextTokens - 1, threshold: 0.99 })).toMatchObject({
      decision: "warn",
      flushOpportunity: true,
    });
  });

  test.each([undefined, null, 0, -1, NaN, Infinity])(
    "unknown/invalid limit %s never invents an unlimited window",
    (modelContextLimit) => {
      expect(evaluate({ modelContextLimit, contextTokens: 1_000_000 })).toMatchObject({
        decision: "continue",
        hardCeiling: undefined,
        flushOpportunity: false,
      });
    }
  );

  test("disabled auto-compaction suppresses proactive decisions even above the ceiling", () => {
    expect(evaluate({ contextTokens: 1_000_000, threshold: 1 })).toMatchObject({
      decision: "continue",
      hardCeiling: 100_000 - OUTPUT_RESERVE_TOKENS,
    });
  });
});

describe("request estimates", () => {
  test("fresh-request estimate includes lead-in, text attachments, and system floor", () => {
    const base = estimateFreshRequestTokens({ userText: "task", systemFloorTokens: 100 });
    expect(
      estimateFreshRequestTokens({
        userText: "task",
        leadIn: "l".repeat(350),
        attachments: [{ type: "text", text: "a".repeat(350) }],
        systemFloorTokens: 100,
      })
    ).toBeGreaterThanOrEqual(base + 200);
  });

  test("nested tool data counts text but not encoded media payloads", () => {
    const result = (data: string) => ({
      data: {
        content: [
          { type: "text", text: "visible facts" },
          { type: "image", data, mimeType: "image/png" },
        ],
      },
    });
    const small = estimateToolResultSize(result("abc"));
    const large = estimateToolResultSize(result("x".repeat(100_000)));
    expect(large).toEqual(small);
    expect(large.imageParts).toBe(1);
    expect(large.toolResultChars).toBeGreaterThan("visible facts".length);
    expect(
      estimateToolResultSize({ data: "x".repeat(1000) }).toolResultChars
    ).toBeGreaterThanOrEqual(1000);
  });

  test("images, data URLs and binary payloads have bounded size independent of base64 length", () => {
    const estimate = (data: string) =>
      estimateFreshRequestTokens({
        userText: "task",
        attachments: [
          { type: "file", mediaType: "image/png", url: `data:image/png;base64,${data}` },
        ],
        systemFloorTokens: 0,
      });
    expect(estimate("x".repeat(100_000))).toBe(estimate("abc"));
    expect(estimate("abc")).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    expect(estimateToolResultSize({ nested: new Uint8Array(100_000) }).imageParts).toBe(1);
  });

  test("PDF media and display-only tool attachments never count raw base64 as text", () => {
    for (const type of ["media", "display_file"]) {
      const result = (data: string) => ({ nested: { type, data, mediaType: "application/pdf" } });
      const small = estimateToolResultSize(result("abc"));
      expect(estimateToolResultSize(result("x".repeat(100000)))).toEqual(small);
      expect(small.imageParts).toBe(type === "media" ? 1 : 0);
    }
  });

  test("repeated object references count each serialized occurrence; cycles terminate", () => {
    const value = { text: "x".repeat(350) };
    expect(estimateToolResultSize([value, value]).toolResultChars).toBeGreaterThanOrEqual(700);
    const cyclic: { text: string; child?: unknown } = { text: "visible" };
    cyclic.child = cyclic;
    expect(estimateToolResultSize(cyclic).toolResultChars).toBeGreaterThan(0);
  });

  test("assembled estimate accounts for system, all messages and normalized tool schemas", () => {
    const messages = [{ role: "user", content: "task" }];
    const base = estimateAssembledRequestTokens({ messages });
    const system = "s".repeat(3500);
    const description = "d".repeat(3500);
    const schemaDescription = "p".repeat(3500);
    for (const inputSchema of [
      z.object({ argument: z.string().describe(schemaDescription) }),
      jsonSchema({
        type: "object",
        properties: { argument: { type: "string", description: schemaDescription } },
      }),
    ]) {
      const estimate = estimateAssembledRequestTokens({
        system,
        messages: [...messages, { role: "assistant", content: "a".repeat(3500) }],
        tools: { test: tool({ description, inputSchema }) },
      });
      expect(estimate).toBeGreaterThanOrEqual(base + 4000);
    }
  });

  test("per-attempt preflight blocks smaller fallback windows and includes exact-ceiling semantics", () => {
    const payload = {
      system: "s".repeat(1000),
      messages: [{ role: "user", content: "u".repeat(3500) }],
    };
    const estimate = estimateAssembledRequestTokens(payload);
    expect(
      checkAssembledRequestBudget(payload, {
        model: "large",
        modelContextLimit: estimate + OUTPUT_RESERVE_TOKENS,
      })
    ).toBeUndefined();
    expect(
      checkAssembledRequestBudget(payload, {
        model: "fallback",
        modelContextLimit: estimate + OUTPUT_RESERVE_TOKENS - 1,
      })
    ).toEqual({
      type: "context_budget_exceeded",
      model: "fallback",
      estimate,
      hardCeiling: estimate - 1,
    });
    expect(
      checkAssembledRequestBudget(payload, { model: "unknown", modelContextLimit: undefined })
    ).toBeUndefined();
  });
});
