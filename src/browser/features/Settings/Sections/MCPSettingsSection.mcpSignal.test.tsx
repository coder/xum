import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { subscribeWorkspaceMcpOverridesSaved } from "@/browser/utils/workspaceMcpMutations";
import { MCPSettingsSection } from "./MCPSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

// MCP App entry points are listed for enabled servers only, so every global server change in
// Settings must tell the entry point list to re-list (see workspaceMcpMutations).
test("adding, editing, toggling and removing a server each signal an MCP change", async () => {
  const api = createMockORPCClient({
    globalMcpServers: { alpha: { transport: "stdio", command: "alpha-mcp", disabled: false } },
  });
  const signals: Array<string | null> = [];
  const unsubscribe = subscribeWorkspaceMcpOverridesSaved((workspaceId) =>
    signals.push(workspaceId)
  );
  try {
    const view = render(
      <TooltipProvider>
        <APIProvider client={api}>
          <MCPSettingsSection />
        </APIProvider>
      </TooltipProvider>
    );

    fireEvent.click(await view.findByRole("button", { name: "Edit server" }));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(view.getByDisplayValue("alpha-mcp"), " --v2");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(signals).toEqual([null]));

    fireEvent.click(await view.findByRole("switch", { name: "Toggle alpha enabled" }));
    await waitFor(() => expect(signals).toEqual([null, null]));

    fireEvent.click(view.getByRole("button", { name: "Remove server" }));
    await waitFor(() => expect(signals).toEqual([null, null, null]));

    await user.type(view.getByPlaceholderText("e.g., memory"), "beta");
    await user.type(view.getByPlaceholderText(/server-memory/), "beta-mcp");
    fireEvent.click(view.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(signals).toEqual([null, null, null, null]));
  } finally {
    unsubscribe();
  }
});
