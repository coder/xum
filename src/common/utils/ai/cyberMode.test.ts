import { describe, expect, test } from "bun:test";

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { openaiCyberAccessProgram } from "./cyberMode";

const enabledOpenAI = {
  apiKeySet: true,
  isEnabled: true,
  isConfigured: true,
  cyberModelEnabled: true,
} as const;

const providersConfig: ProvidersConfigMap = {
  openai: enabledOpenAI,
  "mux-gateway": { apiKeySet: true, isEnabled: true, isConfigured: true },
  openrouter: { apiKeySet: true, isEnabled: true, isConfigured: true },
  coder: {
    apiKeySet: false,
    isEnabled: true,
    isConfigured: true,
    discoveredProviders: [{ name: "openai", type: "openai" }],
  },
  team: {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    providerType: "openai-responses",
    baseUrl: "https://llm.example.com/v1",
  },
};

describe("openaiCyberAccessProgram", () => {
  test.each(["gpt", "sol", "astra", " gpt-6-astra ", "openai:gpt-6.1-sol", "openai:gpt-6-astra"])(
    "maps %p to the model's Daybreak program on direct OpenAI Responses",
    (model) => {
      expect(openaiCyberAccessProgram(model, { providersConfig })).toBe("daybreak_blue");
    }
  );

  // Only exact ids the Daybreak guide maps are eligible; the API rejects a
  // program the requested model does not take.
  test.each([
    "openai:gpt",
    "openai:gpt-6.1-sol-2026-09-29",
    "luna",
    "openai:gpt-6-luna",
    "openai:gpt-6-sol",
    "openai:daybreak-blue-latest",
    "anthropic:claude-opus-5-5",
  ])("returns undefined for unmapped model %p", (model) => {
    expect(openaiCyberAccessProgram(model, { providersConfig })).toBeUndefined();
  });

  test("requires the opt-in provider setting", () => {
    const off: ProvidersConfigMap = {
      ...providersConfig,
      openai: { ...enabledOpenAI, cyberModelEnabled: false },
    };
    expect(openaiCyberAccessProgram("gpt", { providersConfig: off })).toBeUndefined();
    expect(openaiCyberAccessProgram("gpt")).toBeUndefined();
    const { openai: _openai, ...withoutOpenAI } = providersConfig;
    expect(openaiCyberAccessProgram("gpt", { providersConfig: withoutOpenAI })).toBeUndefined();
  });

  test("is unavailable on Chat Completions", () => {
    expect(
      openaiCyberAccessProgram("gpt", { providersConfig, openaiWireFormat: "chatCompletions" })
    ).toBeUndefined();
    const storedChat: ProvidersConfigMap = {
      ...providersConfig,
      openai: { ...enabledOpenAI, wireFormat: "chatCompletions" },
    };
    expect(openaiCyberAccessProgram("gpt", { providersConfig: storedChat })).toBeUndefined();
  });

  test("is unavailable when Codex OAuth serves the request", () => {
    const oauth: ProvidersConfigMap = {
      ...providersConfig,
      openai: { ...enabledOpenAI, apiKeySet: false, codexOauthSet: true },
    };
    expect(openaiCyberAccessProgram("gpt", { providersConfig: oauth })).toBeUndefined();
  });

  test.each([
    ["mux-gateway:openai/gpt-6.1-sol", undefined],
    ["openrouter:openai/gpt-6.1-sol", undefined],
    ["coder:openai/gpt-6.1-sol", undefined],
    ["team:gpt-6.1-sol", undefined],
    ["openai:gpt-6.1-sol", "mux-gateway"],
    ["openai:gpt-6.1-sol", "coder"],
  ] as const)("is unavailable off the direct OpenAI route: %p via %p", (model, route) => {
    expect(
      openaiCyberAccessProgram(model, { providersConfig, resolvedRouteProvider: route })
    ).toBeUndefined();
  });
});
