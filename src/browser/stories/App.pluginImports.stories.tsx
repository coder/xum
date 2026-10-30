import { expect, userEvent, waitFor, within } from "storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { expandLeftSidebar } from "./helpers/uiState";
import { getSettingsDialog, openSettingsDialog } from "./storyPlayHelpers";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";
import type {
  AgentPluginInstallPreview,
  AgentPluginListItem,
} from "@/common/orpc/schemas/agentPlugins";
import type { AgentPluginInstallEntry } from "@/common/config/schemas/agentPluginInstalls";

export default { ...appMeta, title: "App/PluginImports" };

const preview: AgentPluginInstallPreview = {
  source: {
    type: "git",
    url: "https://github.com/example/review-tools.git",
    ref: "main",
    refType: "branch",
  },
  method: { kind: "agent-plugin" },
  methods: [{ kind: "agent-plugin" }],
  skillsCliSkills: [],
  lockedSha: "a".repeat(40),
  manifest: { name: "review-tools", version: "1.0.0", description: "Review and research tools" },
  targetPath: "~/.xum/plugins/review-tools",
  skills: [
    // Long prose description: at phone width it must wrap between words, not mid-word.
    {
      name: "review",
      description:
        "Picks the smallest change that fully solves the task, then reviews it for scope creep",
    },
    { name: "research", description: "Research a topic" },
  ],
  mcpServers: [
    {
      serverName: "reference",
      transport: "stdio",
      summary: "node ${PLUGIN_ROOT}/servers/reference.js --read-only",
    },
  ],
  agents: ["reviewer.md"],
  workflows: ["review.js"],
  slashCommands: [{ name: "review-status", description: "Summarize review status" }],
  consentDigest: "c".repeat(64),
  reviewedComponents: [],
  codexHooks: [],
  hook: { path: "hooks.js", toolGrants: ["file_read"] },
  warnings: [],
};

function setupPluginSettings(installed = false, conflict = false) {
  expandLeftSidebar();
  const client = setupSettingsStory({});
  let entry: AgentPluginInstallEntry = {
    name: preview.manifest.name,
    scope: "global",
    source: preview.source,
    lockedSha: preview.lockedSha,
    installedAt: "2026-09-01T00:00:00.000Z",
    importedComponents: { skills: ["review"], mcpServers: [] },
  };
  // The full app mounts its composer before Settings, including plugin command discovery.
  client.workspace.plugins = {
    slashCommands: { list: () => Promise.resolve([]) },
    composition: {
      get: () =>
        Promise.resolve({
          plugins: [],
          diagnostics: [],
          skills: [],
          agents: [],
          workflows: [],
          mcpServers: [],
          slashCommands: [],
          hooks: [],
        }),
    },
  };
  client.agentPlugins.preview = () =>
    Promise.resolve({ success: true, data: { kind: "plugin", preview } });
  client.agentPlugins.checkUpdates = () => Promise.resolve({ success: true, data: [] });
  client.agentPlugins.list = () =>
    Promise.resolve({
      success: true,
      data: installed
        ? [
            {
              ...entry,
              managed: true,
              present: true,
              location: preview.targetPath,
              skillCount: 2,
              mcpServerCount: 1,
              importedSkillCount: entry.importedComponents?.skills.length ?? 2,
              importedMcpServerCount: entry.importedComponents?.mcpServers.length ?? 1,
            },
          ]
        : [],
    });
  // Settings → Plugins lists through listForSettings (#6627).
  client.agentPlugins.listForSettings = async () => ({
    list: await client.agentPlugins.list(),
    pendingSignOuts: { kind: "none" },
  });
  client.agentPlugins.getComponents = () =>
    Promise.resolve({
      success: true,
      data: {
        ...preview,
        contentHash: "fixture-content-hash",
        importedComponents: entry.importedComponents,
      },
    });
  client.agentPlugins.install = (input) => {
    installed = true;
    entry = { ...entry, importedComponents: input.importedComponents ?? undefined };
    return Promise.resolve({ success: true, data: entry });
  };
  client.agentPlugins.setComponents = (input) => {
    if (conflict) {
      conflict = false;
      entry = { ...entry, importedComponents: { skills: ["review"], mcpServers: ["reference"] } };
      return Promise.resolve({ success: false, error: "Selection changed in another window" });
    }
    entry = { ...entry, importedComponents: input.importedComponents };
    return Promise.resolve({ success: true, data: entry });
  };
  return client;
}

// The mix of description lengths, interface details and update states that made card actions
// jump between the header and a row under long descriptions.
const installedList: AgentPluginListItem[] = [
  {
    name: "review-tools",
    managed: true,
    present: true,
    location: "~/.xum/plugins/review-tools",
    version: "1.0.0",
    description: "Review and research tools",
    source: preview.source,
    lockedSha: "a".repeat(40),
    skillCount: 2,
    mcpServerCount: 1,
    importedSkillCount: 2,
    importedMcpServerCount: 1,
  },
  {
    name: "release-notes",
    managed: true,
    present: true,
    location: "~/.xum/plugins/release-notes",
    version: "2.3.1",
    description:
      "Drafts release notes from merged pull requests, groups them by area and audience, links each entry to its PR and flags breaking changes, migrations and deprecations that need a callout before you publish",
    source: {
      type: "git",
      url: "https://github.com/example/release-notes.git",
      ref: "v2.3.1",
      refType: "tag",
    },
    lockedSha: "b".repeat(40),
    skillCount: 4,
    mcpServerCount: 0,
    importedSkillCount: 3,
    importedMcpServerCount: 0,
  },
  {
    name: "linear-sync",
    managed: true,
    present: true,
    location: "~/.xum/plugins/linear-sync",
    version: "0.9.0",
    description: "Keep Linear issues in sync with workspace progress",
    interface: {
      displayName: "Linear Sync",
      developerName: "Example Labs",
      shortDescription: "Two-way sync between agent todos and Linear issues",
      capabilities: ["Read issues", "Write comments", "Update status"],
      websiteURL: "https://example.com/linear-sync",
      privacyPolicyURL: "https://example.com/privacy",
      supportURL: "https://example.com/support",
    },
    source: {
      type: "git",
      url: "https://github.com/example/linear-sync.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: "c".repeat(40),
    skillCount: 1,
    mcpServerCount: 1,
    importedSkillCount: 1,
    importedMcpServerCount: 1,
  },
  {
    name: "pstack",
    managed: true,
    present: true,
    location: "~/.xum/plugins/pstack",
    version: "4.2.0",
    description: "Skills, playbooks and principles for careful agent work",
    source: {
      type: "git",
      url: "https://github.com/example/pstack.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: "d".repeat(40),
    skillCount: 38,
    mcpServerCount: 0,
    importedSkillCount: 38,
    importedMcpServerCount: 0,
  },
  {
    name: "local-snippets",
    managed: false,
    present: true,
    location: "~/.agents/plugins/local-snippets",
    description: "Hand-written snippets found in the shared agents folder",
    skillCount: 3,
    mcpServerCount: 0,
  },
];

function setupInstalledPluginList() {
  const client = setupPluginSettings();
  client.agentPlugins.list = () => Promise.resolve({ success: true, data: installedList });
  client.agentPlugins.checkUpdates = () =>
    Promise.resolve({
      success: true,
      data: [{ name: "pstack", status: "update-available", remoteSha: "e".repeat(40) }],
    });
  return client;
}

async function openPlugins(canvasElement: HTMLElement) {
  const canvas = within(await openSettingsDialog(canvasElement));
  await userEvent.click(await canvas.findByRole("button", { name: "Plugins" }));
  return canvas;
}

async function checkPhoneBounds() {
  // CI's test-runner ignores viewport globals; only check narrow bounds when actually pinned.
  if (window.innerWidth >= 768) return;
  await waitFor(() =>
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  );
  for (const group of within(getSettingsDialog()).getAllByRole("group")) {
    await expect(group.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  }
}

export const PreviewDesktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setupPluginSettings} />,
  play: async ({ canvasElement }) => {
    const canvas = await openPlugins(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add plugin" }));
    await userEvent.type(canvas.getByLabelText("Git URL or owner/repo"), "example/review-tools");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));
    for (const label of ["Skills", "MCP servers"]) {
      const group = within(await canvas.findByRole("group", { name: label }));
      await userEvent.click(group.getByRole("button", { name: "Clear" }));
      for (const checkbox of group.getAllByRole("checkbox"))
        await expect(checkbox).not.toBeChecked();
    }
    await expect(canvas.getByRole("button", { name: "Install" })).toBeEnabled();
    await checkPhoneBounds();
    canvas.getByRole("group", { name: "Skills" }).scrollIntoView({ block: "start" });
  },
};

export const PreviewPhone: AppStory = {
  ...PreviewDesktop,
  play: async (context) => {
    await expect(context.parameters.pixel.matrix.viewports).toContain("phone");
    await PreviewDesktop.play?.(context);
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } } },
};

export const ManageComponentsDesktop: AppStory = {
  ...PreviewDesktop,
  render: () => <AppWithMocks setup={() => setupPluginSettings(true)} />,
  play: async ({ canvasElement }) => {
    const canvas = await openPlugins(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Manage components for review-tools" })
    );
    await expect(await canvas.findByRole("checkbox", { name: "review" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("checkbox", { name: "review" }));
    await userEvent.click(canvas.getByRole("checkbox", { name: "research" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Done" })).toBeEnabled());
    await expect(canvas.getByRole("checkbox", { name: "review" })).not.toBeChecked();
    await expect(canvas.getByRole("checkbox", { name: "research" })).toBeChecked();
    await userEvent.click(canvas.getByRole("button", { name: "Done" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Manage components for review-tools" })
    );
    await expect(await canvas.findByRole("checkbox", { name: "review" })).not.toBeChecked();
    await expect(canvas.getByRole("checkbox", { name: "research" })).toBeChecked();
    await expect(canvas.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await checkPhoneBounds();
  },
};

export const ManageComponentsPhone: AppStory = {
  ...ManageComponentsDesktop,
  play: async (context) => {
    await expect(context.parameters.pixel.matrix.viewports).toContain("phone");
    await ManageComponentsDesktop.play?.(context);
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } } },
};

export const EmptySelection: AppStory = {
  ...ManageComponentsDesktop,
  play: async ({ canvasElement }) => {
    const canvas = await openPlugins(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Manage components for review-tools" })
    );
    const group = within(await canvas.findByRole("group", { name: "Skills" }));
    await userEvent.click(group.getByRole("button", { name: "Clear" }));
    await expect(canvas.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await canvas.findByText(/0 of 2 skills imported/);
    await waitFor(() => expect(canvas.getByRole("button", { name: "Done" })).toBeEnabled());
    for (const checkbox of canvas.getAllByRole("checkbox"))
      await expect(checkbox).not.toBeChecked();
    await expect(
      canvas.getByRole("button", { name: "Manage components for review-tools" })
    ).toBeEnabled();
    await checkPhoneBounds();
  },
};

export const SelectionConflict: AppStory = {
  ...ManageComponentsDesktop,
  render: () => <AppWithMocks setup={() => setupPluginSettings(true, true)} />,
  play: async ({ canvasElement }) => {
    const canvas = await openPlugins(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Manage components for review-tools" })
    );
    await userEvent.click(await canvas.findByRole("checkbox", { name: "research" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await canvas.findByRole("alert");
    await waitFor(() => expect(canvas.getByRole("checkbox", { name: "reference" })).toBeChecked());
    await expect(canvas.getByRole("checkbox", { name: "research" })).not.toBeChecked();
    await expect(canvas.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("checkbox", { name: "research" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await canvas.findByText(/2 of 2 skills imported/);
    await waitFor(() => expect(canvas.getByRole("button", { name: "Done" })).toBeEnabled());
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    await checkPhoneBounds();
  },
};

export const InstalledListDesktop: AppStory = {
  ...PreviewDesktop,
  render: () => <AppWithMocks setup={setupInstalledPluginList} />,
  play: async ({ canvasElement }) => {
    const canvas = await openPlugins(canvasElement);
    // The Update button needs both the list and the update check to have rendered.
    await canvas.findByRole("button", { name: "Update" });
    await checkPhoneBounds();
  },
};

export const InstalledListPhone: AppStory = {
  ...InstalledListDesktop,
  play: async (context) => {
    await expect(context.parameters.pixel.matrix.viewports).toContain("phone");
    await InstalledListDesktop.play?.(context);
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } } },
};
