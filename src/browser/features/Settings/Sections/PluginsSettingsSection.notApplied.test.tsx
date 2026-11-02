import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

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

const item: AgentPluginListItem = {
  name: "pstack",
  managed: true,
  present: true,
  location: "~/.mux/plugins/pstack",
  lockedSha: "a".repeat(40),
  skillCount: 1,
  mcpServerCount: 0,
  notApplied: [{ part: "field", name: "variables", reason: "not applied in Xum" }],
};

test("the installed card and the update review list the parts Xum does not apply", async () => {
  const api = createMockORPCClient({
    agentPlugins: {
      items: [item, { ...item, name: "plain", location: "~/.mux/plugins/plain", notApplied: [] }],
      updateChecks: [{ name: "pstack", status: "update-available", remoteSha: "b".repeat(40) }],
      updateReview: {
        name: "pstack",
        fromSha: "a".repeat(40),
        toSha: "b".repeat(40),
        changes: [{ summary: "adds skill 'review'", after: "Reviews a diff" }],
        warnings: [],
        notApplied: [
          { part: "hook", name: "hooks", reason: "Cursor hooks run in a later Xum build" },
        ],
      },
    },
  });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );

  const field = await view.findByText(/variables/);
  expect(field.closest("li")?.textContent).toBe("field variables: not applied in Xum");
  // An empty list adds no heading to the other card.
  expect(view.getAllByText("Not applied in Xum (1)")).toHaveLength(1);

  fireEvent.click(view.getByRole("button", { name: /^Update$/ }));
  await view.findByRole("button", { name: "Apply update" });
  expect(view.getByText(/later Xum build/).closest("li")?.textContent).toBe(
    "hook hooks: Cursor hooks run in a later Xum build"
  );
});
