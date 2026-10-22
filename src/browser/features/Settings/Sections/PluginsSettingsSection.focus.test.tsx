import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { Dialog, DialogContent, DialogTitle } from "@/browser/components/Dialog/Dialog";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const source: AgentPluginGitSource = {
  type: "git",
  url: "https://github.com/acme/tools.git",
  ref: "main",
  refType: "branch",
};

function createApi() {
  return createMockORPCClient({
    agentPlugins: {
      items: [
        {
          name: "tools",
          managed: true,
          present: true,
          location: "~/.mux/plugins/tools",
          source,
          lockedSha: "a".repeat(40),
          skillCount: 2,
          mcpServerCount: 0,
        },
      ],
    },
  });
}

/** The section inside a dialog configured like Settings (SettingsPage.tsx). */
function renderInSettings(
  api: ReturnType<typeof createApi>,
  onOpenChange: (open: boolean) => void
) {
  return render(
    <APIProvider client={api}>
      <TooltipProvider>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent aria-describedby={undefined} allowEditableEscape>
            <DialogTitle>Settings</DialogTitle>
            <PluginsSettingsSection />
          </DialogContent>
        </Dialog>
      </TooltipProvider>
    </APIProvider>
  );
}

// #7122: Escape inside Manage components must not close all of Settings.
test("Escape in Manage components closes only the panel and refocuses its button (#7122)", async () => {
  const api = createApi();
  spyOn(api.agentPlugins, "getComponents").mockResolvedValue({
    success: true,
    data: {
      lockedSha: "a".repeat(40),
      contentHash: "d".repeat(64),
      skills: [{ name: "alpha" }, { name: "beta" }],
      mcpServers: [],
    },
  });
  const onOpenChange = mock((_open: boolean) => undefined);
  const view = renderInSettings(api, onOpenChange);
  const manage = await view.findByRole("button", { name: "Manage components for tools" });
  fireEvent.click(manage);
  const alpha = await view.findByRole("checkbox", { name: "alpha" });
  await userEvent.click(alpha);
  await view.findByText(/1 to remove/);

  expect(document.activeElement).toBe(alpha);
  fireEvent.keyDown(alpha, { key: "Escape" });
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
  await waitFor(() =>
    expect(view.queryByText(/Manage components from the installed version/)).toBeNull()
  );
  expect(document.activeElement).toBe(manage);
});
