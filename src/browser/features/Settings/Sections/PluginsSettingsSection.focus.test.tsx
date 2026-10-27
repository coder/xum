import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { Dialog, DialogContent, DialogTitle } from "@/browser/components/Dialog/Dialog";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import type { AgentPluginInstallPreview } from "@/common/orpc/schemas/agentPlugins";
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
      preview: pluginPreview,
    },
  });
}

const pluginPreview: AgentPluginInstallPreview = {
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
};

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
    expect(view.queryByText(/Manage components from the installed version/) === null).toBe(true)
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

/** Settings with the Add plugin panel open and the source typed, ready for Enter. */
async function openAddPanel(api: ReturnType<typeof createApi>) {
  const view = renderInSettings(api, () => undefined);
  fireEvent.click(await view.findByRole("button", { name: "Add plugin" }));
  const sourceField = await view.findByLabelText(/Git URL or owner\/repo/);
  await userEvent.type(sourceField, "acme/tools");
  // userEvent.keyboard has no document in this harness, so Enter goes through type().
  const pressEnter = () => userEvent.type(sourceField, "{Enter}");
  return { view, pressEnter };
}

// #7121: the source form unmounts when the preview opens. Its first control takes the focus.
test("Enter in the source field focuses the first control of the preview (#7121)", async () => {
  const { view, pressEnter } = await openAddPanel(createApi());
  await pressEnter();
  await view.findByText("tools-next");
  // "Select all" is disabled (every component starts selected), so "Clear" comes first.
  await waitFor(() =>
    expect(document.activeElement).toBe(view.getAllByRole("button", { name: "Clear" })[0])
  );
});

// #7121: Install and Cancel unmount the panel. The Add plugin button comes back with the focus.
test.each(["Install", "Cancel"])(
  "%s gives the focus to the Add plugin button (#7121)",
  async (action) => {
    const { view, pressEnter } = await openAddPanel(createApi());
    if (action === "Install") {
      await pressEnter();
      await view.findByText("tools-next");
    }
    await userEvent.click(view.getByRole("button", { name: action }));
    const addPlugin = await view.findByRole("button", { name: "Add plugin" });
    expect(document.activeElement).toBe(addPlugin);
  }
);

// Another Install as method (a new preview) or the Skills CLI choice rerenders the view without
// moving the focus.
test.each(["Claude Code plugin", "Skills CLI"])(
  "picking %s as the install method keeps the focus on that choice (#7121)",
  async (choiceName) => {
    const api = createApi();
    spyOn(api.agentPlugins, "preview").mockImplementation((input) => {
      const kind = input.method?.kind ?? "agent-plugin";
      return Promise.resolve({
        success: true as const,
        data: {
          kind: "plugin" as const,
          preview: {
            ...pluginPreview,
            manifest: { name: `tools-${kind}` },
            method: kind === "claude-plugin" ? { kind } : { kind: "agent-plugin" as const },
            methods: [{ kind: "agent-plugin" as const }, { kind: "claude-plugin" as const }],
            skillsCliSkills: ["alpha"],
          },
        },
      });
    });
    const { view, pressEnter } = await openAddPanel(api);
    await pressEnter();
    await view.findByText("tools-agent-plugin");
    const choice = view.getByRole("radio", { name: choiceName });
    await userEvent.click(choice);
    await waitFor(() => expect(choice.getAttribute("aria-checked")).toBe("true"));
    if (choiceName === "Claude Code plugin") await view.findByText("tools-claude-plugin");
    expect(document.activeElement).toBe(choice);
  }
);

// Codex round 1 on #7298: a slow preview or install must not take the focus from a control
// the user moved to while it loaded.
test.each(["preview", "install"] as const)(
  "a slow %s keeps the focus on a control the user moved to (#7121)",
  async (slow) => {
    const api = createApi();
    let finish = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (slow === "preview") {
      const realPreview = api.agentPlugins.preview;
      spyOn(api.agentPlugins, "preview").mockImplementation(async (input) => {
        await gate;
        return realPreview(input);
      });
    } else {
      const realInstall = api.agentPlugins.install;
      spyOn(api.agentPlugins, "install").mockImplementation(async (input) => {
        await gate;
        return realInstall(input);
      });
    }
    const { view, pressEnter } = await openAddPanel(api);
    const manage = view.getByRole("button", { name: "Manage components for tools" });
    if (slow === "install") {
      await pressEnter();
      await view.findByText("tools-next");
      await userEvent.click(view.getByRole("button", { name: "Install" }));
    } else {
      await pressEnter();
    }
    manage.focus();
    finish();
    await view.findByText(slow === "install" ? "Plugin installed." : "tools-next");
    expect(document.activeElement).toBe(manage);
  }
);
