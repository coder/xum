import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import type {
  AgentPluginInstallPreview,
  AgentPluginListItem,
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

const source: AgentPluginGitSource = {
  type: "git",
  url: "https://github.com/google/elephant-goldfish-model.git",
  ref: "main",
  refType: "branch",
};

const row: AgentPluginListItem = {
  name: "egm",
  managed: true,
  present: true,
  location: "~/.mux/plugins/egm",
  source,
  lockedSha: "a".repeat(40),
  skillCount: 7,
  mcpServerCount: 0,
};

function renderRow(item: AgentPluginListItem) {
  const api = createMockORPCClient({ agentPlugins: { items: [item] } });
  return render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
}

test.each([
  {
    title: "a manifest install with a saved method",
    item: {
      ...row,
      installMethod: "claude-plugin",
      manifestPath: ".claude-plugin/plugin.json",
      otherMethods: [
        { method: "agent-plugin", agents: 0 },
        { method: "cursor-plugin", agents: 7 },
      ],
    } satisfies AgentPluginListItem,
    installedAs: "Installed as Claude Code plugin",
    others: "Other install methods: Agent Plugin (0 agents) · Cursor plugin (7 agents)",
  },
  {
    title: "a manifest install from before the saved method",
    item: {
      ...row,
      manifestPath: ".codex-plugin/plugin.json",
      otherMethods: [
        { method: "claude-plugin", agents: 9 },
        { method: "cursor-plugin", agents: 1 },
      ],
    } satisfies AgentPluginListItem,
    installedAs: "Installed as Agent Plugin",
    others: "Other install methods: Claude Code plugin (9 agents) · Cursor plugin (1 agent)",
  },
  {
    title: "a Skills install",
    item: {
      ...row,
      manifestPath: "plugin.json",
      generatedFrom: "skills",
    } satisfies AgentPluginListItem,
    installedAs: "Installed as Skills",
    others: null,
  },
  {
    title: "a Claude Code marketplace entry install",
    item: {
      ...row,
      manifestPath: "plugin.json",
      generatedFrom: "claude-marketplace",
    } satisfies AgentPluginListItem,
    installedAs: "Installed as Claude Code marketplace entry",
    others: null,
  },
])("the row of $title says how it was installed", async (scenario) => {
  const view = renderRow(scenario.item);
  await view.findByText(scenario.installedAs);
  if (scenario.others !== null) view.getByText(scenario.others);
  else expect(view.queryByText(/Other install methods/)).toBeNull();
});

test("an unmanaged plugin and a plugin whose folder is gone say nothing about an install method", async () => {
  for (const item of [
    { ...row, managed: false, manifestPath: ".codex-plugin/plugin.json" },
    { ...row, present: false },
  ]) {
    const view = renderRow(item);
    await view.findByText("egm");
    expect(view.queryByText(/Installed as/)).toBeNull();
    view.unmount();
  }
});

const preview: AgentPluginInstallPreview = {
  source,
  lockedSha: "b".repeat(40),
  manifest: { name: "egm" },
  skills: [{ name: "egm-draft" }],
  mcpServers: [],
  agents: [],
  readonlyAgents: [],
  shellRemovedAgents: [],
  workflows: [],
  slashCommands: [],
  reviewedComponents: [],
  codexHooks: [],
  fileChanges: [],
  warnings: [],
  notApplied: [],
  targetPath: "~/.mux/plugins/egm",
  consentDigest: "c".repeat(64),
  method: { kind: "agent-plugin" },
  methods: [
    { kind: "agent-plugin" },
    { kind: "claude-plugin" },
    { kind: "cursor-plugin" },
    { kind: "skills" },
  ],
  skillsCliSkills: [],
  methodSummaries: [
    {
      method: "agent-plugin",
      manifestPath: ".codex-plugin/plugin.json",
      counts: { skills: 7, agents: 0, hooksCanRun: 0, hooksListed: 0, mcpServers: 0 },
    },
    {
      method: "claude-plugin",
      manifestPath: ".claude-plugin/plugin.json",
      counts: { skills: 7, agents: 9, hooksCanRun: 0, hooksListed: 2, mcpServers: 1 },
    },
    {
      method: "cursor-plugin",
      manifestPath: ".cursor-plugin/plugin.json",
      counts: { skills: 8, agents: 7, hooksCanRun: 1, hooksListed: 0, mcpServers: 0 },
    },
  ],
};

test("Install as shows each manifest method's file and counts, and a generated method keeps its label", async () => {
  const api = createMockORPCClient({ agentPlugins: { items: [], preview } });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: "Add plugin" }));
  const sourceField = await view.findByLabelText(/Git URL or owner\/repo/);
  await userEvent.type(sourceField, "google/elephant-goldfish-model{Enter}");
  await waitFor(() => view.getByRole("radio", { name: /^Agent Plugin/ }));

  expect(view.getByRole("radio", { name: /^Agent Plugin/ }).textContent).toBe(
    "Agent Plugin (.codex-plugin/plugin.json)7 skills · 0 agents"
  );
  expect(view.getByRole("radio", { name: /^Claude Code plugin/ }).textContent).toBe(
    "Claude Code plugin (.claude-plugin/plugin.json)7 skills · 9 agents · 2 hooks listed · 1 MCP server"
  );
  expect(view.getByRole("radio", { name: /^Cursor plugin/ }).textContent).toBe(
    "Cursor plugin (.cursor-plugin/plugin.json)8 skills · 7 agents · 1 hook can run"
  );
  expect(view.getByRole("radio", { name: "Skills" }).textContent).toBe("Skills");
});
