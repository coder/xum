import { describe, expect, it } from "bun:test";
import {
  getCodexOauthContextWindowOverride,
  isCodexOauthAllowedModel,
  isCodexOauthAllowedModelId,
} from "./codexOAuth";

describe("codexOAuth model gating", () => {
  it.each([
    // The Codex catalog publishes a 272K default context_window for each GPT-6 row.
    ["gpt-6-astra", 272_000],
    ["gpt-6.1-sol", 272_000],
    ["gpt-6-luna", 272_000],
  ])("allows %s through Codex OAuth with a %d context cap", (model, contextLimit) => {
    for (const id of [model, `openai:${model}`]) {
      expect(isCodexOauthAllowedModelId(id)).toBe(true);
      expect(getCodexOauthContextWindowOverride(id)).toBe(contextLimit);
    }
  });

  it("inherits OAuth compatibility from a mapped OpenAI model", () => {
    const config = {
      openai: {
        models: [
          { id: "team-sol", mappedToModel: "openai:gpt-6.1-sol" },
          { id: "team-bare", mappedToModel: "gpt-6.1-sol" },
          { id: "team-litellm", mappedToModel: "openai/gpt-6.1-sol" },
        ],
      },
    };

    expect(isCodexOauthAllowedModel("openai:team-sol", config)).toBe(true);
    expect(isCodexOauthAllowedModel("openai:team-bare", config)).toBe(true);
    expect(isCodexOauthAllowedModel("openai:team-litellm", config)).toBe(true);
  });

  it("does not inherit OpenAI OAuth compatibility across providers", () => {
    const config = {
      openrouter: {
        models: [{ id: "team-sol", mappedToModel: "openai:gpt-6.1-sol" }],
      },
    };

    expect(isCodexOauthAllowedModel("openrouter:team-sol", config)).toBe(false);
  });
});
