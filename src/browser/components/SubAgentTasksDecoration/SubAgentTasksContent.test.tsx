import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { SubAgentTasksContent } from "./SubAgentTasksDecoration";

function task(id: string, options: Partial<FrontendWorkspaceMetadata>): FrontendWorkspaceMetadata {
  return {
    id,
    name: id,
    projectName: "xum",
    projectPath: "/repo/xum",
    namedWorkspacePath: `/tmp/${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: "parent",
    ...options,
  };
}

// The content component takes all of its data as props, so the VS Code webview can render the
// tray without WorkspaceContext or WorkspaceStore (#5109).
describe("SubAgentTasksContent", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const running = task("child-running", { title: "Explorer", taskStatus: "running" });
  const reported = task("child-reported", { title: "Reviewer", taskStatus: "reported" });

  test("renders nothing without sub-agents or workflow runs", () => {
    const view = render(
      <SubAgentTasksContent
        subAgents={[]}
        workflowGroups={[]}
        descendantActivity={new Map()}
        expanded={true}
        onToggle={() => undefined}
        onNavigate={() => undefined}
      />
    );
    expect(view.container.textContent).toBe("");
  });

  test("summarizes from props and navigates from an expanded row", () => {
    const onToggle = mock(() => undefined);
    const onNavigate = mock((_workspaceId: string) => undefined);
    const props = {
      subAgents: [
        { workspace: running, depth: 1 },
        { workspace: reported, depth: 1 },
      ],
      workflowGroups: [],
      // An armed monitor keeps the reported child active and shows it as Monitoring.
      descendantActivity: new Map([
        [reported.id, { hasActiveBashMonitor: true, isLiveActive: false }],
      ]),
      onToggle,
      onNavigate,
    };
    const view = render(<SubAgentTasksContent {...props} expanded={false} />);
    expect(view.container.textContent).toContain("2 sub-agents · 2 active");
    expect(view.queryByText("Reviewer")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /2 sub-agents/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(<SubAgentTasksContent {...props} expanded={true} />);
    expect(view.getByRole("button", { name: /Reviewer/ }).textContent).toContain("Monitoring");
    fireEvent.click(view.getByRole("button", { name: /Explorer/ }));
    expect(onNavigate.mock.calls).toEqual([[running.id]]);
  });
});
