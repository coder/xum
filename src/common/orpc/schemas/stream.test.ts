import { describe, expect, test } from "bun:test";
import { SendMessageOptionsSchema } from "./stream";

describe("SendMessageOptions experiments", () => {
  test("rlm round-trips through the send-options schema", () => {
    // Zod strips undeclared keys, so surviving a parse proves the flag is a
    // declared send-options field (not silently dropped en route to backend).
    const parsed = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      experiments: { programmaticToolCalling: true, rlm: true, bogus: true },
    });
    expect(parsed.experiments?.rlm).toBe(true);
    expect(parsed.experiments?.programmaticToolCalling).toBe(true);
    expect(parsed.experiments && "bogus" in parsed.experiments).toBe(false);
  });
});
