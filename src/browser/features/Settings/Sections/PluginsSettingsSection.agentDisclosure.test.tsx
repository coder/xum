import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
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

function previewOf(agents: string[], readonlyAgents: string[]): AgentPluginInstallPreview {
  return {
    source: {
      type: "git",
      url: "https://github.com/acme/egm.git",
      ref: "main",
      refType: "branch",
    },
    method: { kind: "claude-plugin" },
    methods: [{ kind: "claude-plugin" }],
    skillsCliSkills: [],
    lockedSha: "b".repeat(40),
    manifest: { name: "egm" },
    skills: [],
    mcpServers: [],
    agents,
    readonlyAgents,
    workflows: [],
    slashCommands: [],
    reviewedComponents: [],
    codexHooks: [],
    notApplied: [],
    fileChanges: [],
    warnings: [],
    targetPath: "~/.mux/plugins/egm",
    consentDigest: "c".repeat(64),
  };
}

async function openPreview(preview: AgentPluginInstallPreview) {
  const api = createMockORPCClient({ agentPlugins: { items: [], preview } });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: "Add plugin" }));
  await userEvent.type(await view.findByLabelText(/Git URL or owner\/repo/), "acme/egm");
  fireEvent.click(view.getByRole("button", { name: /Preview/ }));
  await view.findByRole("button", { name: "Install" });
  return view;
}

test("the install preview marks only read-only agents with the shell note", async () => {
  const view = await openPreview(
    previewOf(["design_critic.md", "synthesizer.md"], ["design_critic.md"])
  );

  view.getByText("Agents (2)");
  const notes = view.getAllByText(/edit tools removed, shell still available/);
  expect(notes).toHaveLength(1);
  expect(notes[0]?.previousElementSibling?.textContent).toBe("design_critic.md");
});

test("a preview without agents shows no agent section", async () => {
  const view = await openPreview(previewOf([], []));

  expect(view.queryByText(/^Agents \(/)).toBeNull();
});
