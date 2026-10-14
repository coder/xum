import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { SessionUsageFileSchema } from "./chatStats";

type SessionUsageFile = z.infer<typeof SessionUsageFileSchema>;

describe("SessionUsageFileSchema conformance", () => {
  it("preserves rolledUpFrom and tokenStatsCache fields", () => {
    const full: SessionUsageFile = {
      byModel: {
        "gpt-4": {
          input: { tokens: 1, cost_usd: 0.01 },
          cached: { tokens: 0, cost_usd: 0 },
          cacheCreate: { tokens: 0, cost_usd: 0 },
          output: { tokens: 2, cost_usd: 0.02 },
          reasoning: { tokens: 0, cost_usd: 0 },
          model: "gpt-4",
        },
      },
      lastRequest: {
        model: "gpt-4",
        usage: {
          input: { tokens: 1 },
          cached: { tokens: 0 },
          cacheCreate: { tokens: 0 },
          output: { tokens: 2 },
          reasoning: { tokens: 0 },
          model: "gpt-4",
        },
        timestamp: 123,
      },
      rolledUpFrom: { "child-workspace": true },
      tokenStatsCache: {
        version: 1,
        computedAt: 123,
        model: "gpt-4",
        tokenizerName: "cl100k",
        history: { messageCount: 2, maxHistorySequence: 42 },
        consumers: [{ name: "User", tokens: 10, percentage: 100 }],
        totalTokens: 10,
        topFilePaths: [{ path: "/tmp/file.ts", tokens: 10 }],
      },
      version: 1,
    };

    const parsed = SessionUsageFileSchema.parse(full);

    // oRPC output validation strips unknown keys; ensure we preserve everything we return.
    expect(parsed).toEqual(full);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(full).sort());
  });

  it("parses legacy session-usage.json without optional fields", () => {
    const legacy = {
      byModel: {},
      version: 1,
    };

    const parsed = SessionUsageFileSchema.parse(legacy);
    expect(parsed.byModel).toEqual({});
    expect(parsed.version).toBe(1);
    expect(parsed.rolledUpFrom).toBeUndefined();
    expect(parsed.tokenStatsCache).toBeUndefined();
  });

  it("keeps a fork marker and drops a malformed one instead of failing the ledger", () => {
    expect(SessionUsageFileSchema.parse({ byModel: {}, version: 1, forkedAt: 5 }).forkedAt).toBe(5);
    // A value that cannot be a real timestamp would hide every turn: 1e300, a far-future
    // time, a fraction.
    for (const forkedAt of [-1, "5", null, 1e300, Date.now() + 30 * 24 * 60 * 60 * 1000, 5.5]) {
      const parsed = SessionUsageFileSchema.parse({ byModel: {}, version: 1, forkedAt });
      expect(parsed.forkedAt).toBeUndefined();
    }
  });
});
