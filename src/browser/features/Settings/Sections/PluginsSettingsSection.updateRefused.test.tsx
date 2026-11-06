import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type {
  AgentPluginListItem,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const item: AgentPluginListItem = {
  name: "egm",
  managed: true,
  present: true,
  location: "~/.mux/plugins/egm",
  lockedSha: "a".repeat(40),
  skillCount: 7,
  mcpServerCount: 0,
};

const refused: AgentPluginUpdateReview = {
  name: "egm",
  fromSha: "a".repeat(40),
  toSha: "b".repeat(40),
  changes: [],
  warnings: [],
  refused:
    ".claude-plugin/plugin.json is gone in this commit. Methods that fit this commit: Agent Plugin, Cursor plugin. To switch, uninstall the plugin and install it again.",
};

function renderSection(review: AgentPluginUpdateReview) {
  const api = createMockORPCClient({
    agentPlugins: {
      items: [item],
      updateChecks: [{ name: "egm", status: "update-available", remoteSha: "b".repeat(40) }],
      updateReview: review,
    },
  });
  return render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
}

test("a refused update shows its message and offers Remove plugin, never an apply", async () => {
  const view = renderSection(refused);
  fireEvent.click(await view.findByRole("button", { name: /^Update$/ }));

  await view.findByText(/\.claude-plugin\/plugin\.json is gone in this commit/);
  // The plugin is on disk and loads: no "missing" or "needs reinstall" badge.
  expect(view.queryByText("missing")).toBeNull();
  expect(view.queryByText("needs reinstall")).toBeNull();
  view.getByText(/Nothing was changed\. The plugin stays on aaaaaaaaaaaa/);
  expect(view.queryByRole("button", { name: "Apply update" })).toBeNull();
  expect(view.queryByText(/This removes the plugin directory/)).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Remove plugin" }));
  await view.findByText(/This removes the plugin directory/);
  expect(view.queryByText(/is gone in this commit/)).toBeNull();
});

test("Close dismisses a refused update and leaves the plugin as it was", async () => {
  const view = renderSection(refused);
  fireEvent.click(await view.findByRole("button", { name: /^Update$/ }));
  await view.findByText(/is gone in this commit/);

  fireEvent.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByText(/is gone in this commit/)).toBeNull());
  expect(view.queryByText(/This removes the plugin directory/)).toBeNull();
  view.getByRole("button", { name: /^Update$/ });
});

test("an update review without a refusal still asks for confirmation", async () => {
  const view = renderSection({
    name: "egm",
    fromSha: "a".repeat(40),
    toSha: "b".repeat(40),
    changes: [{ summary: "adds the agent 'design_critic'", after: "Reviews designs" }],
    warnings: [],
  });
  fireEvent.click(await view.findByRole("button", { name: /^Update$/ }));
  await view.findByRole("button", { name: "Apply update" });
  expect(view.queryByRole("button", { name: "Remove plugin" })).toBeNull();
});

test("a plugin that an older Xum version moved says why it loads nothing, and keeps Uninstall", async () => {
  const closedReason =
    "An older Xum version updated this plugin after you chose how to install it, so Xum has not reviewed that manifest at this commit. The plugin loads nothing. Uninstall it and install it again to review it.";
  const api = createMockORPCClient({
    agentPlugins: {
      items: [{ ...item, present: false, skillCount: 0, closedReason }],
    },
  });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );

  await view.findByText(/An older Xum version updated this plugin/);
  view.getByText("needs reinstall");
  expect(view.queryByText("missing")).toBeNull();
  expect(view.queryByRole("button", { name: /Manage components/ })).toBeNull();
  view.getByRole("button", { name: "Uninstall egm" });
});
