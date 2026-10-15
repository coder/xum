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

// #6627: opening the section retries the pending sign-outs inside list(). When that retry clears
// the record, the list was still read behind the fence, so the section must list once more.
test("a sign-out record that clears during the section open re-lists the plugins", async () => {
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  let record: AgentPluginPendingSignOuts = { kind: "pending", servers: ["https://x/mcp"] };
  let lists = 0;
  api.agentPlugins.pendingSignOuts = () => Promise.resolve(record);
  api.agentPlugins.list = () => {
    lists++;
    // The first list runs behind the fence and clears the record (the section-open retry).
    const fenced = record.kind !== "none";
    record = { kind: "none" };
    return Promise.resolve({ success: true as const, data: [row(!fenced)] });
  };

  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  await waitFor(() => expect(lists).toBe(2));
  await waitFor(() => expect(view.container.textContent).toContain("grill"));
  expect(view.container.textContent).not.toContain("Managed plugins are unavailable");
  expect(view.container.textContent).not.toMatch(/missing/i);
});
