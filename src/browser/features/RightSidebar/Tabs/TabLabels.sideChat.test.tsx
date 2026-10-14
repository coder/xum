import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
  type WorkspaceMetadataContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import { SideChatTabLabel, SideChatTabTitle } from "./TabLabels";

let cleanupDom: () => void;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom();
});

test("side-chat label and tooltip follow the chat's live title and preserve its close action", () => {
  let closed = 0;
  const fixture = (title?: string) => {
    const workspace = createWorkspace({
      id: "side-1",
      name: "side-internal-name",
      projectName: "project",
      title,
    });
    // This leaf consumes only metadata, not workspace actions or selection.
    const value: WorkspaceMetadataContextValue = {
      workspaceMetadata: new Map([[workspace.id, workspace]]),
      loading: false,
      loaded: true,
      loadError: null,
    };
    return (
      <WorkspaceContext.Provider value={value as WorkspaceContextValue}>
        <TooltipProvider>
          <SideChatTabLabel
            workspaceId="side-1"
            onClose={() => {
              closed += 1;
            }}
          />
          <div data-testid="outer-tooltip">
            <SideChatTabTitle workspaceId="side-1" />
          </div>
        </TooltipProvider>
      </WorkspaceContext.Provider>
    );
  };
  const view = render(fixture());
  expect(view.getAllByText("New chat")).toHaveLength(2);
  expect(view.queryByText("side-internal-name")).toBeNull();

  const title = "Investigate a very long generated chat title without changing the close action";
  view.rerender(fixture(title));
  expect(view.getAllByText(title)).toHaveLength(2);
  expect(view.queryByText("New chat")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Close side chat" }));
  expect(closed).toBe(1);

  view.rerender(fixture("Renamed by the user"));
  expect(view.getAllByText("Renamed by the user")).toHaveLength(2);
});
