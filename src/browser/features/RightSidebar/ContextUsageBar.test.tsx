import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { ContextUsageBar } from "@/browser/features/RightSidebar/ContextUsageBar";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { installDom } from "../../../../tests/ui/dom";

describe("ContextUsageBar compaction warning", () => {
  // Use the shared harness: a raw happy-dom swap imported UI modules before any
  // document existed, which pins Radix's layout effect to a noop for later suites
  // in CI's shared-process shards.
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows warning when compaction model is smaller than threshold", () => {
    const data: TokenMeterData = {
      segments: [{ type: "input", tokens: 100, percentage: 10, color: "#000" }],
      totalTokens: 100,
      maxTokens: 1000,
      totalPercentage: 10,
    };

    const view = render(
      <TooltipProvider>
        <ContextUsageBar
          data={data}
          autoCompaction={{
            threshold: 80,
            setThreshold: () => undefined,
            contextWarning: { compactionModelMaxTokens: 500, thresholdTokens: 800 },
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Compaction model context/i)).toBeTruthy();
  });

  test("does not show warning when contextWarning is absent", () => {
    const data: TokenMeterData = {
      segments: [{ type: "input", tokens: 100, percentage: 10, color: "#000" }],
      totalTokens: 100,
      maxTokens: 1000,
      totalPercentage: 10,
    };

    const view = render(
      <TooltipProvider>
        <ContextUsageBar
          data={data}
          autoCompaction={{ threshold: 80, setThreshold: () => undefined }}
        />
      </TooltipProvider>
    );

    expect(view.queryByText(/Compaction model context/i)).toBeNull();
  });
});
