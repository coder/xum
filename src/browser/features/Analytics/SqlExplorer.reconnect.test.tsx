// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { RawQueryResult } from "@/common/orpc/schemas/analytics";
import { SqlExplorer } from "./SqlExplorer";

function result(value: string): RawQueryResult {
  return {
    columns: [{ name: "value", type: "VARCHAR" }],
    rows: [{ value }],
    truncated: false,
    rowCount: 1,
    rowCountExact: true,
    durationMs: 1,
  };
}

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    analytics: { executeRawQuery: () => Promise.resolve(result("first result")) },
  };
}

// happy-dom does not deliver React's synthetic onChange for controlled fields, so call the
// field's React onChange prop directly (same workaround as InstructionsSection.test.tsx).
function typeInto(field: HTMLElement, value: string) {
  const reactPropsKey = Object.keys(field).find((key) => key.startsWith("__reactProps"));
  const reactProps = (
    reactPropsKey ? (field as unknown as Record<string, unknown>)[reactPropsKey] : null
  ) as { onChange?: (event: { target: { value: string } }) => void } | null;
  const onChange = reactProps?.onChange;
  if (!onChange) throw new Error("Expected the field to expose its onChange handler");
  act(() => onChange({ target: { value } }));
}

// A run while offline never reached the server. The shown results still belong to the SQL that
// ran, so "Save as Panel" must save that SQL, not the edited one that never ran.
describe.each([...GAP_MODES])("SqlExplorer while offline (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("an offline run does not make Save as Panel save the SQL that never ran", async () => {
    const harness = createConnectionHarness(mode, serverOverrides);
    const saved: string[] = [];
    const view = render(
      <harness.Wrapper>
        <SqlExplorer
          timeFilterSql="TRUE"
          onSaveQuery={(input) => {
            saved.push(input.sql);
            return Promise.resolve(null);
          }}
        />
      </harness.Wrapper>
    );
    const editor = view.getByPlaceholderText("SELECT * FROM events LIMIT 10;");
    typeInto(editor, "SELECT 'ran'");
    fireEvent.click(view.getByRole("button", { name: /Run Query/ }));
    await waitFor(() => expect(view.queryByText("first result")).not.toBeNull());

    await harness.drop();
    typeInto(editor, "SELECT 'never ran'");
    fireEvent.click(view.getByRole("button", { name: /Run Query/ }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const saveAsPanel = view.queryByRole("button", { name: /Save as Panel/ });
    if (saveAsPanel != null) {
      fireEvent.click(saveAsPanel);
      typeInto(view.getByPlaceholderText("Panel title"), "Panel");
      fireEvent.click(view.getByRole("button", { name: "Save panel" }));
      await waitFor(() => expect(saved).toHaveLength(1));
    }
    expect(saved).not.toContain("SELECT 'never ran'");
  });
});
