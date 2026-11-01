import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { mergeUsageByModel, SubagentCostNote } from "@/browser/features/RightSidebar/CostsTab";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { installDom } from "../../../../tests/ui/dom";

const usageCosting = (inputCost: number | undefined): ChatUsageDisplay => ({
  input: { tokens: 10, cost_usd: inputCost },
  cached: { tokens: 0, cost_usd: 0 },
  cacheCreate: { tokens: 0, cost_usd: 0 },
  output: { tokens: 0, cost_usd: 0 },
  reasoning: { tokens: 0, cost_usd: 0 },
});

describe("SubagentCostNote", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const noteText = (props: Parameters<typeof SubagentCostNote>[0]) =>
    render(<SubagentCostNote {...props} />).queryByTestId("cost-subagents")?.textContent ?? null;

  test("names the open sub-agents' share of the session cost", () => {
    expect(noteText({ total: usageCosting(625.42), count: 44 })).toBe(
      "Includes $625.42 from 44 open sub-agents"
    );
  });

  test("uses the singular for one sub-agent", () => {
    expect(noteText({ total: usageCosting(1.5), count: 1 })).toBe(
      "Includes $1.50 from 1 open sub-agent"
    );
  });

  test("shows nothing without sub-agent spend", () => {
    expect(noteText({})).toBeNull();
    expect(noteText({ total: usageCosting(0), count: 2 })).toBeNull();
    expect(noteText({ total: usageCosting(undefined), count: 2 })).toBeNull();
    expect(noteText({ total: usageCosting(3), count: undefined })).toBeNull();
  });
});

describe("mergeUsageByModel", () => {
  test("sums a model both records hold and keeps the rest", () => {
    const merged = mergeUsageByModel(
      { opus: usageCosting(1), haiku: usageCosting(2) },
      { opus: usageCosting(3), sonnet: usageCosting(4) }
    );

    expect([...merged.keys()].sort()).toEqual(["haiku", "opus", "sonnet"]);
    expect(merged.get("opus")?.input).toEqual({ tokens: 20, cost_usd: 4 });
    expect(merged.get("haiku")?.input.cost_usd).toBe(2);
    expect(merged.get("sonnet")?.input.cost_usd).toBe(4);
  });

  test("accepts a missing record on either side", () => {
    expect(mergeUsageByModel(undefined, undefined).size).toBe(0);
    expect(
      mergeUsageByModel(undefined, { opus: usageCosting(3) }).get("opus")?.input.cost_usd
    ).toBe(3);
    expect(
      mergeUsageByModel({ opus: usageCosting(5) }, undefined).get("opus")?.input.cost_usd
    ).toBe(5);
  });
});
