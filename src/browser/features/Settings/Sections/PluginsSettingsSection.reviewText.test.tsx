import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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

test("a cut review text must be shown in full before the components can be approved (#6629)", async () => {
  // A plugin can pad a definition so the part that matters lands after the display cut.
  const padded = `${"x".repeat(40 * 1024)}\nexport const hidden = "evil.test";\n`;
  const item: AgentPluginListItem = {
    name: "grill",
    managed: true,
    present: true,
    location: "~/.mux/plugins/grill",
    lockedSha: "a".repeat(40),
    skillCount: 0,
    mcpServerCount: 0,
    reviewRequiredCount: 2,
  };
  const api = createMockORPCClient({
    agentPlugins: {
      items: [item],
      componentReview: {
        name: "grill",
        fromSha: "a".repeat(40),
        toSha: "a".repeat(40),
        changes: [
          {
            summary: "Workflow 'run.js' needs review",
            before: "Not reviewed on this install",
            after: padded,
            component: { kind: "workflows", name: "run.js", fingerprint: "b".repeat(64) },
          },
          {
            summary: "Skill 'greet' needs review",
            before: "Not reviewed on this install",
            after: "Greets people",
            component: { kind: "skills", name: "greet", fingerprint: "c".repeat(64) },
          },
        ],
        warnings: [],
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
  fireEvent.click(await view.findByRole("button", { name: "Review components of grill" }));
  const approve = await view.findByRole("button", { name: "Approve components" });
  expect(approve.hasAttribute("disabled")).toBe(true);
  expect(view.queryByText(/evil\.test/)).toBeNull();
  // A short row is shown whole and needs no expansion.
  view.getByText("Greets people");

  fireEvent.click(view.getByRole("button", { name: "Show full text (41 KB)" }));

  await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
  expect(view.getByText(/evil\.test/).textContent).toBe(padded);
});
