import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import type { MuxToolPart } from "@/common/types/message";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, expandLeftSidebar, expandProjects } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { blurActiveElement, waitForScrollStabilization } from "./storyPlayHelpers";
import notionIcon from "./assets/notion-mcp.png?inline";

export default {
  ...appMeta,
  title: "App/MCP Identity/Chat",
  parameters: {
    ...appMeta.parameters,
    docs: {
      description: {
        component:
          "Per-call MCP server identity frozen on tool parts and rendered by the production GenericToolCall header: badge with the short display name and the host-decoded icon resolved through mcp.icon. Rows without a snapshot render exactly as before.",
      },
    },
  },
};

const NOTION_SEARCH = "mcp__notion__notion_ai_search";
const NOTION_FETCH = "mcp__notion__notion_fetch";
const LOCAL_SEARCH = "mcp__local_docs__search";
const INFO_BUTTON = "Server information: notion-work";
/** Session-local refs: one the host still knows, one it no longer does. */
const REF_LIVE = "1".repeat(32);
const REF_GONE = "2".repeat(32);
const NOTION_ICON: string = notionIcon;
/** Longest title the identity schema admits (80 chars), unbroken so it cannot wrap. */
const LONG_TITLE =
  "NotionEnterpriseKnowledgeWorkspaceConnectorForSpecsPRDsAndTaskTracking0000000000";

function notionSnapshot(iconRef: string, version: string, title = "Notion"): MCPToolCallDisplay {
  return {
    connection: { key: "notion-work", transport: "http", origin: "https://mcp.notion.com" },
    identity: {
      name: "Notion MCP",
      title,
      version,
      description: "Search your workspace, fetch specs and PRDs, and track tasks with your team.",
      websiteUrl: "https://developers.notion.com/docs/mcp",
    },
    source: "connection",
    iconRef,
  };
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

function toolCalls(options: {
  branded: boolean;
  historical?: boolean;
  nested?: boolean;
  longTitle?: boolean;
}) {
  const search: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "notion-search",
    toolName: NOTION_SEARCH,
    state: "output-available",
    input: { query: "workspace setup guide" },
    output: text("Found: Workspace setup guide; Development environment; Team onboarding."),
    ...(options.branded
      ? {
          mcpServer: notionSnapshot(REF_LIVE, "1.2.0", options.longTitle ? LONG_TITLE : "Notion"),
        }
      : {}),
  };
  const fetch: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "notion-fetch",
    toolName: NOTION_FETCH,
    state: "output-available",
    input: { id: "workspace-setup-guide" },
    output: text("Workspace setup guide: clone the repository, run bun install, then make dev."),
    // A historical call captured before a server upgrade keeps its own version
    // and icon ref even when that ref is gone after a restart.
    ...(options.branded
      ? { mcpServer: notionSnapshot(options.historical ? REF_GONE : REF_LIVE, "1.1.0") }
      : {}),
  };
  const local: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "local-search",
    toolName: LOCAL_SEARCH,
    state: "output-available",
    input: { query: "setup" },
    output: text("docs/development.md: bun install; make dev."),
  };
  const nested: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "code",
    toolName: "code_execution",
    state: "output-available",
    input: { code: "return await mux.tool('notion_ai_search', { query: 'onboarding' });" },
    output: { success: true, result: 3, toolCalls: [], consoleOutput: [], duration_ms: 42 },
    nestedCalls: [
      {
        toolCallId: "nested-notion",
        toolName: NOTION_SEARCH,
        input: { query: "onboarding" },
        output: text("Team onboarding checklist."),
        state: "output-available",
        mcpServer: notionSnapshot(REF_LIVE, "1.2.0"),
      },
      {
        toolCallId: "nested-local",
        toolName: LOCAL_SEARCH,
        input: { query: "onboarding" },
        output: text("docs/onboarding.md"),
        state: "output-available",
      },
    ],
  };
  return [search, fetch, local, ...(options.nested ? [nested] : [])];
}

function setupChat(options: {
  branded: boolean;
  historical?: boolean;
  nested?: boolean;
  phone?: boolean;
  longTitle?: boolean;
}) {
  if (options.phone) collapseLeftSidebar();
  else expandLeftSidebar();
  expandProjects(["/home/user/projects/xum"]);
  // The app's singleton WorkspaceStore retains history by workspace ID across
  // story switches. Distinct fixture histories need distinct workspace IDs.
  const variant = options.longTitle
    ? "long-title"
    : options.phone
      ? "phone"
      : options.nested
        ? "nested"
        : options.historical
          ? "historical"
          : options.branded
            ? "branded"
            : "plain";
  return setupSimpleChatStory({
    workspaceId: `ws-mcp-tool-identity-${variant}`,
    workspaceName: "mcp-server-identity",
    projectName: "xum",
    mcpIcons: new Map([[REF_LIVE, NOTION_ICON]]),
    messages: [
      createUserMessage(
        "request",
        "Find our workspace setup guide in Notion and check it against the local docs.",
        { historySequence: 1, timestamp: STABLE_TIMESTAMP }
      ),
      createAssistantMessage(
        "lookup",
        "I’ll check the connected Notion workspace and the local documentation.",
        { historySequence: 2, timestamp: STABLE_TIMESTAMP + 1000, toolCalls: toolCalls(options) }
      ),
      createAssistantMessage("answer", "Both guides agree: run `bun install`, then `make dev`.", {
        historySequence: 3,
        timestamp: STABLE_TIMESTAMP + 2000,
      }),
    ],
  });
}

/** Header (expand · badge · name · status) and card of a rendered tool call. */
function toolCard(root: HTMLElement, toolName: string, index = 0) {
  const name = within(root).getAllByText(toolName, { exact: true })[index];
  if (!name?.parentElement?.parentElement) throw new Error(`Tool row ${toolName} not found`);
  return { name, header: name.parentElement, card: name.parentElement.parentElement };
}

async function prepareChat(canvasElement: HTMLElement) {
  await waitForScrollStabilization(canvasElement);
  blurActiveElement();
  await within(canvasElement).findByText(NOTION_FETCH, { exact: true });
}

async function expectBranded(canvasElement: HTMLElement, title = "Notion") {
  const search = toolCard(canvasElement, NOTION_SEARCH);
  const badge = within(search.header).getByRole("button", { name: INFO_BUTTON });
  await expect(badge).toHaveTextContent(title);
  await waitFor(() => expect(badge.querySelector("img")).toHaveAttribute("src", NOTION_ICON));
  await expect(
    within(toolCard(canvasElement, LOCAL_SEARCH).header).queryByRole("button", {
      name: /Server information/,
    })
  ).not.toBeInTheDocument();
  return { search, badge };
}

const laptop = { pixel: { matrix: { viewports: ["laptop"] } } };

export const NoMetadata: AppStory = {
  render: () => <AppWithMocks setup={() => setupChat({ branded: false })} />,
  parameters: laptop,
  play: async ({ canvasElement }) => {
    await prepareChat(canvasElement);
    await expect(
      within(canvasElement).queryByRole("button", { name: /Server information/ })
    ).not.toBeInTheDocument();
  },
};

export const Branded: AppStory = {
  ...NoMetadata,
  render: () => <AppWithMocks setup={() => setupChat({ branded: true })} />,
  play: async ({ canvasElement }) => {
    await prepareChat(canvasElement);
    await expectBranded(canvasElement);
  },
};

export const ServerDetails: AppStory = {
  ...Branded,
  play: async ({ canvasElement }) => {
    await prepareChat(canvasElement);
    const { search, badge } = await expectBranded(canvasElement);
    await userEvent.click(badge);
    const dialog = await within(document.body).findByRole("dialog", { name: "About notion-work" });
    await expect(dialog).toHaveTextContent("v1.2.0");
    await expect(dialog.querySelector("img")).toHaveAttribute("src", NOTION_ICON);
    // Server details never toggle the tool; the header still does.
    await expect(search.card).not.toHaveTextContent("Arguments");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await userEvent.click(search.name);
    await expect(search.card).toHaveTextContent("Arguments");
    await userEvent.click(search.name);
    await userEvent.click(badge);
    await within(document.body).findByRole("dialog", { name: "About notion-work" });
  },
};

export const HistoricalDifferentIcons: AppStory = {
  ...Branded,
  render: () => <AppWithMocks setup={() => setupChat({ branded: true, historical: true })} />,
  play: async ({ canvasElement }) => {
    await prepareChat(canvasElement);
    await expectBranded(canvasElement);
    // Older capture: identity text stays, its ref is unknown to the host ⇒ generic icon.
    const fetch = toolCard(canvasElement, NOTION_FETCH);
    const badge = within(fetch.header).getByRole("button", { name: INFO_BUTTON });
    await expect(badge.querySelector("img")).not.toBeInTheDocument();
    await expect(badge.querySelector("svg")).toBeInTheDocument();
    await userEvent.click(badge);
    const dialog = await within(document.body).findByRole("dialog", { name: "About notion-work" });
    await expect(dialog).toHaveTextContent("v1.1.0");
  },
};

export const Nested: AppStory = {
  ...Branded,
  render: () => <AppWithMocks setup={() => setupChat({ branded: true, nested: true })} />,
  play: async ({ canvasElement }) => {
    await prepareChat(canvasElement);
    await expectBranded(canvasElement);
    const nested = toolCard(canvasElement, NOTION_SEARCH, 1);
    const badge = within(nested.header).getByRole("button", { name: INFO_BUTTON });
    await waitFor(() => expect(badge.querySelector("img")).toHaveAttribute("src", NOTION_ICON));
    await expect(
      within(toolCard(canvasElement, LOCAL_SEARCH, 1).header).queryByRole("button", {
        name: /Server information/,
      })
    ).not.toBeInTheDocument();
  },
};

const phoneParameters = { pixel: { matrix: { viewports: ["phone"] } } };
const phoneGlobals = { viewport: { value: "mobile1", isRotated: false } };

export const Phone: AppStory = {
  ...Branded,
  render: () => (
    <AppWithMocks setup={() => setupChat({ branded: true, nested: true, phone: true })} />
  ),
  globals: phoneGlobals,
  parameters: phoneParameters,
  play: async (context) => {
    await expect(context.parameters.pixel).toEqual(phoneParameters.pixel);
    await prepareChat(context.canvasElement);
    await expectBranded(context.canvasElement);
    // The test-runner plays at desktop size; only Pixel/manager pin the phone width.
    if (window.innerWidth < 768) {
      for (const badge of within(context.canvasElement).getAllByRole("button", {
        name: INFO_BUTTON,
      })) {
        const header = badge.parentElement!;
        await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      }
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    }
  },
};

/**
 * An allowed 80-char unbroken title must not push the tool name or status off
 * the card: the compact label is bounded and shrinkable, so it truncates at
 * every width while the icon, tool name and status stay visible.
 */
export const LongTitlePhone: AppStory = {
  ...Branded,
  render: () => (
    <AppWithMocks setup={() => setupChat({ branded: true, phone: true, longTitle: true })} />
  ),
  globals: phoneGlobals,
  parameters: phoneParameters,
  play: async (context) => {
    await expect(context.parameters.pixel).toEqual(phoneParameters.pixel);
    await prepareChat(context.canvasElement);
    const { search, badge } = await expectBranded(context.canvasElement, LONG_TITLE);
    const label = badge.querySelector("span");
    if (!label) throw new Error("Compact label not rendered");
    // Holds at the runner's desktop width as well as the pinned phone width.
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    await expect(search.header.scrollWidth).toBeLessThanOrEqual(search.header.clientWidth);
    await expect(search.name).toBeVisible();
    if (window.innerWidth < 768) {
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    }
  },
};
