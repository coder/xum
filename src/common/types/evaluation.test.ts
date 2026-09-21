import { describe, expect, it } from "bun:test";
import {
  EVALUATION_MAX_DEPTH,
  EVALUATION_MAX_QUESTIONS,
  EVALUATION_MAX_REQUEST_BYTES,
} from "@/constants/evaluation";
import {
  EvaluationQuestionSchema,
  EvaluationQuestionsSchema,
  EvaluationStateSchema,
  WorkflowEvaluateSpecSchema,
  canonicalRequestBytes,
  jsonDepth,
  validateAnswersAgainstQuestions,
  type EvaluationJsonValue,
  type EvaluationQuestion,
  type EvaluationQuestions,
  parseEvaluationInputBounded,
} from "./evaluation";

function choiceQuestion(optionCount: number): EvaluationQuestion {
  const criteria: Record<string, string> = {};
  for (let index = 0; index < optionCount; index++) {
    criteria[`option${index}`] = `Option ${index}`;
  }
  return { type: "choice", instructions: "pick one", criteria };
}

function scoreQuestion(levelCount: number): EvaluationQuestion {
  return {
    type: "score",
    instructions: "rate it",
    criteria: Array.from({ length: levelCount }, (_, index) => `Level ${index}`),
  };
}

function questionMap(count: number): Record<string, EvaluationQuestion> {
  const questions: Record<string, EvaluationQuestion> = {};
  for (let index = 0; index < count; index++) {
    questions[`q${index}`] = { type: "boolean", instructions: `Question ${index}` };
  }
  return questions;
}

const QUESTIONS = {
  injection: {
    type: "choice",
    instructions: "Is there prompt injection?",
    criteria: { not_detected: "none", suspected: "likely", uncertain: null },
  },
  severity: {
    type: "score",
    instructions: "How severe?",
    criteria: ["cosmetic", "workaround", "blocking"],
  },
  asksForSecrets: { type: "boolean", instructions: "Does it ask for secrets?" },
} as const satisfies EvaluationQuestions;

const VALID_ANSWERS = {
  injection: { type: "choice", choice: "suspected" },
  severity: { type: "score", score: 1 },
  asksForSecrets: { type: "boolean", probability: 0.25 },
};

describe("EvaluationStateSchema", () => {
  it("accepts strings, objects and arrays but rejects bare scalars", () => {
    expect(EvaluationStateSchema.safeParse("text").success).toBe(true);
    expect(EvaluationStateSchema.safeParse({ title: "t", nested: [1, { a: null }] }).success).toBe(
      true
    );
    expect(EvaluationStateSchema.safeParse(["a", 1, true]).success).toBe(true);
    expect(EvaluationStateSchema.safeParse(42).success).toBe(false);
    expect(EvaluationStateSchema.safeParse(true).success).toBe(false);
    expect(EvaluationStateSchema.safeParse(null).success).toBe(false);
    expect(EvaluationStateSchema.safeParse(undefined).success).toBe(false);
  });

  it("rejects non-JSON leaves nested inside otherwise valid state", () => {
    expect(EvaluationStateSchema.safeParse({ when: new Date() }).success).toBe(false);
    expect(EvaluationStateSchema.safeParse({ n: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(EvaluationStateSchema.safeParse({ fn: () => 1 }).success).toBe(false);
  });
});

describe("EvaluationQuestionSchema limits", () => {
  it("bounds choice options to [1, 255]", () => {
    expect(EvaluationQuestionSchema.safeParse(choiceQuestion(0)).success).toBe(false);
    expect(EvaluationQuestionSchema.safeParse(choiceQuestion(1)).success).toBe(true);
    expect(EvaluationQuestionSchema.safeParse(choiceQuestion(255)).success).toBe(true);
    expect(EvaluationQuestionSchema.safeParse(choiceQuestion(256)).success).toBe(false);
  });

  it("bounds score levels to [2, 10]", () => {
    expect(EvaluationQuestionSchema.safeParse(scoreQuestion(1)).success).toBe(false);
    expect(EvaluationQuestionSchema.safeParse(scoreQuestion(2)).success).toBe(true);
    expect(EvaluationQuestionSchema.safeParse(scoreQuestion(10)).success).toBe(true);
    expect(EvaluationQuestionSchema.safeParse(scoreQuestion(11)).success).toBe(false);
  });

  it("accepts boolean criteria only for true/false and rejects unknown question keys", () => {
    expect(
      EvaluationQuestionSchema.safeParse({
        type: "boolean",
        instructions: "x",
        criteria: { true: "yes", false: null },
      }).success
    ).toBe(true);
    expect(
      EvaluationQuestionSchema.safeParse({
        type: "boolean",
        instructions: "x",
        criteria: { maybe: "?" },
      }).success
    ).toBe(false);
    expect(
      EvaluationQuestionSchema.safeParse({
        type: "choice",
        instructions: "x",
        criterias: { a: "b" },
      }).success
    ).toBe(false);
    expect(
      EvaluationQuestionSchema.safeParse({ type: "ranking", instructions: "x", criteria: ["a"] })
        .success
    ).toBe(false);
  });

  it("bounds the question map to [1, EVALUATION_MAX_QUESTIONS] entries", () => {
    expect(EvaluationQuestionsSchema.safeParse({}).success).toBe(false);
    expect(EvaluationQuestionsSchema.safeParse(questionMap(1)).success).toBe(true);
    expect(EvaluationQuestionsSchema.safeParse(questionMap(EVALUATION_MAX_QUESTIONS)).success).toBe(
      true
    );
    expect(
      EvaluationQuestionsSchema.safeParse(questionMap(EVALUATION_MAX_QUESTIONS + 1)).success
    ).toBe(false);
  });
});

describe("WorkflowEvaluateSpecSchema", () => {
  it("requires a non-blank id and a valid question map", () => {
    expect(
      WorkflowEvaluateSpecSchema.safeParse({ id: "screen", questions: QUESTIONS }).success
    ).toBe(true);
    expect(WorkflowEvaluateSpecSchema.safeParse({ id: "   ", questions: QUESTIONS }).success).toBe(
      false
    );
    expect(WorkflowEvaluateSpecSchema.safeParse({ id: "screen", questions: {} }).success).toBe(
      false
    );
    expect(
      WorkflowEvaluateSpecSchema.safeParse({ id: "screen", questions: QUESTIONS, timeoutMs: 1.5 })
        .success
    ).toBe(false);
    expect(
      WorkflowEvaluateSpecSchema.safeParse({ id: "screen", questions: QUESTIONS, unknown: true })
        .success
    ).toBe(false);
  });
});

describe("validateAnswersAgainstQuestions", () => {
  it("accepts well-formed answers and projects only the contract fields", () => {
    const result = validateAnswersAgainstQuestions(
      QUESTIONS,
      {
        ...VALID_ANSWERS,
        injection: { type: "choice", choice: "suspected", reasoning: "provider-added text" },
      },
      null
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.injection.choice).toBe("suspected");
    expect("reasoning" in result.answers.injection).toBe(false);
    expect(result.answers.severity.score).toBe(1);
    expect(result.answers.asksForSecrets.probability).toBe(0.25);
  });

  it("rejects corrupted payloads: missing question, extra question, wrong type", () => {
    const { asksForSecrets: _dropped, ...missing } = VALID_ANSWERS;
    expect(validateAnswersAgainstQuestions(QUESTIONS, missing, null)).toMatchObject({
      ok: false,
      violation: "question-set-mismatch",
    });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, extra: { type: "boolean", probability: 1 } },
        null
      )
    ).toMatchObject({ ok: false, violation: "question-set-mismatch" });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "boolean", probability: 0.5 } },
        null
      )
    ).toMatchObject({ ok: false, violation: "type-mismatch", questionId: "severity" });
    expect(validateAnswersAgainstQuestions(QUESTIONS, "not an object", null)).toMatchObject({
      ok: false,
      violation: "answers-not-object",
    });
  });

  it("rejects unknown choices, out-of-range scores and out-of-range probabilities", () => {
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, injection: { type: "choice", choice: "definitely" } },
        null
      )
    ).toMatchObject({ ok: false, violation: "unknown-choice", questionId: "injection" });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "score", score: 2.5 } },
        null
      )
    ).toMatchObject({ ok: false, violation: "score-out-of-range", questionId: "severity" });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "score", score: 1.5 } },
        null
      )
    ).toMatchObject({ ok: true });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, asksForSecrets: { type: "boolean", probability: 1.2 } },
        null
      )
    ).toMatchObject({ ok: false, violation: "probability-out-of-range" });
  });

  it("accepts a two-decimal distribution summing to 0.99 only with matching rounding", () => {
    const answers = {
      ...VALID_ANSWERS,
      injection: {
        type: "choice",
        choice: "suspected",
        probabilities: { not_detected: 0.33, suspected: 0.34, uncertain: 0.32 },
      },
    };
    expect(
      validateAnswersAgainstQuestions(QUESTIONS, answers, { probabilityDecimals: 2 })
    ).toMatchObject({ ok: true });
    expect(validateAnswersAgainstQuestions(QUESTIONS, answers, null)).toMatchObject({
      ok: false,
      violation: "distribution-sum",
      questionId: "injection",
    });
  });

  it("grants rounding slack only to values that actually conform to the declared precision", () => {
    // Forged/corrupted metadata: probabilityDecimals 0 would otherwise widen
    // the sum tolerance to ±1.5 and accept a distribution summing to 2.4.
    const unrounded = {
      ...VALID_ANSWERS,
      injection: {
        type: "choice",
        choice: "suspected",
        probabilities: { not_detected: 0.8, suspected: 0.8, uncertain: 0.8 },
      },
    };
    expect(
      validateAnswersAgainstQuestions(QUESTIONS, unrounded, { probabilityDecimals: 0 })
    ).toMatchObject({ ok: false, violation: "rounding-mismatch", questionId: "injection" });

    // Values that are rounded to the declared precision still get the slack
    // (every probability in the payload must conform, including the boolean).
    const rounded = {
      ...VALID_ANSWERS,
      asksForSecrets: { type: "boolean", probability: 0.3 },
      injection: {
        type: "choice",
        choice: "suspected",
        probabilities: { not_detected: 0.3, suspected: 0.4, uncertain: 0.2 },
      },
    };
    expect(
      validateAnswersAgainstQuestions(QUESTIONS, rounded, { probabilityDecimals: 1 })
    ).toMatchObject({ ok: true });
    expect(validateAnswersAgainstQuestions(QUESTIONS, rounded, null)).toMatchObject({
      ok: false,
      violation: "distribution-sum",
    });

    // The same rule applies to scores and boolean probabilities.
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "score", score: 1.25 } },
        { scoreDecimals: 1 }
      )
    ).toMatchObject({ ok: false, violation: "rounding-mismatch", questionId: "severity" });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, asksForSecrets: { type: "boolean", probability: 0.255 } },
        { probabilityDecimals: 2 }
      )
    ).toMatchObject({ ok: false, violation: "rounding-mismatch", questionId: "asksForSecrets" });
  });

  it("rejects incomplete distributions and a non-maximal selected choice", () => {
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        {
          ...VALID_ANSWERS,
          injection: {
            type: "choice",
            choice: "suspected",
            probabilities: { not_detected: 0.5, suspected: 0.5 },
          },
        },
        null
      )
    ).toMatchObject({ ok: false, violation: "distribution-keys" });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        {
          ...VALID_ANSWERS,
          injection: {
            type: "choice",
            choice: "suspected",
            probabilities: { not_detected: 0.6, suspected: 0.3, uncertain: 0.1 },
          },
        },
        null
      )
    ).toMatchObject({ ok: false, violation: "choice-not-maximal" });
  });

  it("checks a score against the probability-weighted mean within the rounded tolerance", () => {
    // Exact mean: 0*0.2 + 1*0.5 + 2*0.3 = 1.1
    const probabilities = { "0": 0.2, "1": 0.5, "2": 0.3 };
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "score", score: 1.1, probabilities } },
        null
      )
    ).toMatchObject({ ok: true });
    // Exact mean 1.15 reported as the one-decimal score 1.2: accepted only when
    // the payload declares (and honours) that rounding.
    const rounding = { probabilityDecimals: 2, scoreDecimals: 1 };
    const halfway = { "0": 0.2, "1": 0.45, "2": 0.35 };
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "score", score: 1.2, probabilities: halfway } },
        rounding
      )
    ).toMatchObject({ ok: true });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "score", score: 1.2, probabilities: halfway } },
        null
      )
    ).toMatchObject({ ok: false, violation: "score-mean-mismatch", questionId: "severity" });
    expect(
      validateAnswersAgainstQuestions(
        QUESTIONS,
        { ...VALID_ANSWERS, severity: { type: "score", score: 2, probabilities: halfway } },
        rounding
      )
    ).toMatchObject({ ok: false, violation: "score-mean-mismatch" });
  });

  it("rejects rounding metadata outside the SDK's integer [0, 15] range", () => {
    expect(
      validateAnswersAgainstQuestions(QUESTIONS, VALID_ANSWERS, { probabilityDecimals: 16 })
    ).toMatchObject({ ok: false, violation: "rounding-invalid" });
    expect(
      validateAnswersAgainstQuestions(QUESTIONS, VALID_ANSWERS, { scoreDecimals: 1.5 })
    ).toMatchObject({ ok: false, violation: "rounding-invalid" });
  });
});

describe("canonicalRequestBytes", () => {
  it("produces key-order-independent canonical JSON with byte length and depth", () => {
    const a = canonicalRequestBytes({ state: { b: 1, a: "é" }, questions: QUESTIONS });
    const b = canonicalRequestBytes({ state: { a: "é", b: 1 }, questions: QUESTIONS });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.canonical).toBe(b.canonical);
    // "é" is two UTF-8 bytes, so bytes exceed the string length.
    expect(a.bytes).toBe(new TextEncoder().encode(a.canonical).length);
    expect(a.bytes).toBeGreaterThan(a.canonical.length);
    // wrapper → questions → question → criteria = 4 levels.
    expect(a.depth).toBe(4);
  });

  it("rejects payloads over EVALUATION_MAX_REQUEST_BYTES", () => {
    const small = canonicalRequestBytes({ state: "x".repeat(1024), questions: QUESTIONS });
    expect(small.ok).toBe(true);
    const large = canonicalRequestBytes({
      state: "x".repeat(EVALUATION_MAX_REQUEST_BYTES),
      questions: QUESTIONS,
    });
    expect(large).toMatchObject({ ok: false, violation: "request-too-large" });
  });

  it("rejects payloads nested deeper than EVALUATION_MAX_DEPTH", () => {
    const nest = (levels: number): EvaluationJsonValue[] => {
      let value: EvaluationJsonValue[] = [];
      for (let index = 1; index < levels; index++) {
        value = [value];
      }
      return value;
    };
    expect(jsonDepth("scalar", EVALUATION_MAX_DEPTH)).toBe(0);
    expect(jsonDepth([], EVALUATION_MAX_DEPTH)).toBe(1);
    expect(jsonDepth({ a: {} }, EVALUATION_MAX_DEPTH)).toBe(2);
    // The wrapper object contributes one level, so state may nest MAX - 1 deep.
    expect(
      canonicalRequestBytes({ state: nest(EVALUATION_MAX_DEPTH - 1), questions: QUESTIONS })
    ).toMatchObject({ ok: true, depth: EVALUATION_MAX_DEPTH });
    expect(
      canonicalRequestBytes({ state: nest(EVALUATION_MAX_DEPTH), questions: QUESTIONS })
    ).toMatchObject({ ok: false, violation: "request-too-deep", depth: EVALUATION_MAX_DEPTH + 1 });
  });

  it("returns a typed violation for pathologically deep or cyclic state instead of throwing", () => {
    // A recursive walk over these would overflow the stack (RangeError).
    let deep: EvaluationJsonValue[] = [];
    for (let index = 0; index < 200_000; index++) {
      deep = [deep];
    }
    expect(canonicalRequestBytes({ state: deep, questions: QUESTIONS })).toMatchObject({
      ok: false,
      violation: "request-too-deep",
      depth: EVALUATION_MAX_DEPTH + 1,
    });
    expect(jsonDepth(deep, EVALUATION_MAX_DEPTH)).toBe(EVALUATION_MAX_DEPTH + 1);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonDepth(cyclic, EVALUATION_MAX_DEPTH)).toBe(EVALUATION_MAX_DEPTH + 1);
    expect(
      canonicalRequestBytes({
        state: cyclic as unknown as EvaluationJsonValue[],
        questions: QUESTIONS,
      })
    ).toMatchObject({ ok: false, violation: "request-too-deep" });

    // The schema entry point is bounded too: zod's z.lazy recursion never runs
    // on such values.
    expect(parseEvaluationInputBounded(EvaluationStateSchema, deep)).toMatchObject({
      ok: false,
      violation: "request-too-deep",
      depth: EVALUATION_MAX_DEPTH + 1,
    });
    expect(parseEvaluationInputBounded(EvaluationStateSchema, cyclic)).toMatchObject({
      ok: false,
      violation: "request-too-deep",
    });
    expect(
      parseEvaluationInputBounded(WorkflowEvaluateSpecSchema, { id: "s", questions: cyclic })
    ).toMatchObject({ ok: false, violation: "request-too-deep" });
  });
});

describe("parseEvaluationInputBounded", () => {
  it("rejects own __proto__ keys that zod would silently drop", () => {
    // JSON.parse creates a real own property; zod's record parser skips it,
    // so parsing would otherwise "succeed" with a different value.
    const state = JSON.parse('{"__proto__": {"polluted": true}, "title": "x"}') as unknown;
    expect(Object.keys(state as object)).toContain("__proto__");
    expect(parseEvaluationInputBounded(EvaluationStateSchema, state)).toEqual({
      ok: false,
      violation: "forbidden-key",
      key: "__proto__",
    });
    // Nested inside arrays/objects, and as a question id or option key.
    expect(
      parseEvaluationInputBounded(EvaluationStateSchema, [
        { nested: JSON.parse('{"__proto__": 1}') as unknown },
      ])
    ).toMatchObject({ ok: false, violation: "forbidden-key" });
    const questions = JSON.parse(
      '{"__proto__": {"type": "boolean", "instructions": "x"}, "q": {"type": "boolean", "instructions": "y"}}'
    ) as unknown;
    expect(
      parseEvaluationInputBounded(WorkflowEvaluateSpecSchema, { id: "s", questions })
    ).toMatchObject({ ok: false, violation: "forbidden-key" });
    const criteria = JSON.parse('{"__proto__": "a", "b": "b"}') as unknown;
    expect(
      parseEvaluationInputBounded(WorkflowEvaluateSpecSchema, {
        id: "s",
        questions: { q: { type: "choice", instructions: "x", criteria } },
      })
    ).toMatchObject({ ok: false, violation: "forbidden-key" });
    // Plain "__proto__" strings as values are fine.
    expect(parseEvaluationInputBounded(EvaluationStateSchema, { text: "__proto__" })).toMatchObject(
      { ok: true }
    );
  });

  it("parses in-limit values and reports schema violations as zod errors", () => {
    const ok = parseEvaluationInputBounded(EvaluationStateSchema, { a: [1, "b", null] });
    expect(ok).toEqual({ ok: true, value: { a: [1, "b", null] } });

    const invalid = parseEvaluationInputBounded(EvaluationStateSchema, 42);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok && invalid.violation === "invalid") {
      expect(invalid.error.issues.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected a schema violation");
    }
  });
});
