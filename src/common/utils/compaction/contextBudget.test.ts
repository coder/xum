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
  getContextBudgetHardCeiling,
  getContextBudgetHandoffPoint,
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
    handoffRequested: false,
    ...overrides,
  });
}

describe("handoff point", () => {
  test.each([
    [4096, [409, 2048, 2867, 3686], 3072],
    [100_000, [10_000, 50_000, 70_000, 90_000], 91_808],
    [128_000, [12_800, 64_000, 89_600, 115_200], 119_808],
    [200_000, [20_000, 100_000, 140_000, 180_000], 191_808],
    [1_000_000, [100_000, 500_000, 700_000, 900_000], 991_808],
  ] as const)(
    "separates targets from the forced ceiling for %d tokens",
    (limit, targets, ceiling) => {
      [0.1, 0.5, 0.7, 0.9].forEach((threshold, index) => {
        expect(getContextBudgetHandoffPoint(limit, threshold)).toBe(targets[index]);
        expect(
          evaluate({ modelContextLimit: limit, threshold, contextTokens: ceiling }).decision
        ).toBe("rollover");
        expect(
          evaluate({ modelContextLimit: limit, threshold, contextTokens: ceiling - 1 }).decision
        ).not.toBe("rollover");
      });
    }
  );

  test.each([0, -1, 1, NaN, Infinity])("rejects disabled or invalid threshold %s", (threshold) => {
    expect(() => getContextBudgetHandoffPoint(100_000, threshold)).toThrow();
  });
  test.each([0, -1, NaN, Infinity])("rejects invalid limit %s", (limit) => {
    expect(() => getContextBudgetHandoffPoint(limit, 0.7)).toThrow();
  });
});

describe("step budget decisions", () => {
  test.each([
    [59_999, "continue"],
    [60_000, "warn"],
    [69_999, "warn"],
    [70_000, "handoff"],
    [89_759, "handoff"],
    [89_760, "continue"],
    [91_807, "continue"],
    [91_808, "rollover"],
  ] as const)("threshold boundary at %d", (contextTokens, decision) => {
    expect(evaluate({ contextTokens }).decision).toBe(decision);
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
    expect(evaluate({ contextTokens: 75_000, warningEmitted: true }).decision).toBe("handoff");
  });

  test.each([60_000, 75_000, 89_000])(
    "a delivered handoff suppresses both advisories at %d",
    (contextTokens) => {
      expect(evaluate({ contextTokens, handoffRequested: true }).decision).toBe("continue");
    }
  );

  test("advisory admission requires conservative reserve headroom, never an earlier forced reset", () => {
    const contextTokens = 119_808 - WARNING_RESERVE_TOKENS;
    expect(
      evaluate({ modelContextLimit: 128_000, threshold: 0.9, contextTokens: contextTokens - 1 })
        .decision
    ).toBe("handoff");
    expect(evaluate({ modelContextLimit: 128_000, threshold: 0.9, contextTokens }).decision).toBe(
      "continue"
    );
    expect(
      evaluate({ modelContextLimit: 128_000, threshold: 0.9, contextTokens: 118_000 }).decision
    ).toBe("continue");
    expect(
      evaluate({
        modelContextLimit: 128_000,
        contextTokens: 90_000,
        toolResultChars: 4,
        toolResultTokens: 28_000,
      }).decision
    ).toBe("continue");
  });

  test("hard ceiling overrides a higher configured target", () => {
    expect(evaluate({ contextTokens: 91_808, threshold: 0.99 })).toMatchObject({
      decision: "rollover",
      flushOpportunity: false,
    });
    expect(evaluate({ contextTokens: 91_807, threshold: 0.99 }).decision).toBe("continue");
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

  test("disabled auto-compaction blocks only at the hard ceiling", () => {
    expect(evaluate({ contextTokens: 91_807, threshold: 1 }).decision).toBe("continue");
    expect(evaluate({ contextTokens: 91_808, threshold: 1 })).toMatchObject({
      decision: "block",
      hardCeiling: 91_808,
    });
  });
});

describe("context budget reserve bounds", () => {
  test.each([1, 3, 5, 4096, 8192, 32767, 32768, 100_000, 1_000_000])(
    "leaves at least three quarters of a %d-token window usable",
    (limit) => {
      const ceiling = getContextBudgetHardCeiling(limit);
      expect(ceiling).toBeGreaterThan(0);
      expect(ceiling).toBeLessThanOrEqual(limit);
      expect(limit - ceiling).toBeLessThanOrEqual(Math.floor(limit / 4));
      expect(limit - ceiling).toBeLessThanOrEqual(OUTPUT_RESERVE_TOKENS);
      if (limit >= OUTPUT_RESERVE_TOKENS * 4) {
        expect(ceiling).toBe(limit - OUTPUT_RESERVE_TOKENS);
      }
    }
  );

  test.each([0, -1, NaN, Infinity, -Infinity])(
    "rejects invalid known context limit %s",
    (modelContextLimit) => {
      expect(() => getContextBudgetHardCeiling(modelContextLimit)).toThrow();
      expect(() => estimateFreshRequestTokens({ userText: "hello", modelContextLimit })).toThrow();
    }
  );

  test("preserves the default system floor for unknown and large model windows", () => {
    const defaultEstimate = estimateFreshRequestTokens({ userText: "hello" });
    expect(estimateFreshRequestTokens({ userText: "hello", modelContextLimit: 100_000 })).toBe(
      defaultEstimate
    );
    expect(estimateFreshRequestTokens({ userText: "hello", modelContextLimit: 1_000_000 })).toBe(
      defaultEstimate
    );
  });
});

describe("small-model context budgets", () => {
  test.each([4096, 8192])(
    "keeps fitting requests usable with a %d-token window",
    (modelContextLimit) => {
      const hardCeiling = modelContextLimit * 0.75;
      expect(evaluate({ contextTokens: 100, modelContextLimit })).toMatchObject({
        decision: "continue",
        hardCeiling,
      });
      const fitting = { system: "instructions", messages: [{ role: "user", content: "hello" }] };
      expect(
        checkAssembledRequestBudget(fitting, { model: "small-model", modelContextLimit })
      ).toBeUndefined();
      const freshInput = { userText: "hello", modelContextLimit };
      expect(estimateFreshRequestTokens(freshInput)).toBeLessThan(hardCeiling);

      const oversized = {
        messages: [{ role: "user", content: "x".repeat(modelContextLimit * 4) }],
      };
      expect(
        checkAssembledRequestBudget(oversized, { model: "small-model", modelContextLimit })
      ).toEqual({
        type: "context_budget_exceeded",
        model: "small-model",
        estimate: estimateAssembledRequestTokens(oversized),
        hardCeiling,
      });
      expect(
        estimateFreshRequestTokens({ ...freshInput, userText: "x".repeat(modelContextLimit * 4) })
      ).toBeGreaterThan(hardCeiling);
      expect(
        evaluate({ modelContextLimit, contextTokens: hardCeiling, warningEmitted: true })
      ).toMatchObject({ decision: "rollover", flushOpportunity: false });
      expect(
        evaluate({ modelContextLimit, contextTokens: hardCeiling - 1, warningEmitted: true })
      ).toMatchObject({ decision: "continue" });
    }
  );

  test.each([4096, 8192])(
    "scales only the unknown system floor for %d tokens",
    (modelContextLimit) => {
      const input = { userText: "hello", modelContextLimit };
      const textTokens = estimateFreshRequestTokens({ ...input, systemFloorTokens: 0 });
      expect(estimateFreshRequestTokens(input) - textTokens).toBe(modelContextLimit / 2);
      expect(estimateFreshRequestTokens({ ...input, systemFloorTokens: 8192 }) - textTokens).toBe(
        8192
      );
      expect(estimateFreshRequestTokens({ ...input, systemFloorTokens: 100 }) - textTokens).toBe(
        100
      );
    }
  );

  test.each([4096, 8192])(
    "skips advisories if the warning cannot fit in %d tokens",
    (modelContextLimit) => {
      expect(
        evaluate({ modelContextLimit, contextTokens: Math.ceil(modelContextLimit * 0.6) })
      ).toMatchObject({
        decision: "continue",
        flushOpportunity: false,
      });
    }
  );
});

describe("absolute warning advance floor", () => {
  test.each([
    [128_000, 0.7, 76_800],
    [32_768, 0.7, 16_793],
    [128_000, 0.1, 6400],
  ])(
    "warns ahead of the handoff target for %d tokens at %s",
    (modelContextLimit, threshold, warnAt) => {
      expect(evaluate({ modelContextLimit, threshold, contextTokens: warnAt - 1 }).decision).toBe(
        "continue"
      );
      expect(evaluate({ modelContextLimit, threshold, contextTokens: warnAt }).decision).toBe(
        "warn"
      );
    }
  );

  test("does not pull a target earlier when it exceeds the usable ceiling", () => {
    expect(
      evaluate({ modelContextLimit: 64_000, threshold: 0.95, contextTokens: 54_656 }).decision
    ).toBe("continue");
    expect(
      evaluate({ modelContextLimit: 64_000, threshold: 0.95, contextTokens: 55_808 }).decision
    ).toBe("rollover");
  });

  test.each([1434, 2867, 3071])(
    "a tiny window skips advisories at %d without resetting",
    (contextTokens) => {
      expect(evaluate({ modelContextLimit: 4096, contextTokens })).toMatchObject({
        decision: "continue",
        flushOpportunity: false,
      });
    }
  );
});

test("measured dense tool tokens enforce the hard ceiling while ordinary proactive estimates remain conservative", () => {
  expect(
    evaluate({ threshold: 1, contextTokens: 1000, toolResultChars: 100, toolResultTokens: 100000 })
  ).toMatchObject({ decision: "block", flushOpportunity: false });
  expect(
    evaluate({ contextTokens: 55000, toolResultChars: 20000, toolResultTokens: 10 }).decision
  ).toBe("warn");
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
          { type: "media", data, mediaType: "image/png" },
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
    expect(estimateToolResultSize({ nested: new Uint8Array(100) }).imageParts).toBe(0);
    expect(
      estimateFreshRequestTokens({
        userText: "task",
        systemFloorTokens: 0,
        attachments: [{ type: "image", image: new Uint8Array(100_000) }],
      })
    ).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
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
      messages: [{ role: "user", content: "u".repeat(350_000) }],
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
