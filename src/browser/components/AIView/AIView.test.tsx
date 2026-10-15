import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "../Tooltip/Tooltip";
import { AIView } from "./AIView";

let cleanupDom: (() => void) | null = null;

describe("AIView incompatible workspace", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // The collapsed left sidebar has no width, so this page, which has no workspace header, must
  // carry the reopen control itself or a pointer user is stuck on it.
  test("keeps a pointer-accessible way to reopen the collapsed left sidebar", () => {
    const onToggle = mock(() => undefined);
    const view = render(
      <TooltipProvider>
        <AIView
          workspaceId="ws-1"
          projectPath="/projects/demo"
          projectName="demo"
          workspaceName="ws"
          namedWorkspacePath="/projects/demo/ws"
          leftSidebarCollapsed
          onToggleLeftSidebarCollapsed={onToggle}
          incompatibleRuntime="Created with a newer version."
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Open sidebar menu" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
