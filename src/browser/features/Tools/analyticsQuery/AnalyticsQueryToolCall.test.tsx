import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import * as RouterContextModule from "@/browser/contexts/RouterContext";
import * as UseAnalyticsModule from "@/browser/hooks/useAnalytics";
import type { SavedQuery } from "@/common/types/savedQueries";

interface SaveInput {
  label: string;
  sql: string;
  chartType?: string | null;
}

type SaveBehavior =
  | { type: "resolve"; value: SavedQuery | null }
  | { type: "reject"; error: unknown };

function createSavedQuery(overrides: Partial<SavedQuery> = {}): SavedQuery {
  return {
    id: "saved-query-1",
    label: "Saved query",
    sql: "SELECT 1",
    chartType: "table",
    order: 0,
    createdAt: "2026-03-06T00:00:00.000Z",
    ...overrides,
  };
}

let saveBehavior: SaveBehavior = {
  type: "resolve",
  value: createSavedQuery(),
};

const saveMock = mock((_input: SaveInput) => {
  if (saveBehavior.type === "reject") {
    const rejectionError =
      saveBehavior.error instanceof Error
        ? saveBehavior.error
        : new Error(String(saveBehavior.error));
    return Promise.reject(rejectionError);
  }

  return Promise.resolve(saveBehavior.value);
});

const navigateToAnalyticsMock = mock(() => undefined);
const useSavedQueriesMock = mock((_options?: { skipLoad?: boolean }) => ({
  queries: [],
  loading: false,
  save: saveMock,
  update: () => Promise.resolve(null),
  remove: () => Promise.resolve(undefined),
  refresh: () => Promise.resolve(undefined),
}));

const actualRouterContextModule = { ...RouterContextModule };
const actualUseAnalyticsModule = { ...UseAnalyticsModule };

// Keep module mocks inside test hooks: Bun loads test files before afterAll runs, so
// file-scope mock.module() calls can pollute unrelated files during collection.
async function installAnalyticsQueryModuleMocks() {
  await mock.module("@/browser/hooks/useAnalytics", () => ({
    ...actualUseAnalyticsModule,
    useSavedQueries: useSavedQueriesMock,
  }));
  await mock.module("@/browser/contexts/RouterContext", () => ({
    ...actualRouterContextModule,
    useRouter: () => ({
      navigateToAnalytics: navigateToAnalyticsMock,
    }),
  }));
}

async function restoreAnalyticsQueryModuleMocks() {
  // Bun's mock.module() has no disposer, and mock.restore() does not undo module
  // mocks. Restore the real exports so these stubs do not leak into later files.
  await mock.module("@/browser/hooks/useAnalytics", () => actualUseAnalyticsModule);
  await mock.module("@/browser/contexts/RouterContext", () => actualRouterContextModule);
}

import { AnalyticsQueryToolCall } from "./AnalyticsQueryToolCall";
import type { AnalyticsQueryResult, AnalyticsQueryToolResult } from "./types";

function renderWithTooltip(ui: JSX.Element) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function createSuccessResult(overrides: Partial<AnalyticsQueryResult> = {}): AnalyticsQueryResult {
  return {
    success: true,
    columns: [
      { name: "model", type: "VARCHAR" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ],
    rows: [
      { model: "gpt-5", total_cost_usd: 1.25 },
      { model: "claude", total_cost_usd: 0.83 },
    ],
    truncated: false,
    rowCount: 2,
    durationMs: 18,
    visualization: "table",
    title: "Backend title",
    x_axis: "model",
    y_axis: ["total_cost_usd"],
    ...overrides,
  };
}

describe("AnalyticsQueryToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalResizeObserver: typeof globalThis.ResizeObserver;

  afterAll(async () => {
    await restoreAnalyticsQueryModuleMocks();
  });

  beforeEach(async () => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalResizeObserver = globalThis.ResizeObserver;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    class ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
        void _callback;
      }
      observe(_target: Element): void {
        void _target;
      }
      unobserve(_target: Element): void {
        void _target;
      }
      disconnect(): void {
        return undefined;
      }
    }

    globalThis.ResizeObserver = ResizeObserver;

    await installAnalyticsQueryModuleMocks();

    saveBehavior = {
      type: "resolve",
      value: createSavedQuery(),
    };
    saveMock.mockClear();
    navigateToAnalyticsMock.mockClear();
    useSavedQueriesMock.mockClear();
  });

  afterEach(async () => {
    cleanup();
    await restoreAnalyticsQueryModuleMocks();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  test("renders title from args", () => {
    const result = createSuccessResult();

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{
          sql: "SELECT model, sum(total_cost_usd) AS total_cost_usd FROM events GROUP BY model",
          title: "Spend by model",
        }}
        result={result}
        status="completed"
      />
    );

    expect(view.getByText("Spend by model")).toBeTruthy();
  });

  test("opts into the save-only saved-query hook path", () => {
    renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events" }}
        result={createSuccessResult()}
        status="completed"
      />
    );

    expect(useSavedQueriesMock).toHaveBeenCalledWith({ skipLoad: true });
  });

  test("displays row count and query duration", () => {
    const result = createSuccessResult({
      columns: [
        { name: "model", type: "VARCHAR" },
        { name: "total_tokens", type: "INTEGER" },
      ],
      rows: [
        { model: "gpt-5", total_tokens: 1000 },
        { model: "claude", total_tokens: 1200 },
      ],
      durationMs: 37,
      y_axis: ["total_tokens"],
    });

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{
          sql: "SELECT model, sum(input_tokens + output_tokens) AS total_tokens FROM events GROUP BY model",
        }}
        result={result}
        status="completed"
      />
    );

    expect(view.getByText(/2 rows/i)).toBeTruthy();
    expect(view.getByText(/37ms/i)).toBeTruthy();
  });

  test("ignores malformed success result missing numeric metadata", () => {
    const malformedResult = {
      success: true,
      columns: [{ name: "model", type: "VARCHAR" }],
      rows: [{ model: "gpt-5" }],
      truncated: false,
    } as unknown as AnalyticsQueryToolResult;

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model FROM events" }}
        result={malformedResult}
        status="completed"
      />
    );

    expect(view.getByText("Query results")).toBeTruthy();
    expect(view.queryByText(/rows ·/i)).toBeNull();
  });

  test("shows tool error result", () => {
    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT * FROM events" }}
        result={{ success: false, error: "DuckDB parse error" }}
        status="failed"
      />
    );

    expect(view.getByText("DuckDB parse error")).toBeTruthy();
    expect(view.getByText("SELECT * FROM events")).toBeTruthy();
  });

  test("shows truncation warning when backend truncated rows", () => {
    const result = createSuccessResult({
      rows: [{ model: "gpt-5", total_cost_usd: 1.2 }],
      truncated: true,
      rowCount: 500,
      rowCountExact: false,
      durationMs: 11,
    });

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events LIMIT 500" }}
        result={result}
        status="completed"
      />
    );

    expect(view.getByText(/Showing 1 of 500\+ rows/i)).toBeTruthy();
  });

  test("renders chart selector controls", () => {
    const result = createSuccessResult({ durationMs: 14 });

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events" }}
        result={result}
      />
    );

    expect(view.getByRole("button", { name: /Table/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Bar/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Line/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Area/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Pie/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Stacked/i })).toBeTruthy();
  });

  test("saves to analytics with the rendered title, exact sql, and current chart selection", async () => {
    const sql = [
      "SELECT model,",
      "  sum(total_cost_usd) AS total_cost_usd",
      "FROM events",
      "GROUP BY model",
    ].join("\n");
    const result = createSuccessResult({ title: "Backend title" });

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{
          sql,
          title: "Spend by model",
        }}
        result={result}
        status="completed"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Add to analytics dashboard" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

    expect(saveMock).toHaveBeenCalledWith({
      label: "Spend by model",
      sql,
      chartType: "bar",
    });
    expect(navigateToAnalyticsMock).toHaveBeenCalledTimes(0);
    expect(view.getByText("Added to analytics dashboard.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Open dashboard" }));

    expect(navigateToAnalyticsMock).toHaveBeenCalledTimes(1);
  });

  test("shows an inline error and re-enables saving when dashboard save fails", async () => {
    saveBehavior = {
      type: "reject",
      error: new Error("Dashboard save failed"),
    };

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events" }}
        result={createSuccessResult()}
        status="completed"
      />
    );

    const addButton = view.getByRole("button", {
      name: "Add to analytics dashboard",
    }) as HTMLButtonElement;

    fireEvent.click(addButton);

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("Dashboard save failed")
    );

    expect(addButton.disabled).toBe(false);
    expect(view.queryByRole("button", { name: "Open dashboard" })).toBeNull();
  });

  test("shows an inline unavailable message when dashboard save is not supported", async () => {
    saveBehavior = {
      type: "resolve",
      value: null,
    };

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events" }}
        result={createSuccessResult()}
        status="completed"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Add to analytics dashboard" }));

    await waitFor(() =>
      expect(
        view.getByText("Analytics dashboard saving is unavailable in this build.")
      ).toBeTruthy()
    );

    expect(view.queryByRole("button", { name: "Open dashboard" })).toBeNull();
    expect(view.getByText("gpt-5")).toBeTruthy();
  });

  test("clears stale saved state when the chart type changes after saving", async () => {
    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events" }}
        result={createSuccessResult()}
        status="completed"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Add to analytics dashboard" }));

    await waitFor(() => expect(view.getByText("Added to analytics dashboard.")).toBeTruthy());

    fireEvent.click(view.getByRole("button", { name: "Bar" }));

    await waitFor(() =>
      expect(view.queryByText("Added to analytics dashboard.") === null).toBe(true)
    );

    expect(view.getByRole("button", { name: "Add to analytics dashboard" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Open dashboard" })).toBeNull();
  });
});
