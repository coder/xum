import { expect, userEvent, within } from "@storybook/test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { expandLeftSidebar, selectWorkspace } from "./helpers/uiState";
import { createMockORPCClient } from "./mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/MCP Plugin Tools",
  parameters: {
    ...appMeta.parameters,
    docs: {
      description: {
        component:
          "Discovered tools of an Agent Plugin MCP server in Settings. Plugin definitions stay read-only: the expandable list shows names only, while regular servers keep their editable allowlist.",
      },
    },
  },
};

/** Backend instance key for a plugin server; Settings labels the row `<plugin>/<server>`. */
const PLUGIN_KEY = "plugin:0123456789abcdef:docs";
const PLUGIN_LABEL = "docs-plugin/docs";
const LOCAL = "local-docs";
const PLUGIN_TOOLS = [
  "search_docs",
  "fetch_page_property_item_with_pagination_and_rich_text_expansion_v2",
  "read_doc",
  "list_recent_changes",
  "summarize_thread",
];

function setupPluginToolsStory() {
  expandLeftSidebar();
  const workspace = createWorkspace({
    id: "ws-mcp-plugin-tools",
    name: "mcp-plugin-tools",
    projectName: "xum",
  });
  selectWorkspace(workspace);
  // Start every story from an empty test cache so the play drives discovery.
  updatePersistedState(getMCPTestResultsKey("__global__"), {});
  return createMockORPCClient({
    projects: groupWorkspacesByProject([workspace]),
    workspaces: [workspace],
    globalMcpServers: {
      [PLUGIN_KEY]: {
        transport: "stdio",
        command: "bun run docs-server.ts",
        disabled: false,
        plugin: {
          pluginName: "docs-plugin",
          serverName: "docs",
          sourceScope: "global",
          sourceLocation: ".xum/plugins/docs-plugin",
        },
      },
      [LOCAL]: { transport: "stdio", command: "bun run docs-server.ts", disabled: false },
    },
    mcpTestResults: new Map([
      [PLUGIN_KEY, { success: true, tools: PLUGIN_TOOLS }],
      [LOCAL, { success: true, tools: ["search", "read"] }],
    ]),
  });
}

/** The Settings card for one server: header grid plus its tools section below. */
function serverRow(root: HTMLElement, label: string): HTMLElement {
  let header: HTMLElement | null = within(root).getByRole("switch", {
    name: `Toggle ${label} enabled`,
  });
  while (header && !within(header).queryByRole("button", { name: "Test connection" })) {
    header = header.parentElement;
  }
  const card = header?.parentElement;
  if (!card) throw new Error(`Row for ${label} not found`);
  return card;
}

async function openMcpSettingsAndTest(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  await userEvent.click(await canvas.findByRole("button", { name: "MCP" }));
  await canvas.findByRole("switch", { name: `Toggle ${PLUGIN_LABEL} enabled` });
  for (const label of [PLUGIN_LABEL, LOCAL]) {
    await userEvent.click(
      within(serverRow(canvasElement, label)).getByRole("button", { name: "Test connection" })
    );
  }
  await within(serverRow(canvasElement, PLUGIN_LABEL)).findByText("5 tools");
  await within(serverRow(canvasElement, LOCAL)).findByText("2 tools");
}

async function expandBothToolSections(canvasElement: HTMLElement) {
  const plugin = serverRow(canvasElement, PLUGIN_LABEL);
  await userEvent.click(within(plugin).getByRole("button", { name: /^Tools: 5\b/ }));
  for (const tool of PLUGIN_TOOLS) await within(plugin).findByText(tool);
  // Read-only: names only, no permission controls for plugin definitions.
  await expect(within(plugin).queryAllByRole("checkbox")).toHaveLength(0);
  await expect(within(plugin).queryByRole("button", { name: "All" })).not.toBeInTheDocument();

  const local = serverRow(canvasElement, LOCAL);
  await userEvent.click(within(local).getByRole("button", { name: /^Tools: 2\/2\b/ }));
  await expect(await within(local).findAllByRole("checkbox")).toHaveLength(2);
}

const laptop = { pixel: { matrix: { viewports: ["laptop"] } } };

export const SettingsCollapsed: AppStory = {
  render: () => <AppWithMocks setup={setupPluginToolsStory} />,
  parameters: laptop,
  play: async ({ canvasElement }) => {
    await openMcpSettingsAndTest(canvasElement);
  },
};

export const SettingsExpanded: AppStory = {
  ...SettingsCollapsed,
  play: async ({ canvasElement }) => {
    await openMcpSettingsAndTest(canvasElement);
    await expandBothToolSections(canvasElement);
  },
};

const phoneParameters = { pixel: { matrix: { viewports: ["phone"] } } };
const phoneGlobals = { viewport: { value: "mobile1", isRotated: false } };

export const SettingsExpandedPhone: AppStory = {
  ...SettingsExpanded,
  globals: phoneGlobals,
  parameters: phoneParameters,
  play: async (context) => {
    await expect(context.parameters.pixel).toEqual(phoneParameters.pixel);
    await openMcpSettingsAndTest(context.canvasElement);
    await expandBothToolSections(context.canvasElement);
    // The test-runner plays at desktop size; only Pixel/manager pin the phone width.
    if (window.innerWidth < 768) {
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    }
  },
};
