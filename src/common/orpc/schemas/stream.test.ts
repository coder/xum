import { describe, expect, test } from "bun:test";
import { SendMessageOptionsSchema } from "./stream";

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
