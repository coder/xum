import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";

import {
  __resetTokenizerForTests,
  countTokens,
  countTokensBatch,
  getToolDefinitionTokens,
  getTokenizerForModel,
  loadTokenizerModules,
  type Tokenizer,
} from "./tokenizer";
import type { CountTokensBatchInput } from "./tokenizer.worker";
import * as workerPool from "./workerPool";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

jest.setTimeout(20000);

const openaiModel = KNOWN_MODELS.GPT.id;
const googleModel = KNOWN_MODELS.GEMINI_31_PRO.id;

beforeAll(async () => {
  // warm up the worker_thread and tokenizer before running tests
  const results = await loadTokenizerModules([openaiModel, googleModel]);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ status: "fulfilled" });
  expect(results[1]).toMatchObject({ status: "fulfilled" });
});

beforeEach(() => {
  __resetTokenizerForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function realTokenizer(model: string): Promise<Tokenizer> {
  return getTokenizerForModel(model, undefined, { requireRealEncoding: true });
}

// The pre-batching shape: every text is awaited before the next is sent, so each goes to the
// worker alone.
async function countOneAtATime(tokenizer: Tokenizer, texts: string[]): Promise<number[]> {
  const counts: number[] = [];
  for (const text of texts) {
    counts.push(await tokenizer.countTokens(text));
  }
  return counts;
}

function postedBatches(runSpy: { mock: { calls: unknown[][] } }): string[][] {
  return runSpy.mock.calls
    .filter(([taskName]) => taskName === "countTokensBatch")
    .map(([, payload]) => (payload as CountTokensBatchInput).inputs);
}

// Seeded so a failure reproduces; mixes the shapes real chats contain.
function generateTexts(seed: number, count: number): string[] {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const pieces = [
    "word",
    " ",
    "\n",
    "Ünïcödé",
    "🙂",
    "漢字かな",
    "<|endoftext|>",
    '{"a":[1,2]}',
    "0x1f",
  ];
  return Array.from({ length: count }, () => {
    const length = Math.floor(random() * 40);
    return Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join("");
  });
}

describe("tokenizer", () => {
  test("loadTokenizerModules warms known encodings", async () => {
    const tokenizer = await getTokenizerForModel(openaiModel);
    expect(typeof tokenizer.encoding).toBe("string");
    expect(tokenizer.encoding.length).toBeGreaterThan(0);
  });

  test("countTokens returns stable values", async () => {
    const text = "mux-tokenizer-smoke-test";
    const first = await countTokens(openaiModel, text);
    const second = await countTokens(openaiModel, text);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test("countTokens tolerates special-token strings in ordinary text", async () => {
    // GPT-2/BPE task content can contain literal special tokens; counting
    // must not throw (ai-tokenizer's encode() disallows them by default).
    const count = await countTokens(openaiModel, "text with <|endoftext|> inside");
    expect(count).toBeGreaterThan(0);
    // The spelling must tokenize as ordinary text (many tokens), not be
    // interpreted as a single reserved token, or counts undercount.
    expect(await countTokens(openaiModel, "<|endoftext|>")).toBeGreaterThan(1);
  });

  test("never reuses one text's cached or in-flight count for a different text", async () => {
    // Same length (16) and same CRC32, so a `CRC32:length` cache key conflated them (#4654).
    const first = "ab1b .  ab 1baba";
    const second = "bbbba.ba1-aba- -";
    const tokenizer = await getTokenizerForModel(openaiModel, undefined, {
      requireRealEncoding: true,
    });
    const firstAlone = await tokenizer.countTokens(first);
    __resetTokenizerForTests();
    const secondAlone = await tokenizer.countTokens(second);
    // The pair only proves anything if the real counts differ.
    expect(secondAlone).not.toBe(firstAlone);

    // Cached: the first text's count must not answer for the second.
    __resetTokenizerForTests();
    await tokenizer.countTokens(first);
    expect(await tokenizer.countTokens(second)).toBe(secondAlone);

    // In flight: concurrent requests must not join each other's worker job.
    __resetTokenizerForTests();
    expect(
      await Promise.all([tokenizer.countTokens(first), tokenizer.countTokens(second)])
    ).toEqual([firstAlone, secondAlone]);
  });

  test("countTokensBatch matches individual calls", async () => {
    const texts = ["alpha", "beta", "gamma"];
    const batch = await countTokensBatch(openaiModel, texts);
    expect(batch).toHaveLength(texts.length);

    const individual = await Promise.all(texts.map((text) => countTokens(openaiModel, text)));
    expect(batch).toEqual(individual);
  });

  describe("batched worker requests (#4653)", () => {
    // Two ids per encoding: the reference id has its own cache keys, so its counts really come
    // from the worker instead of from the batched pass's cache entries.
    const batchedModel = "openai:gpt-4o";
    const referenceModel = "openai:gpt-4.1";
    const otherBatchedModel = "anthropic:claude-opus-4";
    const otherReferenceModel = "anthropic:claude-3.7-sonnet";

    test("concurrent counts equal one-at-a-time counts for every text", async () => {
      const batched = await realTokenizer(batchedModel);
      const reference = await realTokenizer(referenceModel);
      expect(batched.encoding).toBe(reference.encoding);

      const generated = generateTexts(4653, 200);
      const toolJson = JSON.stringify({ tool: "bash", args: { script: "ls -la", timeout: 5 } });
      const texts = [
        ...generated.slice(0, 20),
        generated[3], // duplicate inside one batch
        "",
        "<|endoftext|>",
        "\ud800 lone surrogate",
        toolJson,
        generated.join(" ").repeat(20).slice(0, 70_000), // over the char cap: flushes ...
        "small after big", // ... so this one starts a new batch
        ...generated.slice(20),
        generated[5], // duplicate across a flush boundary, still in flight
        "",
      ];
      expect(texts.length).toBeGreaterThan(64);
      expect(Math.max(...texts.map((t) => t.length))).toBeGreaterThan(64 * 1024);

      // Half the texts go through the batched path first, half through the reference first.
      const half = Math.floor(texts.length / 2);
      const runSpy = jest.spyOn(workerPool, "run");

      const firstBatched = await Promise.all(
        texts.slice(0, half).map((t) => batched.countTokens(t))
      );
      runSpy.mockClear();
      const firstReference = await countOneAtATime(reference, texts.slice(0, half));
      const referenceBatches = postedBatches(runSpy);

      runSpy.mockClear();
      const secondReference = await countOneAtATime(reference, texts.slice(half));
      referenceBatches.push(...postedBatches(runSpy));
      runSpy.mockClear();
      const secondBatched = await Promise.all(texts.slice(half).map((t) => batched.countTokens(t)));
      const batchedBatches = postedBatches(runSpy);

      expect([...firstBatched, ...secondBatched]).toEqual([...firstReference, ...secondReference]);
      // The reference must have counted every distinct non-empty text in the worker, one per
      // message; otherwise the comparison above proves nothing.
      expect(referenceBatches.every((inputs) => inputs.length === 1)).toBe(true);
      expect(referenceBatches.length).toBe(new Set(texts.filter((t) => t.length > 0)).size);
      // And the batched path must really have batched.
      expect(batchedBatches.some((inputs) => inputs.length > 1)).toBe(true);
    });

    test("alternating models in one stretch keeps each text on its own model", async () => {
      const batched = [await realTokenizer(batchedModel), await realTokenizer(otherBatchedModel)];
      const reference = [
        await realTokenizer(referenceModel),
        await realTokenizer(otherReferenceModel),
      ];
      expect(batched[1].encoding).toBe(reference[1].encoding);
      // A text sent under the wrong model is only visible if the encodings differ.
      expect(batched[0].encoding).not.toBe(batched[1].encoding);

      const texts = generateTexts(17, 60);
      // Runs of three texts per model, so every switch flushes a partly filled batch.
      const modelIndex = (i: number) => Math.floor(i / 3) % 2;
      const concurrent = await Promise.all(
        texts.map((text, i) => batched[modelIndex(i)].countTokens(text))
      );
      const expected: number[] = [];
      for (const [i, text] of texts.entries()) {
        expected.push(await reference[modelIndex(i)].countTokens(text));
      }
      expect(concurrent).toEqual(expected);
    });

    test("a failed batch rejects each of its texts and does not poison later counts", async () => {
      const batched = await realTokenizer(batchedModel);
      const reference = await realTokenizer(referenceModel);
      const texts = ["first failed text", "second failed text"];
      const expected = await countOneAtATime(reference, texts);

      jest.spyOn(workerPool, "run").mockRejectedValueOnce(new Error("worker died"));
      const failed = await Promise.allSettled(texts.map((text) => batched.countTokens(text)));
      expect(failed).toEqual([
        { status: "rejected", reason: new Error("worker died") },
        { status: "rejected", reason: new Error("worker died") },
      ]);

      expect(await Promise.all(texts.map((text) => batched.countTokens(text)))).toEqual(expected);
    });
  });

  test("getTokenizerForModel supports google gemini 3 via override", async () => {
    const tokenizer = await getTokenizerForModel(googleModel);
    expect(typeof tokenizer.encoding).toBe("string");
    expect(tokenizer.encoding.length).toBeGreaterThan(0);
  });

  test("countTokens returns stable values for google gemini 3", async () => {
    const text = "mux-google-tokenizer-test";
    const first = await countTokens(googleModel, text);
    const second = await countTokens(googleModel, text);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test("counts skills catalog tool schema tokens", async () => {
    const tokens = await getToolDefinitionTokens(
      "skills_catalog_read",
      openaiModel,
      undefined,
      undefined
    );
    expect(tokens).toBeGreaterThan(0);
  });

  test("uses native Google tool token fallbacks for Gemini 3", async () => {
    await expect(
      getToolDefinitionTokens("url_context", "google:gemini-2.5-pro", undefined, undefined)
    ).resolves.toBe(0);
    await expect(
      getToolDefinitionTokens("url_context", "google:gemini-3.5-flash", undefined, undefined)
    ).resolves.toBe(50);
    await expect(
      getToolDefinitionTokens("google_search", "google:gemini-3.5-flash", undefined, undefined)
    ).resolves.toBe(50);
  });
});
