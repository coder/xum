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

function previewOf(overrides: Partial<AgentPluginInstallPreview>): AgentPluginInstallPreview {
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
    agents: [],
    readonlyAgents: [],
    shellRemovedAgents: [],
    workflows: [],
    slashCommands: [],
    reviewedComponents: [],
    codexHooks: [],
    notApplied: [],
    fileChanges: [],
    warnings: [],
    targetPath: "~/.mux/plugins/egm",
    consentDigest: "c".repeat(64),
    ...overrides,
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

test("the install preview marks read-only agents, and says when their shell is removed", async () => {
  const view = await openPreview(
    previewOf({
      agents: ["design_critic.md", "quiet.md", "synthesizer.md"],
      readonlyAgents: ["design_critic.md", "quiet.md"],
      shellRemovedAgents: ["quiet.md"],
    })
  );

  view.getByText("Agents (3)");
  const kept = view.getAllByText(/edit tools removed, shell still available/);
  expect(kept).toHaveLength(1);
  expect(kept[0]?.previousElementSibling?.textContent).toBe("design_critic.md");
  const removed = view.getAllByText(/edit tools removed, shell removed/);
  expect(removed).toHaveLength(1);
  expect(removed[0]?.previousElementSibling?.textContent).toBe("quiet.md");
  expect(removed[0]?.parentElement?.textContent).toStartWith(
    "design_critic.md (edit tools removed, shell still available), quiet.md (edit tools removed, shell removed), synthesizer.md"
  );
});

test("a preview with nothing to activate shows no component section", async () => {
  const view = await openPreview(previewOf({}));

  for (const heading of [
    /^Agents \(/,
    /^Workflows \(/,
    /^Slash commands \(/,
    /^Files \(/,
    /^Hooks$/,
  ]) {
    expect(view.queryByText(heading)).toBeNull();
  }
});

test("a preview with one of each component discloses each one", async () => {
  const view = await openPreview(
    previewOf({
      agents: ["reviewer.md"],
      workflows: ["run.js"],
      slashCommands: [{ name: "ship", description: "Ship it" }],
      hook: { path: "hooks.js", toolGrants: ["bash"] },
      fileChanges: [{ summary: "file hooks/stop.sh added", after: "echo stop\n" }],
    })
  );

  view.getByText("Agents (1)");
  view.getByText("Workflows (1)");
  view.getByText("Slash commands (1)");
  view.getByText("Files (1)");
  view.getByText("Hooks");
  expect(view.getByText("/ship").parentElement?.textContent).toBe("/ship — Ship it");
  view.getByText(/for: bash/);
});

test("a hook that sees no tools says so", async () => {
  const view = await openPreview(previewOf({ hook: { path: "hooks.js", toolGrants: [] } }));

  view.getByText(/\(no tool visibility granted\)/);
  expect(view.queryByText(/for: /)).toBeNull();
});

test("a slash command without a description shows only its name", async () => {
  const view = await openPreview(
    previewOf({ slashCommands: [{ name: "plain" }, { name: "ship" }] })
  );

  view.getByText("Slash commands (2)");
  expect(view.getByText("/plain").parentElement?.textContent).toBe("/plain");
});
