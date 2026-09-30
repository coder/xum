import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { SavedQuery } from "@/common/types/savedQueries";
import * as RealUseAnalyticsModule from "@/browser/hooks/useAnalytics";
import * as RealSavedQuerySqlDialogModule from "@/browser/features/Analytics/SavedQuerySqlDialog";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

const executeQueryMock = mock(() => Promise.resolve());
const useAnalyticsRawQueryMock = mock(() => ({
  data: null,
  loading: false,
  error: null,
  executeQuery: executeQueryMock,
}));

// The stub below exports only useAnalyticsRawQuery; restore the real hooks afterwards so later
// suites (useAnalytics.test) do not import undefined hooks.
restoreModulesAfterSuite([
  ["@/browser/hooks/useAnalytics", { ...RealUseAnalyticsModule }],
  ["@/browser/features/Analytics/SavedQuerySqlDialog", { ...RealSavedQuerySqlDialogModule }],
]);
void mock.module("@/browser/hooks/useAnalytics", () => ({
  useAnalyticsRawQuery: useAnalyticsRawQueryMock,
}));

void mock.module("@/browser/features/Analytics/SavedQuerySqlDialog", () => ({
  SavedQuerySqlDialog: (props: {
    open: boolean;
    label: string;
    sql: string;
    saveDisabled: boolean;
    error: string | null;
    onSqlChange: (nextSql: string) => void;
    onOpenChange: (open: boolean) => void;
    onSave: () => void;
  }) =>
    props.open ? (
      <div>
        <h2>{`Edit SQL — ${props.label}`}</h2>
        <textarea aria-label="Saved query SQL" readOnly value={props.sql} />
        {props.error ? <div>{props.error}</div> : null}
        <button type="button" onClick={() => props.onSqlChange("\n  SELECT 1;  \n")}>
          Use valid SQL
        </button>
        <button type="button" onClick={() => props.onSqlChange("   ")}>
          Use blank SQL
        </button>
        <button type="button" onClick={() => props.onSqlChange("SELECT broken FROM events")}>
          Use broken SQL
        </button>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" onClick={props.onSave}>
          Submit via keyboard
        </button>
        <button type="button" disabled={props.saveDisabled} onClick={props.onSave}>
          Save
        </button>
      </div>
    ) : null,
}));

import { SavedQueryPanel } from "./SavedQueryPanel";

function createSavedQuery(overrides: Partial<SavedQuery> = {}): SavedQuery {
  return {
    id: "saved-query-1",
    label: "Spend by model",
    sql: "SELECT model, sum(total_cost_usd) AS total_cost_usd\nFROM events\nGROUP BY model",
    chartType: "table",
    order: 0,
    createdAt: "2026-03-06T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(
  overrides: Partial<{
    query: SavedQuery;
    timeFilterSql: string;
    onDelete: (id: string) => Promise<void> | void;
    onUpdate: (input: {
      id: string;
      label?: string;
      sql?: string;
      chartType?: string | null;
    }) => Promise<unknown> | void;
  }> = {}
) {
  const query = overrides.query ?? createSavedQuery();
  const onDelete = overrides.onDelete ?? mock(() => Promise.resolve());
  const onUpdate = overrides.onUpdate ?? mock(() => Promise.resolve(null));

  const buildElement = (timeFilterSql: string) => (
    <TooltipProvider>
      <SavedQueryPanel
        query={query}
        timeFilterSql={timeFilterSql}
        onDelete={onDelete}
        onUpdate={onUpdate}
      />
    </TooltipProvider>
  );

  const view = render(buildElement(overrides.timeFilterSql ?? "TRUE"));

  return {
    ...view,
    query,
    onDelete,
    onUpdate,
    rerenderWithTimeFilter: (nextTimeFilterSql: string) =>
      view.rerender(buildElement(nextTimeFilterSql)),
  };
}

describe("SavedQueryPanel", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    executeQueryMock.mockClear();
    useAnalyticsRawQueryMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("substitutes the dashboard time filter into the saved SQL and re-runs when it changes", async () => {
    const query = createSavedQuery({
      sql: "SELECT model FROM events WHERE {{time_filter}} GROUP BY model",
    });
    const view = renderPanel({ query, timeFilterSql: "(date >= DATE '2026-06-05')" });

    await waitFor(() =>
      expect(executeQueryMock).toHaveBeenCalledWith(
        "SELECT model FROM events WHERE (date >= DATE '2026-06-05') GROUP BY model"
      )
    );

    view.rerenderWithTimeFilter("TRUE");
    await waitFor(() =>
      expect(executeQueryMock).toHaveBeenCalledWith(
        "SELECT model FROM events WHERE TRUE GROUP BY model"
      )
    );
  });

  test("does not re-run placeholder-free SQL when the time filter changes", async () => {
    const view = renderPanel({ timeFilterSql: "TRUE" });

    await waitFor(() => expect(executeQueryMock).toHaveBeenCalledTimes(1));
    expect(executeQueryMock).toHaveBeenCalledWith(view.query.sql);

    view.rerenderWithTimeFilter("(date >= DATE '2026-06-05')");
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
  });

  test("renders a panel-level SQL button and opens the dialog with the saved SQL", () => {
    const view = renderPanel();

    const openSqlDialogButton = view.getByRole("button", { name: "View or edit SQL" });
    fireEvent.click(openSqlDialogButton);

    const sqlInput = view.getByRole("textbox", { name: "Saved query SQL" }) as HTMLTextAreaElement;
    expect(sqlInput.value).toBe(view.query.sql);
    const saveButton = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  test("trims edited SQL and saves it through onUpdate", async () => {
    const onUpdate = mock(() => Promise.resolve(null));
    const view = renderPanel({ onUpdate });

    fireEvent.click(view.getByRole("button", { name: "View or edit SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Use valid SQL" }));

    const saveButton = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({ id: view.query.id, sql: "SELECT 1;" })
    );
    await waitFor(() =>
      expect(view.queryByRole("textbox", { name: "Saved query SQL" })).toBeNull()
    );
  });

  test("shows an inline validation error when keyboard-save is attempted with blank SQL", async () => {
    const onUpdate = mock(() => Promise.resolve(null));
    const view = renderPanel({ onUpdate });

    fireEvent.click(view.getByRole("button", { name: "View or edit SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Use blank SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Submit via keyboard" }));

    await waitFor(() => expect(view.getByText("SQL cannot be empty.")).toBeTruthy());
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("shows an inline error instead of crashing when a saved panel id is blank", async () => {
    const onUpdate = mock(() => Promise.resolve(null));
    const view = renderPanel({ query: createSavedQuery({ id: "   " }), onUpdate });

    fireEvent.click(view.getByRole("button", { name: "View or edit SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Use valid SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        view.getByText("This saved panel is missing its ID and cannot be updated.")
      ).toBeTruthy()
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("keeps the dialog open and shows the backend error when saving fails", async () => {
    const onUpdate = mock(() => Promise.reject(new Error("DuckDB parse error")));
    const view = renderPanel({ onUpdate });

    fireEvent.click(view.getByRole("button", { name: "View or edit SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Use broken SQL" }));

    const saveButton = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() => expect(view.getByText("DuckDB parse error")).toBeTruthy());
    expect(view.getByRole("textbox", { name: "Saved query SQL" })).toBeTruthy();
  });

  test("cancelling discards unsaved SQL edits before the next open", () => {
    const view = renderPanel();

    fireEvent.click(view.getByRole("button", { name: "View or edit SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Use broken SQL" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(view.queryByRole("textbox", { name: "Saved query SQL" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "View or edit SQL" }));
    const reopenedSqlInput = view.getByRole("textbox", {
      name: "Saved query SQL",
    }) as HTMLTextAreaElement;
    expect(reopenedSqlInput.value).toBe(view.query.sql);
  });
});
