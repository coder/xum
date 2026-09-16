import { expect, userEvent, waitFor, within } from "@storybook/test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { expandLeftSidebar, selectWorkspace } from "./helpers/uiState";
import { createMockORPCClient } from "./mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/MCP Identity",
  parameters: {
    ...appMeta.parameters,
    docs: {
      description: {
        component:
          "Server-reported identity (text only) in MCP settings rows and the workspace MCP dialog. Branding appears after a connection test and lives in memory for the current configuration load; the configured key stays the primary label.",
      },
    },
  },
};

const NOTION = "notion-work";
const LOCAL = "local-docs";
const INFO_BUTTON = `Server information: ${NOTION}`;
// Deterministic 64×64 RGBA PNG (dark tile, light glyph) standing in for a
// host-decoded server icon. Generated locally, not copied from any server.
const NOTION_ICON =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA3klEQVR42u3ZQQ6DMAxE0Zwk979g1mXbVRslZuSx/0gsgfCkALbHIISQr8w5PzvHWuvnsXsd9f0AAAAAAAAAAAAAADgB+LcIADpsgfYAuwi8BAFoDhCNYAkQiWALEIVgDRCBAIA7wC1CCYAbhDIApwgAVAI4QbD8FY5EsK0FohZuXQxFLB4A93L49gFK9ANuHqJMQ0R9HgAZW2Lq7ZOyJ6h+iaZsiqo/pSm7wuo/SgAyzgWUhVXawYiqvE49GQKgO4Ci2WoxHG0P8ObghfE4AAAAAAAAAAAAAACEEDLGA62rWdcX21dQAAAAAElFTkSuQmCC";

function setupIdentityStory(transport: "http" | "auto" = "http") {
  expandLeftSidebar();
  const workspace = createWorkspace({
    id: "ws-mcp-identity",
    name: "mcp-server-identity",
    projectName: "xum",
  });
  selectWorkspace(workspace);
  // Branding is never persisted; start every story from an empty test cache.
  updatePersistedState(getMCPTestResultsKey("__global__"), {});
  return createMockORPCClient({
    projects: groupWorkspacesByProject([workspace]),
    workspaces: [workspace],
    globalMcpServers: {
      [NOTION]: { transport, url: "https://mcp.notion.com/mcp", disabled: false },
      [LOCAL]: {
        transport: "stdio",
        command: "bun",
        args: ["run", "docs-server.ts"],
        disabled: false,
      },
    },
    mcpTestResults: new Map([
      [
        NOTION,
        {
          success: true,
          tools: ["notion_ai_search", "notion_fetch", "notion_create_pages"],
          icon: NOTION_ICON,
          serverInfo: {
            name: "Notion MCP",
            version: "1.2.0",
            description:
              "Search your workspace, fetch specs and PRDs, and track tasks with your team.",
            websiteUrl: "https://developers.notion.com/docs/mcp",
          },
        },
      ],
      // No display metadata: today's row, tools count only.
      [LOCAL, { success: true, tools: ["search", "read"] }],
    ]),
  });
}

/** Nearest ancestor of `start` that also holds the row's action button. */
function rowContaining(start: HTMLElement, action: string): HTMLElement {
  let element: HTMLElement | null = start;
  while (element && !within(element).queryByRole("button", { name: action })) {
    element = element.parentElement;
  }
  if (!element) throw new Error(`Row with "${action}" not found`);
  return element;
}

/** The Settings row card for one configured server (contains its switch and actions). */
function serverRow(root: HTMLElement, name: string): HTMLElement {
  return rowContaining(
    within(root).getByRole("switch", { name: `Toggle ${name} enabled` }),
    "Test connection"
  );
}

async function openMcpSettings(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  await userEvent.click(await canvas.findByRole("button", { name: "MCP" }));
  await canvas.findByRole("switch", { name: `Toggle ${NOTION} enabled` });
  await expect(
    canvas.queryByRole("button", { name: /Server information:/ })
  ).not.toBeInTheDocument();
}

async function testBothServers(root: HTMLElement) {
  for (const name of [NOTION, LOCAL]) {
    await userEvent.click(
      within(serverRow(root, name)).getByRole("button", { name: "Test connection" })
    );
  }
  const badge = await within(serverRow(root, NOTION)).findByRole("button", {
    name: INFO_BUTTON,
  });
  await expect(badge.querySelector("img")).toHaveAttribute("src", NOTION_ICON);
  await within(serverRow(root, NOTION)).findByText("3 tools");
  await within(serverRow(root, LOCAL)).findByText("2 tools");
  await expect(
    within(serverRow(root, LOCAL)).queryByRole("button", { name: /Server information:/ })
  ).not.toBeInTheDocument();
}

const laptop = { pixel: { matrix: { viewports: ["laptop"] } } };

export const SettingsBeforeTest: AppStory = {
  render: () => <AppWithMocks setup={setupIdentityStory} />,
  parameters: laptop,
  play: async ({ canvasElement }) => {
    await openMcpSettings(canvasElement);
  },
};

export const SettingsAfterTest: AppStory = {
  ...SettingsBeforeTest,
  play: async ({ canvasElement }) => {
    await openMcpSettings(canvasElement);
    await testBothServers(canvasElement);
  },
};

export const SettingsServerDetails: AppStory = {
  ...SettingsBeforeTest,
  play: async ({ canvasElement }) => {
    await openMcpSettings(canvasElement);
    await testBothServers(canvasElement);
    await userEvent.click(within(canvasElement).getByRole("button", { name: INFO_BUTTON }));
    const popover = await within(document.body).findByRole("dialog", { name: `About ${NOTION}` });
    await expect(popover.querySelector("img")).toHaveAttribute("src", NOTION_ICON);
    await expect(popover).toHaveTextContent("Notion MCP");
    await expect(popover).toHaveTextContent("v1.2.0");
    await expect(popover).toHaveTextContent("http · https://mcp.notion.com");
    await expect(within(popover).getByRole("link", { name: /Website/ })).toHaveAttribute(
      "href",
      "https://developers.notion.com/docs/mcp"
    );
    await expect(popover).toHaveTextContent("Not a verified identity.");
  },
};

export const SettingsAutoTransport: AppStory = {
  ...SettingsBeforeTest,
  render: () => <AppWithMocks setup={() => setupIdentityStory("auto")} />,
  play: async ({ canvasElement }) => {
    await openMcpSettings(canvasElement);
    await testBothServers(canvasElement);
    await userEvent.click(within(canvasElement).getByRole("button", { name: INFO_BUTTON }));
    const popover = await within(document.body).findByRole("dialog", { name: `About ${NOTION}` });
    await expect(popover).toHaveTextContent("auto · https://mcp.notion.com");
  },
};

const phoneParameters = { pixel: { matrix: { viewports: ["phone"] } } };
const phoneGlobals = { viewport: { value: "mobile1", isRotated: false } };

export const SettingsPhone: AppStory = {
  ...SettingsBeforeTest,
  globals: phoneGlobals,
  parameters: phoneParameters,
  play: async (context) => {
    await expect(context.parameters.pixel).toEqual(phoneParameters.pixel);
    await openMcpSettings(context.canvasElement);
    await testBothServers(context.canvasElement);
    // The test-runner plays at desktop size; only Pixel/manager pin the phone width.
    if (window.innerWidth < 768) {
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    }
  },
};

export const WorkspaceModalAfterFetch: AppStory = {
  ...SettingsBeforeTest,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
    await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
    const dialog = await within(document.body).findByRole("dialog");
    const row = rowContaining(
      await within(dialog).findByRole("switch", { name: `Toggle ${NOTION} MCP server` }),
      "Fetch Tools"
    );
    await expect(within(row).queryByRole("button", { name: INFO_BUTTON })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Fetch Tools" }));
    const badge = await within(row).findByRole("button", { name: INFO_BUTTON });
    await expect(badge.querySelector("img")).toHaveAttribute("src", NOTION_ICON);
    await waitFor(() =>
      expect(within(row).getByRole("button", { name: "Refresh Tools" })).toBeVisible()
    );
  },
};
