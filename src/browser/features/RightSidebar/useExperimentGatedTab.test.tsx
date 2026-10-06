// Bootstrap Happy DOM before anything touches window (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { installDom } from "../../../../tests/ui/dom";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { APIProvider } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { createTestApiClient } from "@/browser/testUtils";
import {
  getDefaultRightSidebarLayoutState,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import { useExperimentGatedTab } from "./useExperimentGatedTab";

// The user's saved layout [..., artifacts, goal] with Artifacts selected.
function savedLayout(): RightSidebarLayoutState {
  const layout = getDefaultRightSidebarLayoutState("costs");
  if (layout.root.type !== "tabset") throw new Error("default layout must be one tabset");
  const tabs = [
    ...layout.root.tabs.filter((tab) => tab !== "artifacts" && tab !== "goal"),
    "artifacts" as const,
    "goal" as const,
  ];
  return { ...layout, root: { ...layout.root, tabs, activeTab: "artifacts" } };
}

function describeLayout(layout: RightSidebarLayoutState): string {
  return layout.root.type === "tabset"
    ? `${layout.root.tabs.join(",")}|${layout.root.activeTab}`
    : "split";
}

function LayoutProbe() {
  const [layout, setLayout] = React.useState<RightSidebarLayoutState>(savedLayout);
  useExperimentGatedTab({
    tab: "artifacts",
    experimentId: EXPERIMENT_IDS.ARTIFACTS,
    initialActiveTab: "costs",
    setLayoutRaw: setLayout,
  });
  return <div data-testid="layout">{describeLayout(layout)}</div>;
}

function renderWithOverrides(getOverrides: () => Promise<Record<string, boolean>>) {
  const client = createTestApiClient({ experiments: { getOverrides } });
  return render(
    <APIProvider client={client}>
      <ExperimentsProvider>
        <LayoutProbe />
      </ExperimentsProvider>
    </APIProvider>
  );
}

const SAVED = describeLayout(savedLayout());

describe("useExperimentGatedTab", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the saved tab order and selection while the backend flag loads", async () => {
    let finishRead!: () => void;
    const read = new Promise<Record<string, boolean>>((resolve) => {
      finishRead = () => resolve({ [EXPERIMENT_IDS.ARTIFACTS]: true });
    });
    const view = renderWithOverrides(() => read);

    // Before the backend answers, the flag reads its default (off): the tab must stay put.
    expect(view.getByTestId("layout").textContent).toBe(SAVED);

    await act(async () => {
      finishRead();
      await read;
    });

    expect(view.getByTestId("layout").textContent).toBe(SAVED);
  });

  test("keeps the saved layout when the backend read fails", async () => {
    const read = Promise.reject(new Error("offline"));
    const view = renderWithOverrides(() => read);

    await act(async () => {
      await read.catch(() => undefined);
    });

    expect(view.getByTestId("layout").textContent).toBe(SAVED);
  });

  test("removes the tab once the loaded flag is off", async () => {
    const view = renderWithOverrides(() => Promise.resolve({}));

    await waitFor(() => expect(view.getByTestId("layout").textContent).not.toContain("artifacts"));
  });
});
