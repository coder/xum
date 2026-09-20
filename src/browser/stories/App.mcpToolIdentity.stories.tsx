import type { ComponentType } from "react";
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

/** One user request, one assistant turn carrying the tool calls, one answer. */
function setupIdentityChat(options: {
  variant: string;
  phone?: boolean;
  request: string;
  lookup: string;
  answer: string;
  toolCalls: MuxToolPart[];
}) {
  if (options.phone) collapseLeftSidebar();
  else expandLeftSidebar();
  expandProjects(["/home/user/projects/xum"]);
  // The app's singleton WorkspaceStore retains history by workspace ID across
  // story switches. Distinct fixture histories need distinct workspace IDs.
  return setupSimpleChatStory({
    workspaceId: `ws-mcp-tool-identity-${options.variant}`,
    workspaceName: "mcp-server-identity",
    projectName: "xum",
    mcpIcons: new Map([[REF_LIVE, NOTION_ICON]]),
    messages: [
      createUserMessage("request", options.request, {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP,
      }),
      createAssistantMessage("lookup", options.lookup, {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP + 1000,
        toolCalls: options.toolCalls,
      }),
      createAssistantMessage("answer", options.answer, {
        historySequence: 3,
        timestamp: STABLE_TIMESTAMP + 2000,
      }),
    ],
  });
}

function setupChat(options: {
  branded: boolean;
  historical?: boolean;
  nested?: boolean;
  phone?: boolean;
  longTitle?: boolean;
}) {
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
  return setupIdentityChat({
    variant,
    phone: options.phone,
    request: "Find our workspace setup guide in Notion and check it against the local docs.",
    lookup: "I’ll check the connected Notion workspace and the local documentation.",
    answer: "Both guides agree: run `bun install`, then `make dev`.",
    toolCalls: toolCalls(options),
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

/**
 * Fixed 375 px frame (the plan's narrowest acceptance width): the Storybook
 * test-runner ignores `globals.viewport` and the Pixel matrix, so only a
 * decorator makes the narrow layout real for play assertions.
 */
const PHONE_FRAME = { width: 375, height: 812 } as const;
function PhoneFrameDecorator(Story: ComponentType) {
  return (
    <div data-testid="phone-frame" style={{ ...PHONE_FRAME, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

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
 * every width while the icon, tool name and status stay visible. The frame
 * decorator pins 375 px even under the desktop-sized test-runner.
 */
export const LongTitlePhone: AppStory = {
  ...Branded,
  render: () => (
    <AppWithMocks setup={() => setupChat({ branded: true, phone: true, longTitle: true })} />
  ),
  decorators: [PhoneFrameDecorator],
  globals: phoneGlobals,
  parameters: phoneParameters,
  play: async (context) => {
    await expect(context.parameters.pixel).toEqual(phoneParameters.pixel);
    const frame = await within(context.canvasElement).findByTestId("phone-frame");
    await expect(frame.clientWidth).toBe(PHONE_FRAME.width);
    await prepareChat(frame);
    const { search, badge } = await expectBranded(frame, LONG_TITLE);
    const label = badge.querySelector("span");
    if (!label) throw new Error("Compact label not rendered");
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    await expect(search.header.scrollWidth).toBeLessThanOrEqual(search.header.clientWidth);
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    // Icon, tool name and status survive next to the truncated label.
    await expect(badge.querySelector("img, svg")).toBeVisible();
    await expect(search.name).toBeVisible();
    await expect(search.name.getBoundingClientRect().right).toBeLessThanOrEqual(
      frame.getBoundingClientRect().right
    );
  },
};

// ---------------------------------------------------------------------------
// Agent Plugin servers. Their connection key is `plugin:<16 hex instance
// id>:<server>` and the model-facing tool name is that key normalized plus
// the tool, so without the badge chat would read
// `plugin_656443adaa7377b9_coder_coder_create_chat`. Seeded history, not live
// calls: the snapshots below are what the host would have frozen on the parts.
// ---------------------------------------------------------------------------

/** Two installations of the same plugin server: distinct instance IDs, same branding. */
const CODER_A_KEY = "plugin:656443adaa7377b9:coder";
const CODER_B_KEY = "plugin:9f8e7d6c5b4a3210:coder";
const CODER_A_INFO = `Server information: ${CODER_A_KEY}`;
const CODER_B_INFO = `Server information: ${CODER_B_KEY}`;
const CODER_A_CREATE_CHAT = "plugin_656443adaa7377b9_coder_coder_create_chat";
const CODER_B_LIST_TEMPLATES = "plugin_9f8e7d6c5b4a3210_coder_coder_list_templates";
/** Captured before identity snapshots existed: no `mcpServer`, so the raw name must stay. */
const CODER_A_LEGACY = "plugin_656443adaa7377b9_coder_coder_get_workspace";
/**
 * Shape buildMcpToolName yields once the base exceeds 64 chars: base cut to
 * 55, then `_` + 8-char hash. The hash must survive on the short label.
 */
const CODER_A_LONG = "plugin_656443adaa7377b9_coder_coder_create_workspace_bu_1a2b3c4d";
const CODER_A_LONG_SHORT = "coder_create_workspace_bu_1a2b3c4d";
/** Ordinary (non-plugin) server whose normalized key also prefixes its tools. */
const NOTION_PLAIN = "notion_work_notion_ai_search";

function coderSnapshot(key: string, version: string): MCPToolCallDisplay {
  return {
    connection: { key, transport: "stdio" },
    identity: {
      name: "coder-mcp",
      title: "Coder",
      version,
      description: "Manage Coder workspaces, templates and agent chats.",
      websiteUrl: "https://coder.com",
    },
    source: "connection",
  };
}

function pluginToolCalls(options: { nested?: boolean }): MuxToolPart[] {
  const createChat: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "coder-create-chat",
    toolName: CODER_A_CREATE_CHAT,
    state: "output-available",
    input: { task: "Run the UAT round on the pushed SHA", organization_id: "703f72a1" },
    output: text("Created chat 6b1c… (running)."),
    mcpServer: coderSnapshot(CODER_A_KEY, "2.0.0"),
  };
  const listTemplates: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "coder-list-templates",
    toolName: CODER_B_LIST_TEMPLATES,
    state: "output-available",
    input: {},
    output: text("coder (Write Coder on Coder), agents_allowed=true"),
    mcpServer: coderSnapshot(CODER_B_KEY, "1.9.0"),
  };
  const legacy: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "coder-legacy",
    toolName: CODER_A_LEGACY,
    state: "output-available",
    input: { workspace: "uat-runner" },
    output: text("uat-runner: running"),
  };
  const long: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "coder-long",
    toolName: CODER_A_LONG,
    state: "output-available",
    input: { template_version: "v42" },
    output: text("Build queued."),
    mcpServer: coderSnapshot(CODER_A_KEY, "2.0.0"),
  };
  const notion: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "notion-plain",
    toolName: NOTION_PLAIN,
    state: "output-available",
    input: { query: "UAT checklist" },
    output: text("Found: UAT checklist."),
    mcpServer: notionSnapshot(REF_LIVE, "1.2.0"),
  };
  const nested: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "coder-code",
    toolName: "code_execution",
    state: "output-available",
    input: { code: "return await mux.tool('coder_create_chat', { task: 'retry' });" },
    output: { success: true, result: "ok", toolCalls: [], consoleOutput: [], duration_ms: 42 },
    nestedCalls: [
      {
        toolCallId: "nested-coder",
        toolName: CODER_A_CREATE_CHAT,
        input: { task: "retry" },
        output: text("Created chat 7c2d…"),
        state: "output-available",
        mcpServer: coderSnapshot(CODER_A_KEY, "2.0.0"),
      },
      {
        toolCallId: "nested-legacy",
        toolName: CODER_A_LEGACY,
        input: { workspace: "uat-runner" },
        output: text("uat-runner: running"),
        state: "output-available",
      },
    ],
  };
  return [createChat, listTemplates, legacy, long, notion, ...(options.nested ? [nested] : [])];
}

function setupPluginChat(options: { nested?: boolean; phone?: boolean }) {
  return setupIdentityChat({
    variant: `plugin-${options.phone ? "phone" : options.nested ? "nested" : "desktop"}`,
    phone: options.phone,
    request: "Kick off a UAT chat on Coder and pull the checklist from Notion.",
    lookup: "I’ll use the installed Coder plugin and the Notion connection.",
    answer: "UAT chat created; the checklist is attached above.",
    toolCalls: pluginToolCalls(options),
  });
}

async function preparePluginChat(root: HTMLElement) {
  await waitForScrollStabilization(root);
  blurActiveElement();
  await within(root).findByText("coder_list_templates", { exact: true });
}

/** Association rules the header must honor; returns the rows later plays interact with. */
async function expectPluginLabels(root: HTMLElement) {
  const create = toolCard(root, "coder_create_chat");
  const createBadge = within(create.header).getByRole("button", { name: CODER_A_INFO });
  await expect(createBadge).toHaveTextContent("Coder");
  const list = toolCard(root, "coder_list_templates");
  within(list.header).getByRole("button", { name: CODER_B_INFO });
  const long = toolCard(root, CODER_A_LONG_SHORT);
  within(long.header).getByRole("button", { name: CODER_A_INFO });
  // The installation hash never reaches a matched row's label...
  for (const { header } of [create, list, long]) {
    await expect(header).not.toHaveTextContent(/plugin_[0-9a-f]{16}/);
  }
  // ...but older history without a snapshot keeps its raw name, unparsed.
  const legacy = toolCard(root, CODER_A_LEGACY);
  await expect(
    within(legacy.header).queryByRole("button", { name: /Server information/ })
  ).not.toBeInTheDocument();
  // Non-plugin servers are never shortened, even with a matching prefix.
  const notion = toolCard(root, NOTION_PLAIN);
  within(notion.header).getByRole("button", { name: INFO_BUTTON });
  return { create, createBadge, list, long, legacy };
}

export const PluginTools: AppStory = {
  render: () => <AppWithMocks setup={() => setupPluginChat({})} />,
  parameters: laptop,
  play: async ({ canvasElement }) => {
    await preparePluginChat(canvasElement);
    await expectPluginLabels(canvasElement);
  },
};

export const PluginServerDetails: AppStory = {
  ...PluginTools,
  play: async ({ canvasElement }) => {
    await preparePluginChat(canvasElement);
    const { create, createBadge, list } = await expectPluginLabels(canvasElement);
    await userEvent.click(createBadge);
    const dialog = await within(document.body).findByRole("dialog", {
      name: `About ${CODER_A_KEY}`,
    });
    // The popover keeps the exact configured connection the label dropped.
    await expect(dialog).toHaveTextContent(CODER_A_KEY);
    await expect(dialog).toHaveTextContent("v2.0.0");
    await expect(dialog).toHaveTextContent("stdio");
    await expect(create.card).not.toHaveTextContent("Arguments");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    // The sibling installation resolves to its own connection and version.
    await userEvent.click(within(list.header).getByRole("button", { name: CODER_B_INFO }));
    const sibling = await within(document.body).findByRole("dialog", {
      name: `About ${CODER_B_KEY}`,
    });
    await expect(sibling).toHaveTextContent(CODER_B_KEY);
    await expect(sibling).toHaveTextContent("v1.9.0");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(sibling).not.toBeInTheDocument());
    // Expanding still works from the short label and shows the untouched call.
    await userEvent.click(create.name);
    await expect(create.card).toHaveTextContent("Arguments");
    await expect(create.card).toHaveTextContent("Run the UAT round on the pushed SHA");
  },
};

export const PluginNested: AppStory = {
  ...PluginTools,
  render: () => <AppWithMocks setup={() => setupPluginChat({ nested: true })} />,
  play: async ({ canvasElement }) => {
    await preparePluginChat(canvasElement);
    await expectPluginLabels(canvasElement);
    // Nested rows go through the same header: shortened with its badge, or raw without one.
    const nested = toolCard(canvasElement, "coder_create_chat", 1);
    within(nested.header).getByRole("button", { name: CODER_A_INFO });
    await expect(nested.header).not.toHaveTextContent(/plugin_[0-9a-f]{16}/);
    const nestedLegacy = toolCard(canvasElement, CODER_A_LEGACY, 1);
    await expect(
      within(nestedLegacy.header).queryByRole("button", { name: /Server information/ })
    ).not.toBeInTheDocument();
  },
};

/** 375 px frame: short labels, badges and status must all fit without horizontal overflow. */
export const PluginPhone: AppStory = {
  ...PluginTools,
  render: () => <AppWithMocks setup={() => setupPluginChat({ phone: true })} />,
  decorators: [PhoneFrameDecorator],
  globals: phoneGlobals,
  parameters: phoneParameters,
  play: async (context) => {
    await expect(context.parameters.pixel).toEqual(phoneParameters.pixel);
    const frame = await within(context.canvasElement).findByTestId("phone-frame");
    await expect(frame.clientWidth).toBe(PHONE_FRAME.width);
    await preparePluginChat(frame);
    const { create, list, long } = await expectPluginLabels(frame);
    for (const { header, name } of [create, list, long]) {
      await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      await expect(name).toBeVisible();
      await expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(
        frame.getBoundingClientRect().right
      );
    }
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
  },
};
