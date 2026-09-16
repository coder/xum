import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { ExternalLink, Plug } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, expandLeftSidebar, expandProjects } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { blurActiveElement, waitForScrollStabilization } from "./storyPlayHelpers";
import notionIcon from "./assets/notion-mcp.prototype.svg";

export default {
  ...appMeta,
  title: "App/Prototypes/MCP Identity",
  parameters: {
    ...appMeta.parameters,
    docs: {
      description: {
        component:
          "Design-only inserts in the real App's GenericToolCall headers (chat identity lands in slice 3). Compare Current and Proposed with identical fixtures. Settings identity is implemented: see App/MCP Identity.",
      },
    },
  },
};

const NOTION_SEARCH = "mcp__notion__notion_ai_search";
const NOTION_FETCH = "mcp__notion__notion_fetch";
const LOCAL_SEARCH = "mcp__local_docs__search";
const CONNECTIONS = [
  {
    key: "notion-work",
    name: "Notion MCP",
    shortName: "Notion",
    version: "1.2.0",
    description: "Search your workspace, fetch specs and PRDs, and track tasks with your team.",
    endpoint: "https://mcp.notion.com/mcp",
    website: "https://developers.notion.com/docs/mcp",
    icon: notionIcon,
  },
  {
    key: "local-docs",
    name: "local-docs",
    shortName: "local-docs",
    version: null,
    description: "No display information provided. Using the configured connection name.",
    endpoint: "bun run docs-server.ts",
    website: null,
    icon: null,
  },
] as const;

type Connection = (typeof CONNECTIONS)[number];

function setupIdentityStory(phone: boolean) {
  if (phone) collapseLeftSidebar();
  else expandLeftSidebar();
  expandProjects(["/home/user/projects/xum"]);
  const client = setupSimpleChatStory({
    workspaceId: "ws-mcp-identity-prototype",
    workspaceName: "mcp-server-identity",
    projectName: "xum",
    messages: [
      createUserMessage(
        "request",
        "Find our workspace setup guide in Notion and check it against the local docs.",
        {
          historySequence: 1,
          timestamp: STABLE_TIMESTAMP,
        }
      ),
      createAssistantMessage(
        "lookup",
        "I’ll check the connected Notion workspace and the local documentation.",
        {
          historySequence: 2,
          timestamp: STABLE_TIMESTAMP + 1000,
          toolCalls: [
            {
              type: "dynamic-tool",
              toolCallId: "notion-search",
              toolName: NOTION_SEARCH,
              state: "output-available",
              input: { query: "workspace setup guide" },
              output: {
                content: [
                  {
                    type: "text",
                    text: "Found: Workspace setup guide; Development environment; Team onboarding.",
                  },
                ],
              },
            },
            {
              type: "dynamic-tool",
              toolCallId: "notion-fetch",
              toolName: NOTION_FETCH,
              state: "output-available",
              input: { id: "workspace-setup-guide" },
              output: {
                content: [
                  {
                    type: "text",
                    text: "Workspace setup guide: clone the repository, install dependencies with bun install, then run make dev.",
                  },
                ],
              },
            },
            {
              type: "dynamic-tool",
              toolCallId: "local-search",
              toolName: LOCAL_SEARCH,
              state: "output-available",
              input: { query: "setup" },
              output: {
                content: [{ type: "text", text: "docs/development.md: bun install; make dev." }],
              },
            },
          ],
        }
      ),
      createAssistantMessage(
        "answer",
        "Both guides agree: run `bun install`, then `make dev`. The Notion page also links to the team onboarding checklist.",
        {
          historySequence: 3,
          timestamp: STABLE_TIMESTAMP + 2000,
        }
      ),
    ],
  });
  return client;
}

function Identity(props: { connection: Connection; compact: boolean }) {
  const connection = props.connection;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Server information: ${connection.key}`}
          // A server-info click must not also expand the surrounding real tool header.
          onClick={(event) => event.stopPropagation()}
          className="text-muted hover:text-foreground focus-visible:ring-accent inline-flex shrink-0 items-center gap-1 rounded px-0.5 align-middle font-sans text-[10px] focus-visible:ring-1"
        >
          {connection.icon ? (
            <img src={connection.icon} alt="" className="size-4 object-contain" />
          ) : (
            <Plug aria-hidden className="size-3.5" />
          )}
          {props.compact && <span>{connection.shortName}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="bg-modal-bg text-foreground w-[300px] max-w-[calc(100vw-24px)] p-3 font-sans text-xs"
        aria-label={`About ${connection.key}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          {connection.icon ? (
            <img src={connection.icon} alt="" className="size-7 object-contain" />
          ) : (
            <Plug aria-hidden className="size-6" />
          )}
          <div className="min-w-0">
            <div className="font-medium">{connection.name}</div>
            {connection.version && (
              <div className="text-muted text-[10px]">v{connection.version}</div>
            )}
          </div>
        </div>
        <p className="text-muted mb-3 leading-relaxed">{connection.description}</p>
        <div className="border-border border-t pt-2">
          <div className="text-muted mb-1 text-[10px]">Configured connection</div>
          <div className="font-mono text-[11px]">{connection.key}</div>
          <div className="text-muted mt-1 font-mono text-[10px] break-all">
            {connection.endpoint}
          </div>
        </div>
        {connection.website && (
          <a
            href={connection.website}
            target="_blank"
            rel="noreferrer"
            className="text-link mt-3 inline-flex items-center gap-1"
          >
            Website <ExternalLink aria-hidden className="size-3" />
          </a>
        )}
        <p className="text-muted mt-3 text-[10px]">
          Server-provided display information. Not a verified identity.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function IdentityPrototype(props: { phone?: boolean; proposed?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<Array<{ node: HTMLElement; connection: Connection }>>([]);
  useEffect(() => {
    if (!props.proposed || !host.current) return;
    const root = host.current;
    const owned: HTMLElement[] = [];
    const targets = [
      [NOTION_SEARCH, CONNECTIONS[0]],
      [NOTION_FETCH, CONNECTIONS[0]],
      [LOCAL_SEARCH, CONNECTIONS[1]],
    ] as const;
    // Disposable story-only inserts: keep the actual app shell, rows, headers and
    // handlers. Never replace React-owned text/children or add production mock props.
    // The observer disconnects as soon as this story's async fixture has mounted.
    const attach = () => {
      const labels = targets.map(([text]) =>
        Array.from(root.querySelectorAll("span")).find(
          (node) => node.childElementCount === 0 && node.textContent === text
        )
      );
      if (labels.some((label) => !label)) return;
      observer.disconnect();
      setSlots(
        targets.map(([, connection], index) => {
          const node = document.createElement("span");
          node.className = "inline-flex shrink-0 items-center";
          node.dataset.mcpIdentityPrototype = connection.key;
          labels[index]!.before(node);
          owned.push(node);
          return { node, connection };
        })
      );
    };
    const observer = new MutationObserver(attach);
    observer.observe(root, { subtree: true, childList: true });
    attach();
    return () => {
      observer.disconnect();
      for (const node of owned) node.remove();
    };
  }, [props.proposed]);
  return (
    <div ref={host} className="h-full w-full">
      <AppWithMocks setup={() => setupIdentityStory(props.phone === true)} />
      {slots.map(({ node, connection }, index) =>
        createPortal(<Identity connection={connection} compact />, node, String(index))
      )}
    </div>
  );
}

async function prepareChat(canvasElement: HTMLElement, proposed: boolean) {
  await waitForScrollStabilization(canvasElement);
  blurActiveElement();
  const canvas = within(canvasElement);
  await canvas.findByText(NOTION_SEARCH);
  if (proposed) {
    await expect(
      await canvas.findAllByRole("button", { name: "Server information: notion-work" })
    ).toHaveLength(2);
    await canvas.findByRole("button", { name: "Server information: local-docs" });
  } else
    await expect(
      canvas.queryByRole("button", { name: /Server information:/ })
    ).not.toBeInTheDocument();
}

export const CurrentChat: AppStory = {
  render: () => <IdentityPrototype />,
  parameters: { pixel: { matrix: { viewports: ["laptop"] } } },
  play: async ({ canvasElement }) => prepareChat(canvasElement, false),
};
export const ProposedChat: AppStory = {
  ...CurrentChat,
  render: () => <IdentityPrototype proposed />,
  play: async ({ canvasElement }) => prepareChat(canvasElement, true),
};
export const ChatServerDetails: AppStory = {
  ...ProposedChat,
  play: async ({ canvasElement }) => {
    await prepareChat(canvasElement, true);
    const canvas = within(canvasElement);
    const tool = canvas.getByText(NOTION_SEARCH);
    const header = tool.parentElement!;
    const info = canvas.getAllByRole("button", { name: "Server information: notion-work" })[0];
    await userEvent.click(info);
    const dialog = await within(document.body).findByRole("dialog", { name: "About notion-work" });
    await expect(header.parentElement).not.toHaveTextContent("Arguments");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await userEvent.click(tool);
    await expect(header.parentElement).toHaveTextContent("Arguments");
    await userEvent.click(tool);
    await userEvent.click(info);
  },
};
const phoneParameters = { pixel: { matrix: { viewports: ["phone"] } } };
const phoneGlobals = { viewport: { value: "mobile1", isRotated: false } };
export const ChatPhone: AppStory = {
  ...ProposedChat,
  render: () => <IdentityPrototype phone proposed />,
  globals: phoneGlobals,
  parameters: phoneParameters,
  play: async (context) => {
    await expect(context.parameters.pixel).toEqual(phoneParameters.pixel);
    await prepareChat(context.canvasElement, true);
    if (window.innerWidth < 768) {
      for (const slot of context.canvasElement.querySelectorAll<HTMLElement>(
        "[data-mcp-identity-prototype]"
      )) {
        await expect(slot.parentElement!.scrollWidth).toBeLessThanOrEqual(
          slot.parentElement!.clientWidth
        );
      }
    }
  },
};
