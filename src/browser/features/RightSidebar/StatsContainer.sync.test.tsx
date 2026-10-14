import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import * as CostsTabModule from "./CostsTab";
import * as ContextTabModule from "./ContextTab";
import * as ContextUsageSectionModule from "./ContextUsageSection";
import * as StatsTabModule from "./StatsTab";
import { StatsContainer } from "./StatsContainer";

// While the right sidebar is CSS-hidden it stays mounted with its Stats tab, and the Stats dialog
// (#5767) mounts a second StatsContainer. A choice made in one must show in the other.
describe("StatsContainer copies", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    // The panels need the workspace store; this test is about which panel each copy shows.
    spyOn(CostsTabModule, "CostsTab").mockImplementation((() => (
      <div>cost panel</div>
    )) as unknown as typeof CostsTabModule.CostsTab);
    spyOn(ContextTabModule, "ContextTab").mockImplementation(() => <div>context panel</div>);
    spyOn(ContextUsageSectionModule, "ContextUsageSection").mockImplementation(() => null);
    spyOn(StatsTabModule, "TimingPanel").mockImplementation(() => <div>timing panel</div>);
    spyOn(StatsTabModule, "ModelBreakdownPanel").mockImplementation(() => <div>models panel</div>);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a sub-tab picked in one copy shows in the other", () => {
    const view = render(
      <>
        <div data-testid="sidebar">
          <StatsContainer workspaceId="workspace-1" />
        </div>
        <div data-testid="dialog">
          <StatsContainer workspaceId="workspace-1" />
        </div>
      </>
    );
    const sidebar = within(view.getByTestId("sidebar"));
    expect(sidebar.getByText("cost panel")).toBeTruthy();

    fireEvent.click(within(view.getByTestId("dialog")).getByRole("button", { name: "Timing" }));

    expect(sidebar.getByText("timing panel")).toBeTruthy();
  });
});
