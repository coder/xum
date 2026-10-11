import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginHooks, AgentPluginListItem } from "@/common/orpc/schemas/agentPlugins";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const hooksAt = (tool: string): AgentPluginHooks => ({
  hooks: [
    {
      key: "hooks/hooks.json#Stop[0][0]",
      hash: tool,
      event: "Stop",
      handler: { type: "mcp_tool", server: "s", tool, input: {}, timeoutSeconds: 30 },
      status: "runnable",
      source: "hooks/hooks.json",
      review: tool === "old_tool" ? "trusted" : "changed",
    },
  ],
  warnings: [],
});

test("an update reloads an open hook review", async () => {
  const item: AgentPluginListItem = {
    name: "grill",
    managed: true,
    present: true,
    location: "~/.mux/plugins/grill",
    lockedSha: "a".repeat(40),
    skillCount: 0,
    mcpServerCount: 0,
  };
  const hooks = { grill: hooksAt("old_tool") };
  const api = createMockORPCClient({
    agentPlugins: {
      items: [item],
      hooks,
      updateChecks: [{ name: "grill", status: "update-available", remoteSha: "b".repeat(40) }],
      updateReview: { name: "grill", fromSha: "a", toSha: "b", changes: [], warnings: [] },
    },
  });
  // The update changes the installed commit and the hook definition.
  api.agentPlugins.update = () => {
    item.lockedSha = "b".repeat(40);
    hooks.grill = hooksAt("new_tool");
    return Promise.resolve({
      success: true as const,
      data: {
        name: "grill",
        scope: "global" as const,
        source: {
          type: "git" as const,
          url: "https://example.test/grill.git",
          ref: "main",
          refType: "branch" as const,
        },
        lockedSha: "b".repeat(40),
        installedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  };

  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: "Review hooks for grill" }));
  await view.findByText(/old_tool/);
  fireEvent.click(await view.findByRole("button", { name: /^Update/ }));

  await waitFor(() => expect(view.queryByText(/old_tool/)).toBeNull());
  await view.findByText(/new_tool/);
});

test("a failed reload after a decision clears the stale review states", async () => {
  const item: AgentPluginListItem = {
    name: "grill",
    managed: true,
    present: true,
    location: "~/.mux/plugins/grill",
    lockedSha: "a".repeat(40),
    skillCount: 0,
    mcpServerCount: 0,
  };
  const api = createMockORPCClient({
    agentPlugins: { items: [item], hooks: { grill: hooksAt("new_tool") } },
  });
  const getHooks = api.agentPlugins.getHooks;
  let calls = 0;
  // The decision lands, then the connection drops before the reload.
  api.agentPlugins.getHooks = (input) =>
    ++calls === 1 ? getHooks(input) : Promise.reject(new Error("connection lost"));

  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: "Review hooks for grill" }));
  fireEvent.click(await view.findByRole("button", { name: /^Trust / }));

  await view.findByText("connection lost");
  expect(view.queryByText(/new_tool/)).toBeNull();
});
