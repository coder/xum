import "../../../../tests/ui/dom";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import type { DaytonaResources } from "@/browser/hooks/useDaytonaResources";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import { installDom } from "../../../../tests/ui/dom";
import { createSelectPrimitiveDouble } from "../../../../tests/ui/selectPrimitiveDouble";
import { DaytonaSandboxForm } from "./DaytonaControls";

// Capture before installing the module mock; mock.restore() does not undo it.
const actualSelectPrimitiveModule = { ...ActualSelectPrimitiveModule };
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
  createSelectPrimitiveDouble()
);

const READY: DaytonaResources = {
  config: {
    apiKeySet: true,
    apiKeySource: "settings",
    apiUrl: "https://app.daytona.io/api",
    target: null,
  },
  configError: null,
  snapshots: ["base", "node"],
  snapshotsError: null,
  loadingSnapshots: false,
};

describe("DaytonaSandboxForm snapshot row", () => {
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

  function renderForm(config: DaytonaSandboxConfig, resources: Partial<DaytonaResources> = {}) {
    const onConfigChange = mock((_config: DaytonaSandboxConfig) => undefined);
    const view = render(
      <DaytonaSandboxForm
        config={config}
        onConfigChange={onConfigChange}
        resources={{ ...READY, ...resources }}
      />
    );
    const open = () => fireEvent.pointerDown(view.getByTestId("daytona-snapshot-select"));
    return { view, onConfigChange, open };
  }

  test("shows no snapshot picker while the list loads", () => {
    const { view } = renderForm({}, { loadingSnapshots: true });
    expect(view.queryByTestId("daytona-snapshot-select")).toBeNull();
  });

  test("keeps a saved snapshot the list no longer has, and reports a failed list", () => {
    const { view, open } = renderForm(
      { snapshot: "gone" },
      { snapshots: [], snapshotsError: "boom" }
    );
    expect(view.getByTestId("daytona-snapshot-select").textContent).toBe("gone");
    expect(view.getByRole("alert").textContent).toContain("boom");
    open();
    expect(view.getByRole("button", { name: "gone" })).toBeTruthy();
  });

  test("lists a saved snapshot once when the list has it", () => {
    const { view, open } = renderForm({ snapshot: "node" });
    open();
    expect(view.getAllByRole("button", { name: "node" })).toHaveLength(1);
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("picking a snapshot sets it, and picking the default clears it", () => {
    const picked = renderForm({ cpu: 2 });
    picked.open();
    fireEvent.click(picked.view.getByRole("button", { name: "base" }));
    expect(picked.onConfigChange).toHaveBeenLastCalledWith({ cpu: 2, snapshot: "base" });
    cleanup();

    const cleared = renderForm({ snapshot: "base" });
    cleared.open();
    fireEvent.click(cleared.view.getByRole("button", { name: "Daytona default" }));
    expect(cleared.onConfigChange).toHaveBeenLastCalledWith({ snapshot: undefined });
  });
});
