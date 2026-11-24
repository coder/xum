import { describe, expect, test } from "bun:test";
import { ArtifactInteractionMetadataSchema, SendMessageOptionsSchema } from "./stream";

describe("SendMessageOptions autoModelRouting", () => {
  test("round-trips the flag and leaves it absent when omitted", () => {
    const withFlag = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      autoModelRouting: true,
    });
    expect(withFlag.autoModelRouting).toBe(true);

    const withoutFlag = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    });
    expect(withoutFlag).not.toHaveProperty("autoModelRouting");
  });
});

describe("ArtifactInteractionMetadataSchema", () => {
  test("a queued send stored before artifact versions were removed still parses, without its version", () => {
    const parsed = ArtifactInteractionMetadataSchema.parse({
      id: "i-1",
      artifactPath: "form.html",
      title: "Form",
      version: 3,
      action: "send",
      text: "Ship it",
    });
    expect(parsed).toEqual({
      id: "i-1",
      artifactPath: "form.html",
      title: "Form",
      action: "send",
      text: "Ship it",
    });
  });
});
