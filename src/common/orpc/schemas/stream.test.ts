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

  test("stale programmaticToolCallingExclusive payloads parse cleanly and drop the key", () => {
    // The exclusive experiment was removed (PTC is exclusive-only now). Older
    // clients/persisted payloads may still send the flag; it must be ignored,
    // never rejected.
    const parsed = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      experiments: { programmaticToolCalling: true, programmaticToolCallingExclusive: true },
    });
    expect(parsed.experiments?.programmaticToolCalling).toBe(true);
    expect(parsed.experiments && "programmaticToolCallingExclusive" in parsed.experiments).toBe(
      false
    );
  });
});
