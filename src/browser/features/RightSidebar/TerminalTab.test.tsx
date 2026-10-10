import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as RealTerminalViewModule from "@/browser/components/TerminalView/TerminalView";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { TerminalTab } from "./TerminalTab";

let cleanupDom: (() => void) | null = null;
let terminalViewProps: Array<Record<string, unknown>> = [];

restoreModulesAfterSuite([
  ["@/browser/components/TerminalView/TerminalView", { ...RealTerminalViewModule }],
]);
// The real view needs ghostty-web and a terminal router; record its props instead.
void mock.module("@/browser/components/TerminalView/TerminalView", () => ({
  TerminalView: (props: Record<string, unknown>) => {
    terminalViewProps.push(props);
    return <div data-testid="terminal-view" />;
  },
}));

function renderTab(tabType: `terminal:${string}` | "terminal") {
  const workspaceContext = {
    workspaceMetadata: new Map([
      ["ws-1", { id: "ws-1", name: "feature", projectName: "app" } as FrontendWorkspaceMetadata],
    ]),
    loading: false,
    loaded: true,
    loadError: null,
  } as unknown as WorkspaceContextValue;
  return render(
    <WorkspaceContext.Provider value={workspaceContext}>
      <TerminalTab
        workspaceId="ws-1"
        tabType={tabType}
        visible={true}
        tabName="Terminal 1"
        tabIndex={0}
        autoFocus={true}
      />
    </WorkspaceContext.Provider>
  );
}

describe("TerminalTab", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    terminalViewProps = [];
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows the missing-session error without mounting the terminal", () => {
    const view = renderTab("terminal");

    expect(view.getByText("Invalid terminal tab: missing session ID")).toBeTruthy();
    expect(view.queryByTestId("terminal-view")).toBeNull();
    expect(terminalViewProps).toHaveLength(0);
  });

  // The terminal (ghostty-web) is code-split off the first load, so it mounts only after its
  // chunk resolves, and it must still get the tab's session and workspace.
  test("mounts the terminal after its chunk loads, with the tab's session", async () => {
    const view = renderTab("terminal:session-7");

    expect(view.queryByTestId("terminal-view")).toBeNull();
    expect(await view.findByTestId("terminal-view")).toBeTruthy();
    expect(terminalViewProps.at(-1)).toMatchObject({
      workspaceId: "ws-1",
      sessionId: "session-7",
      visible: true,
      autoFocus: true,
      tabName: "Terminal 1",
      tabIndex: 0,
      workspaceName: "feature",
      projectName: "app",
    });
  });
});
