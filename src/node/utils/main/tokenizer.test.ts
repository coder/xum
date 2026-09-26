import { beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";

import {
  __resetTokenizerForTests,
  countTokens,
  countTokensBatch,
  getToolDefinitionTokens,
  getTokenizerForModel,
  loadTokenizerModules,
} from "./tokenizer";
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
