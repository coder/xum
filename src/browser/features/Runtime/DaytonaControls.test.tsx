import "../../../../tests/ui/dom";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import type {
  DaytonaListSnapshotsResult,
  DaytonaSandboxConfig,
} from "@/common/orpc/schemas/daytona";
import { installDom } from "../../../../tests/ui/dom";
import { createSelectPrimitiveDouble } from "../../../../tests/ui/selectPrimitiveDouble";
import { DaytonaCreationForm } from "./DaytonaControls";

// Capture before installing the module mock; mock.restore() does not undo it.
const actualSelectPrimitiveModule = { ...ActualSelectPrimitiveModule };
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
  createSelectPrimitiveDouble()
);

const LISTED: DaytonaListSnapshotsResult = {
  ok: true,
  snapshots: [{ name: "base" }, { name: "node" }],
};

describe("DaytonaCreationForm snapshot row", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module(
      "@/browser/components/SelectPrimitive/SelectPrimitive",
      () => actualSelectPrimitiveModule
    );
  });

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  async function renderForm(config: DaytonaSandboxConfig, listed = LISTED) {
    const onConfigChange = mock((_config: DaytonaSandboxConfig) => undefined);
    const client = createTestApiClient({
      daytona: {
        getConfig: () => Promise.resolve({ apiKeySet: true, apiKeySource: "settings" as const }),
        listSnapshots: () => Promise.resolve(listed),
      },
    });
    const view = render(
      <APIProvider client={client}>
        <DaytonaCreationForm config={config} onConfigChange={onConfigChange} />
      </APIProvider>
    );
    const select = await waitFor(() => view.getByTestId("daytona-snapshot-select"));
    const open = () => fireEvent.pointerDown(select);
    return { view, onConfigChange, open };
  }

  test("keeps a saved snapshot the list no longer has, and reports a failed list", async () => {
    const { view, open } = await renderForm(
      { snapshot: "gone" },
      { ok: false, kind: "server", error: "boom" }
    );
    expect(view.getByTestId("daytona-snapshot-select").textContent).toBe("gone");
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("boom"));
    open();
    expect(view.getByRole("button", { name: "gone" })).toBeTruthy();
  });

  test("picking a snapshot sets it, and picking the default clears it", async () => {
    const picked = await renderForm({ cpu: 2 });
    picked.open();
    fireEvent.click(picked.view.getByRole("button", { name: "base" }));
    expect(picked.onConfigChange).toHaveBeenLastCalledWith({ cpu: 2, snapshot: "base" });
    cleanup();

    const cleared = await renderForm({ snapshot: "base" });
    cleared.open();
    fireEvent.click(cleared.view.getByRole("button", { name: "Daytona default" }));
    expect(cleared.onConfigChange).toHaveBeenLastCalledWith({ snapshot: undefined });
  });
});
