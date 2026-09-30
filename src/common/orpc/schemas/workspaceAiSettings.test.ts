import { describe, expect, test } from "bun:test";
import { WorkspaceAISettingsSchema } from "./workspaceAiSettings";

describe("WorkspaceAISettingsSchema", () => {
  test("parses legacy settings without reasoningMode (self-healing)", () => {
    const result = WorkspaceAISettingsSchema.safeParse({
      model: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningMode).toBeUndefined();
    }
  });

  test("parses settings with reasoningMode=pro", () => {
    const result = WorkspaceAISettingsSchema.safeParse({
      model: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningMode).toBe("pro");
    }
  });

  test("rejects unknown reasoning modes", () => {
    const result = WorkspaceAISettingsSchema.safeParse({
      model: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      reasoningMode: "ultra",
    });
    expect(result.success).toBe(false);
  });
});
