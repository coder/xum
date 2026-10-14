// Bootstrap Happy DOM before react-dom evaluates.
import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import { useAnalyticsSummary, type Summary } from "./useAnalytics";

function summary(totalResponses: number): Summary {
  return {
    totalSpendUsd: 1,
    todaySpendUsd: 1,
    avgDailySpendUsd: 1,
    cacheHitRatio: 0,
    totalTokens: 1,
    totalResponses,
  };
}

let harness: ConnectionHarness;
/** What the next server's getSummary answers, or a promise of it. */
let serverSummary: Summary | Promise<Summary>;

// The dashboard charts show a spinner instead of their data while `loading` is true. A reload
// through the new client after a reconnect must keep the shown data instead.
describe.each([...GAP_MODES])("useAnalyticsSummary across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverSummary = summary(1);
    harness = createConnectionHarness(mode, (): TestApiOverrides<APIClient> => {
      const answer = serverSummary;
      return { analytics: { getSummary: () => Promise.resolve(answer) } };
    });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the shown summary until the reload answers; another project loads again", async () => {
    const view = renderHook(
      (props: { projectPath: string }) => useAnalyticsSummary(props.projectPath),
      {
        wrapper: harness.Wrapper,
        initialProps: { projectPath: "/a" },
      }
    );
    await waitFor(() => expect(view.result.current.data?.totalResponses).toBe(1));

    let answer: ((value: Summary) => void) | null = null;
    serverSummary = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    expect(view.result.current.loading).toBe(false);
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.data?.totalResponses).toBe(1);

    act(() => answer?.(summary(2)));
    await waitFor(() => expect(view.result.current.data?.totalResponses).toBe(2));

    // The shown summary belongs to /a: under /b, the chart shows "loading" until /b answers.
    view.rerender({ projectPath: "/b" });
    expect(view.result.current.loading).toBe(true);
  });
});
