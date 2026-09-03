import { useRef } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import type { MCPServerInfo } from "@/common/types/mcp";

import { WorkspaceMCPModal } from "./WorkspaceMCPModal";
import { NOW } from "@/browser/stories/storyTime";

const PROJECT_PATH = "/Users/test/my-app";
const WORKSPACE_ID = "ws-mcp-test";

const MOCK_TOOLS = [
  "file_read",
  "file_write",
  "bash",
  "web_search",
  "web_fetch",
  "todo_write",
  "todo_read",
  "status_set",
];

const POSTHOG_TOOLS = [
  "add-insight-to-dashboard",
  "dashboard-create",
  "dashboard-delete",
  "dashboard-get",
  "dashboards-get-all",
  "dashboard-update",
  "docs-search",
  "error-details",
  "list-errors",
  "create-feature-flag",
  "delete-feature-flag",
  "feature-flag-get-all",
  "experiment-get-all",
  "experiment-create",
];

// The modal scopes its tool test cache by workspace (agent-plugins experiment:
// plugin server keys are stable across worktrees, but tool lists follow each
// workspace's checkout), so stories must seed the workspace-scoped key.
const PROJECT_MCP_CACHE_KEY = getMCPTestResultsKey(PROJECT_PATH, WORKSPACE_ID);

interface WorkspaceMCPStoryOptions {
  servers?: Record<string, MCPServerInfo>;
  workspaceOverrides?: {
    disabledServers?: string[];
    enabledServers?: string[];
    toolAllowlist?: Record<string, string[]>;
  };
  testResults?: Record<string, string[]>;
  preCacheTools?: boolean;
}

function setupWorkspaceMCPModalStory(options: WorkspaceMCPStoryOptions = {}): APIClient {
  // User rationale: these stories should render the modal in isolation and keep
  // MCP tool cache deterministic per scenario instead of reusing app-shell state.
  updatePersistedState(PROJECT_MCP_CACHE_KEY, {});

  if (options.preCacheTools && options.testResults) {
    const cachedResults: Record<
      string,
      {
        result: { success: true; tools: string[] };
        testedAt: number;
      }
    > = {};

    for (const [serverName, tools] of Object.entries(options.testResults)) {
      cachedResults[serverName] = {
        result: { success: true, tools },
        testedAt: NOW,
      };
    }

    updatePersistedState(PROJECT_MCP_CACHE_KEY, cachedResults);
  }

  const workspaces = [
    createWorkspace({
      id: WORKSPACE_ID,
      name: "main",
      projectName: "my-app",
      projectPath: PROJECT_PATH,
    }),
  ];

  const mcpServers = new Map<string, Record<string, MCPServerInfo>>();
  if (options.servers) {
    mcpServers.set(PROJECT_PATH, options.servers);
  }

  const mcpOverrides = new Map<
    string,
    {
      disabledServers?: string[];
      enabledServers?: string[];
      toolAllowlist?: Record<string, string[]>;
    }
  >();
  if (options.workspaceOverrides) {
    mcpOverrides.set(WORKSPACE_ID, options.workspaceOverrides);
  }

  const mcpTestResults = new Map<string, { success: true; tools: string[] }>();
  if (options.testResults) {
    for (const [serverName, tools] of Object.entries(options.testResults)) {
      mcpTestResults.set(serverName, { success: true, tools });
    }
  }

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    mcpServers,
    mcpOverrides,
    mcpTestResults,
  });
}

const WorkspaceMCPModalStoryShell: FC<{ setup: () => APIClient; children: ReactNode }> = ({
  setup,
  children,
}) => {
  const setupRef = useRef(setup);
  const clientRef = useRef<APIClient | null>(null);
  if (clientRef.current === null || setupRef.current !== setup) {
    setupRef.current = setup;
    clientRef.current = setup();
  }

  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={clientRef.current}>
          <ExperimentsProvider>
            <RouterProvider>
              <SettingsProvider>{children}</SettingsProvider>
            </RouterProvider>
          </ExperimentsProvider>
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

function renderWorkspaceMCPModal(options: WorkspaceMCPStoryOptions): JSX.Element {
  return (
    <WorkspaceMCPModalStoryShell setup={() => setupWorkspaceMCPModalStory(options)}>
      <WorkspaceMCPModal
        workspaceId={WORKSPACE_ID}
        projectPath={PROJECT_PATH}
        open={true}
        onOpenChange={() => {
          // Keep modal visible for interaction stories.
        }}
      />
    </WorkspaceMCPModalStoryShell>
  );
}

function queryWorkspaceMCPDialog(ownerDocument: Document): HTMLElement | null {
  const dialog = Array.from(ownerDocument.querySelectorAll('[role="dialog"]')).find((element) =>
    element.textContent?.includes("Workspace MCP Configuration")
  );

  return dialog instanceof HTMLElement ? dialog : null;
}

async function findWorkspaceMCPDialog(canvasElement: HTMLElement): Promise<HTMLElement> {
  return waitFor(
    () => {
      const dialog = queryWorkspaceMCPDialog(canvasElement.ownerDocument);
      if (!dialog) {
        throw new Error("Workspace MCP dialog not found");
      }
      return dialog;
    },
    { timeout: 10000 }
  );
}

const meta: Meta<typeof WorkspaceMCPModal> = {
  title: "Components/WorkspaceMCPModal",
  component: WorkspaceMCPModal,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const WorkspaceMCPNoOverrides: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
        posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
      },
      testResults: {
        mux: MOCK_TOOLS,
        posthog: POSTHOG_TOOLS,
      },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    await expect(modal.findByText("mux")).resolves.toBeInTheDocument();
    await expect(modal.findByText("posthog")).resolves.toBeInTheDocument();
  },
};

export const WorkspaceMCPProjectDisabledServer: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
        posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: true },
      },
      testResults: {
        mux: MOCK_TOOLS,
        posthog: POSTHOG_TOOLS,
      },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    await expect(modal.findByText("posthog")).resolves.toBeInTheDocument();
    await expect(modal.findByText(/disabled at project level/i)).resolves.toBeInTheDocument();
  },
};

export const WorkspaceMCPEnabledOverride: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
        posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: true },
      },
      workspaceOverrides: {
        enabledServers: ["posthog"],
      },
      testResults: {
        mux: MOCK_TOOLS,
        posthog: POSTHOG_TOOLS,
      },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    await expect(modal.findByText("posthog")).resolves.toBeInTheDocument();
    await expect(modal.findByText(/disabled at project level/i)).resolves.toBeInTheDocument();

    const posthogSwitch = await modal.findByRole("switch", {
      name: /toggle posthog mcp server/i,
    });
    await expect(posthogSwitch).toHaveAttribute("aria-checked", "true");
  },
};

export const WorkspaceMCPDisabledOverride: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
        posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
      },
      workspaceOverrides: {
        disabledServers: ["posthog"],
      },
      testResults: {
        mux: MOCK_TOOLS,
        posthog: POSTHOG_TOOLS,
      },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    await expect(modal.findByText("mux")).resolves.toBeInTheDocument();
    await expect(modal.findByText("posthog")).resolves.toBeInTheDocument();

    const posthogSwitch = await modal.findByRole("switch", {
      name: /toggle posthog mcp server/i,
    });
    await expect(posthogSwitch).toHaveAttribute("aria-checked", "false");
  },
};

export const WorkspaceMCPWithToolAllowlist: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
      },
      workspaceOverrides: {
        toolAllowlist: {
          posthog: ["docs-search", "error-details", "list-errors"],
        },
      },
      testResults: {
        posthog: POSTHOG_TOOLS,
      },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    await expect(modal.findByText("posthog")).resolves.toBeInTheDocument();
    await expect(modal.findByText(/3 of 14 tools enabled/i)).resolves.toBeInTheDocument();
  },
};

export const ToolSelectorInteraction: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
      },
      testResults: {
        mux: MOCK_TOOLS,
      },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    const allButton = await modal.findByRole("button", { name: /^All$/i });
    await expect(allButton).toBeDisabled();

    const noneButton = await modal.findByRole("button", { name: /^None$/i });
    await userEvent.click(noneButton);

    await waitFor(() => {
      return expect(noneButton).toBeDisabled();
    });

    modal.getByText((_content: string, element: Element | null) => {
      const normalizedText = (element?.textContent ?? "").replace(/\s+/g, " ").trim();
      return /^0 of \d+ tools enabled$/i.test(normalizedText);
    });

    const allButtonAfterNone = await modal.findByRole("button", { name: /^All$/i });
    await expect(allButtonAfterNone).toBeEnabled();

    await userEvent.click(allButtonAfterNone);

    await waitFor(() => {
      return expect(allButtonAfterNone).toBeDisabled();
    });
  },
};

export const ToggleServerEnabled: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
        posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
      },
      testResults: {
        mux: MOCK_TOOLS,
        posthog: POSTHOG_TOOLS,
      },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    const posthogSwitch = await modal.findByRole("switch", {
      name: /toggle posthog mcp server/i,
    });

    await expect(posthogSwitch).toHaveAttribute("aria-checked", "true");
    await userEvent.click(posthogSwitch);

    await waitFor(() => {
      return expect(posthogSwitch).toHaveAttribute("aria-checked", "false");
    });
  },
};

/**
 * Agent Plugin provenance with worst-case long names must not overflow the
 * dialog horizontally — especially at the phone viewport, where an unbroken
 * token would push the Fetch Tools button past the dialog edge. The play
 * contract asserts no horizontal overflow at any viewport (the long fixture
 * name overflows even the desktop max-w-2xl dialog without the min-w-0 fix);
 * the Pixel phone variant guards the narrow rendering visually.
 */
export const WorkspaceMCPPluginServersNarrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    ...meta.parameters,
    pixel: {
      matrix: { themes: ["dark"], viewports: ["phone"] },
    },
  },
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        "plugin:abc123:everything": {
          transport: "stdio",
          command: "bunx",
          disabled: true,
          plugin: {
            // No hyphens: hyphenated names wrap naturally, but the name grammar
            // also allows unbroken alphanumeric/dot tokens, which only wrap when
            // the layout allows shrinking (min-w-0) and breaking (break-words).
            pluginName: "extremelylongpluginnamethatkeepsgoingandgoingforawhile0123456789",
            serverName: "verylongmcpservernamewithmanytokensandthensome",
            sourceScope: "project",
            sourceLocation:
              ".agents/plugins/extremelylongpluginnamethatkeepsgoingandgoingforawhile0123456789",
          },
        },
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
      },
      testResults: { mux: MOCK_TOOLS },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const dialog = await findWorkspaceMCPDialog(canvasElement);
    const modal = within(dialog);

    await expect(
      modal.findByText(/\.agents\/plugins\/extremelylongpluginname/)
    ).resolves.toBeInTheDocument();

    // No horizontal overflow: long unbroken provenance must wrap/break inside
    // the dialog instead of widening its scrollable content.
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  },
};
