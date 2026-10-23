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
      preview: {
        source,
        lockedSha: "b".repeat(40),
        manifest: { name: "tools-next" },
        skills: [{ name: "alpha" }],
        mcpServers: [],
        agents: [],
        workflows: [],
        slashCommands: [],
        reviewedComponents: [],
        codexHooks: [],
        warnings: [],
        targetPath: "~/.mux/plugins/tools-next",
        consentDigest: "c".repeat(64),
        method: { kind: "agent-plugin" },
        methods: [{ kind: "agent-plugin" }],
        skillsCliSkills: [],
      },
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

// The other half of #7122: an Escape that the panel does not own still closes Settings.
test("Escape outside Manage components still closes Settings (#7122)", async () => {
  const onOpenChange = mock((_open: boolean) => undefined);
  const view = renderInSettings(createApi(), onOpenChange);
  const manage = await view.findByRole("button", { name: "Manage components for tools" });
  fireEvent.click(manage);
  await view.findByText(/Manage components from the installed version/);
  manage.focus();
  fireEvent.keyDown(manage, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

/** Focus that falls out of an unmounted control lands on the Settings dialog (or the body). */
function focusFellOut(): boolean {
  const active = document.activeElement;
  return !(active instanceof HTMLElement) || active === document.body || active.role === "dialog";
}

// #7121: the source form unmounts when the preview opens, and the preview unmounts on Install.
test("Preview on Enter and Install keep focus on a control of the new view (#7121)", async () => {
  const view = renderInSettings(createApi(), () => undefined);
  fireEvent.click(await view.findByRole("button", { name: "Add plugin" }));
  await userEvent.type(await view.findByLabelText(/Git URL or owner\/repo/), "acme/tools{Enter}");
  await view.findByText("tools-next");
  const afterPreview = focusFellOut();

  await userEvent.click(view.getByRole("button", { name: "Install" }));
  await view.findByText("Plugin installed.");
  expect({ afterPreview, afterInstall: focusFellOut() }).toEqual({
    afterPreview: false,
    afterInstall: false,
  });
});
