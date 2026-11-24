import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginListItem } from "@/common/orpc/schemas/agentPlugins";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const managed: AgentPluginListItem = {
  name: "kit",
  managed: true,
  present: true,
  location: "~/.mux/plugins/kit",
  version: "1.0.0",
  source: { type: "git", url: "https://github.com/acme/kit.git", ref: "main", refType: "branch" },
  lockedSha: "0123456789abcdef0123456789abcdef01234567",
  installedAt: "2026-08-01T12:00:00.000Z",
  skillCount: 3,
  mcpServerCount: 2,
  importedSkillCount: 0,
  importedMcpServerCount: 0,
};

const handmade: AgentPluginListItem = {
  name: "handmade",
  managed: false,
  present: true,
  location: "~/.agents/plugins/handmade",
  skillCount: 1,
  mcpServerCount: 0,
};

function renderSection(items: AgentPluginListItem[]) {
  return render(
    <APIProvider
      client={createMockORPCClient({ agentPlugins: { items, containerLocation: "/srv/plugins" } })}
    >
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
}

test("the intro names the plugins folder as code", async () => {
  const view = renderSection([]);

  const folder = await view.findByText("/srv/plugins");
  expect(folder.tagName).toBe("CODE");
  expect(view.queryByText(/the managed plugins directory/)).toBeNull();
});

test("each row counts what it imported, then shows its folder and where it came from", async () => {
  const view = renderSection([managed, handmade]);

  await view.findByText("kit");
  const counts = view.getAllByText(/skills imported/).map((line) => line.textContent);
  expect(counts).toEqual([
    "0 of 3 skills imported · 0 of 2 MCP servers imported · ~/.mux/plugins/kit",
    "1 of 1 skills imported · 0 of 0 MCP servers imported · ~/.agents/plugins/handmade",
  ]);
  // The commit hash is cut to 12 characters, and a plugin with no source shows no source line.
  expect(view.getAllByText(/ @ /).map((line) => line.textContent)).toEqual([
    "github.com/acme/kit @ main · 0123456789ab",
  ]);
});
