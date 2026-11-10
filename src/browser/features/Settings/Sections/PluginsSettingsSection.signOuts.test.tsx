import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type {
  AgentPluginListItem,
  AgentPluginPendingSignOuts,
} from "@/common/orpc/schemas/agentPlugins";
import { PluginsSettingsSection } from "./PluginsSettingsSection";
import { publishPluginsSectionIntent } from "./pluginsSectionIntents";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const row = (present: boolean): AgentPluginListItem => ({
  name: "grill",
  managed: true,
  present,
  location: "~/.mux/plugins/grill",
  skillCount: present ? 3 : 0,
  mcpServerCount: 0,
});

// #6627: one call returns the list and the record. A re-list that fails (a transient backend
// error) must keep the notice, because the record still hides the managed plugins, and the
// notice keeps the polling on.
test("a failed re-list keeps the pending sign-out notice", async () => {
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  const record: AgentPluginPendingSignOuts = { kind: "pending", servers: ["https://x/mcp"] };
  let calls = 0;
  api.agentPlugins.listForSettings = () => {
    calls++;
    return calls === 1
      ? Promise.resolve({
          list: { success: true as const, data: [row(false)] },
          pendingSignOuts: record,
        })
      : Promise.reject(new Error("backend restarting"));
  };

  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  await waitFor(() =>
    expect(view.container.textContent).toContain("Managed plugins are unavailable")
  );
  publishPluginsSectionIntent({ type: "refresh" });
  await waitFor(() => expect(calls).toBe(2));
  await waitFor(() => expect(view.container.textContent).toContain("backend restarting"));
  expect(view.container.textContent).toContain("Managed plugins are unavailable");
});
