import { useRef, useState } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, useAPI, type APIClient } from "@/browser/contexts/API";
import { ConfirmDialogProvider } from "@/browser/contexts/ConfirmDialogContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { textContrast } from "@/browser/stories/helpers/contrast";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import type { MCPServerInfo } from "@/common/types/mcp";
import type { MCPSettingsSnapshot } from "@/common/utils/mcpSettings";
import type { McpAppView } from "@/common/orpc/schemas/mcpApps";

import { WorkspaceMCPModal } from "./WorkspaceMCPModal";

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

// The modal scopes its tool test cache by workspace (plugin server keys are
// stable across worktrees, but tool lists follow each workspace's checkout),
// so stories must seed the workspace-scoped key.
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
  settings?: Record<string, MCPSettingsSnapshot>;
  /** Servers the workspace already runs (the dialog reads their settings on open). */
  settingsConnected?: string[];
  settingsReads?: string[][];
  settingsReadErrors?: Record<string, string>;
  settingsUpdateGate?: { promise: Promise<void> } | Array<{ promise: Promise<void> }>;
  settingsFirstReadGate?: { promise: Promise<void> };
  /** Per server: what its first settings read returns (an older catalog than `settings`). */
  settingsStaleFirstRead?: Record<string, MCPSettingsSnapshot>;
  settingsAfterSave?: Record<string, MCPSettingsSnapshot>;
  settingsToolRuns?: Array<{ toolName: string; confirmed: boolean }>;
  settingsToolRunGate?: { promise: Promise<void> };
  settingsToolRunSets?: Record<string, Record<string, string | number | boolean>>;
  settingsToolRunErrors?: string[];
  settingsToolRunFailures?: string[];
  settingsRestartAfterFirstRead?: string[];
  /** MCP Apps views by view key (a settings app action opens `settings:<server>:<tool>`). */
  mcpAppViews?: Record<string, McpAppView>;
  testGate?: { promise: Promise<void> };
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
        testedAt: Date.now(),
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
    // Copied per story: the mock update writes into its snapshot.
    mcpSettings: new Map(
      Object.entries(options.settings ?? {}).map(([name, snapshot]) => [
        name,
        structuredClone(snapshot),
      ])
    ),
    mcpSettingsConnected: new Set(options.settingsConnected ?? []),
    mcpSettingsReads: options.settingsReads,
    mcpSettingsReadErrors: new Map(Object.entries(options.settingsReadErrors ?? {})),
    mcpSettingsUpdateGate: options.settingsUpdateGate,
    mcpSettingsFirstReadGate: options.settingsFirstReadGate,
    mcpSettingsStaleFirstRead: new Map(Object.entries(options.settingsStaleFirstRead ?? {})),
    mcpSettingsAfterUpdate: new Map(Object.entries(options.settingsAfterSave ?? {})),
    mcpSettingsToolRuns: options.settingsToolRuns,
    mcpSettingsToolRunGate: options.settingsToolRunGate,
    mcpSettingsToolRunSets: new Map(Object.entries(options.settingsToolRunSets ?? {})),
    mcpSettingsToolRunErrors: new Set(options.settingsToolRunErrors ?? []),
    mcpSettingsToolRunFailures: new Set(options.settingsToolRunFailures ?? []),
    mcpSettingsRestartAfterFirstRead: new Set(options.settingsRestartAfterFirstRead ?? []),
    ...(options.mcpAppViews ? { mcpApps: { views: options.mcpAppViews } } : {}),
    mcpTestGate: options.testGate,
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
          <RouterProvider>
            <SettingsProvider>
              <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
            </SettingsProvider>
          </RouterProvider>
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
  // Pixel snapshot budget: its frame (mux, then posthog switched on) repeats
  // WorkspaceMCPEnabledOverride minus the project label; its play still runs.
  parameters: { pixel: PIXEL_DISABLED },
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

// #4297: a server disabled only in the global MCP settings must not be
// attributed to the project layer.
export const WorkspaceMCPGlobalDisabledServer: Story = {
  // Behavioral contract only: WorkspaceMCPProjectDisabledServer already snapshots
  // this layout, and the Pixel budget has no headroom for a copy-only variant.
  parameters: { pixel: { exclude: true } },
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        posthog: {
          transport: "stdio",
          command: "npx -y posthog-mcp-server",
          disabled: true,
          configLayer: "global",
        },
      },
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));

    await expect(modal.findByText("(disabled globally)")).resolves.toBeInTheDocument();
    await expect(modal.queryByText(/disabled at project level/i)).not.toBeInTheDocument();
  },
};

export const WorkspaceMCPProjectDisabledServer: Story = {
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
        posthog: {
          transport: "stdio",
          command: "npx -y posthog-mcp-server",
          disabled: true,
          configLayer: "project",
        },
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
        posthog: {
          transport: "stdio",
          command: "npx -y posthog-mcp-server",
          disabled: true,
          configLayer: "project",
        },
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
  // Pixel snapshot budget: its frame (mux, then posthog switched off) repeats
  // WorkspaceMCPProjectDisabledServer minus the project label; its play still runs.
  parameters: { pixel: PIXEL_DISABLED },
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

// #4718: dialog help text must meet WCAG AA (4.5:1). Light is the failing
// theme for the old token. Disabled rows are dimmed on purpose (WCAG exempts
// inactive controls), so only enabled rows are measured.
export const WorkspaceMCPHelpTextContrastLight: Story = {
  globals: { theme: "light" },
  // Behavioral contract only: the Pixel budget has no headroom, and the
  // neighboring stories already snapshot this layout.
  parameters: { pixel: { exclude: true } },
  render: () =>
    renderWorkspaceMCPModal({
      servers: {
        "plugin:abc123:echo": {
          transport: "stdio",
          command: "bunx echo-mcp",
          disabled: false,
          plugin: {
            pluginName: "hello-plugin",
            serverName: "echo",
            sourceScope: "global",
            sourceLocation: ".xum/plugins/hello-plugin",
          },
        },
        posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
      },
      workspaceOverrides: { toolAllowlist: { posthog: ["docs-search"] } },
      testResults: { posthog: POSTHOG_TOOLS },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const helpTexts = [
      await modal.findByText(/Customize which MCP servers/),
      await modal.findByText(/^Agent Plugin \(/),
      await modal.findByText(/1 of 14 tools enabled/),
      await modal.findByText("Select tools to expose:"),
    ];
    for (const helpText of helpTexts) {
      await expect(textContrast(helpText)).toBeGreaterThanOrEqual(4.5);
    }
  },
};

export const ToolSelectorInteraction: Story = {
  // Pixel snapshot budget, play-only: its frame repeats the mux row other snapshots show.
  parameters: { pixel: PIXEL_DISABLED },
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
  // Pixel snapshot budget, play-only: its frame repeats WorkspaceMCPEnabledOverride.
  parameters: { pixel: PIXEL_DISABLED },
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

/** CAD-style settings: every control kind, a layout group with a tool item, and "Other settings". */
const CAD_SETTINGS: MCPSettingsSnapshot = {
  properties: {
    units: { type: "string", title: "Units", enum: ["mm", "in"] },
    grid: { type: "boolean", title: "Show grid", description: "Draws a <b>grid</b> behind parts." },
    zoom: { type: "integer", title: "Default zoom", minimum: 1, maximum: 5 },
    prefix: { type: "string", title: "Part prefix", maxLength: 2 },
    // "" is a valid enum option (the Select maps options to indexes).
    finish: { type: "string", title: "Finish", enum: ["", "matte"] },
  },
  values: { units: "mm", grid: true, zoom: 2, prefix: "BB", finish: "" },
  layout: [
    {
      title: "Display",
      items: [
        { kind: "property", property: "units" },
        { kind: "property", property: "grid" },
        {
          kind: "tool",
          tool: "cad.library",
          description: "Manage part libraries",
          action: { title: "Part library", readOnly: true, opensApp: false },
        },
        {
          kind: "tool",
          tool: "cad.reset",
          action: { title: "Reset parts", readOnly: false, opensApp: false },
        },
        {
          kind: "tool",
          tool: "cad.payment",
          action: { title: "Payment method", readOnly: false, opensApp: true },
        },
        // Not listed by the server, or excluded by the tool allowlist.
        { kind: "tool", tool: "cad.export" },
      ],
    },
    {
      title: "Other settings",
      items: [
        { kind: "property", property: "zoom" },
        { kind: "property", property: "prefix" },
        { kind: "property", property: "finish" },
      ],
    },
  ],
  warnings: ["Setting 'color' has an unsupported schema; ignoring it"],
  droppedSettingCount: 1,
};

const settingsStoryOptions = (): WorkspaceMCPStoryOptions => ({
  servers: { cad: { transport: "stdio", command: "bunx cad-mcp", disabled: false } },
  testResults: { cad: ["draw_part"] },
  settings: { cad: CAD_SETTINGS },
  settingsConnected: ["cad"],
});

/**
 * Shared play: settings load on open (no Fetch Tools), render as text, note the
 * dropped setting, validate, and send changes.
 */
async function exerciseServerSettings(
  canvasElement: HTMLElement,
  /** Forces the dialog to this width: the CI test runner plays at desktop size. */
  narrowWidthPx?: number
): Promise<void> {
  const dialog = await findWorkspaceMCPDialog(canvasElement);
  if (narrowWidthPx !== undefined) {
    // No transition: the dialog's duration-200 would animate the width change.
    dialog.style.transition = "none";
    dialog.style.width = `${narrowWidthPx}px`;
    dialog.style.maxWidth = `${narrowWidthPx}px`;
    await expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(narrowWidthPx);
  }
  const modal = within(dialog);
  const section = within(await modal.findByTestId("mcp-server-settings"));
  await expect(modal.getByRole("button", { name: "Fetch Tools" })).toBeInTheDocument();
  await expect(
    section.findByRole("button", { name: "Open Payment method" })
  ).resolves.toBeInTheDocument();
  await expect(
    section.findByText(/This server sent 1 setting Xum cannot show/)
  ).resolves.toBeInTheDocument();
  // Server strings are text, never markup.
  await expect(
    section.findByText("Draws a <b>grid</b> behind parts.")
  ).resolves.toBeInTheDocument();
  const save = section.getByRole("button", { name: "Save settings" });
  await expect(save).toBeDisabled();

  const zoom = section.getByLabelText("Default zoom setting");
  await userEvent.clear(zoom);
  await userEvent.type(zoom, "9");
  await expect(section.findByText("Default zoom must be at most 5")).resolves.toBeInTheDocument();
  await expect(save).toBeDisabled();

  await userEvent.clear(zoom);
  await userEvent.type(zoom, "3");
  await waitFor(() => expect(save).toBeEnabled());
  await expect(section.getByLabelText("Finish setting")).toHaveTextContent("(empty)");
  // The save shortcut (SAVE_EDIT) works from any control in the section.
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(save).toBeDisabled());
  await expect(zoom).toHaveValue(3);
  await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
}

export const WorkspaceMCPServerSettings: Story = {
  render: () => renderWorkspaceMCPModal(settingsStoryOptions()),
  play: async ({ canvasElement }) => exerciseServerSettings(canvasElement),
};

export const WorkspaceMCPServerSettingsNarrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    ...meta.parameters,
    pixel: {
      matrix: { themes: ["dark"], viewports: ["phone"] },
    },
  },
  render: () => renderWorkspaceMCPModal(settingsStoryOptions()),
  // The phone viewport (390px) minus the dialog's side margins.
  play: async ({ canvasElement }) => exerciseServerSettings(canvasElement, 358),
};

// Settings stories marked PIXEL_DISABLED exist for their plays (which still run in Test /
// Storybook). Their first frame adds no look beyond WorkspaceMCPServerSettings and its Narrow
// variant, so they skip Pixel to stay within the snapshot budget.
/** The latest WorkspaceMCPServerSettingsToolActions render's runs (its play reads them). */
let toolActionRuns: Array<{ toolName: string; confirmed: boolean }> = [];
let toolActionGate = Promise.withResolvers<void>();
/**
 * Layout tool actions: a read-only tool runs at once and shows its text; a tool that can write
 * asks first (Cancel runs nothing); an MCP App tool opens its view in a modal (after the same
 * confirmation); an unavailable tool stays disabled.
 */
export const WorkspaceMCPServerSettingsToolActions: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    const runs: Array<{ toolName: string; confirmed: boolean }> = [];
    toolActionRuns = runs;
    toolActionGate = Promise.withResolvers<void>();
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settingsToolRuns: runs,
      settingsToolRunGate: toolActionGate,
      mcpAppViews: {
        "settings:cad:cad.payment": {
          html: "<!doctype html><html><body><strong>Card form</strong></body></html>",
          csp: {},
          prefersBorder: null,
          resultAvailable: true,
          result: { content: [] },
          invocation: null,
        },
      },
    });
  },
  play: async ({ canvasElement }) => {
    const dialog = await findWorkspaceMCPDialog(canvasElement);
    let section = within(await within(dialog).findByTestId("mcp-server-settings"));
    const page = within(canvasElement.ownerDocument.body);
    // The spec's display name (the tool's title), not the raw tool name.
    await userEvent.click(await section.findByRole("button", { name: "Run Part library" }));
    // While it runs, Refresh Tools and the other runs wait: a refresh remounts the section and
    // would drop the result.
    await waitFor(() => expect(toolActionRuns).toHaveLength(1));
    await expect(
      within(dialog).getByRole("button", { name: /(Fetch|Refresh) Tools/ })
    ).toBeDisabled();
    await expect(section.getByRole("button", { name: "Run Reset parts" })).toBeDisabled();
    // The dialog's Save closes it, so it waits too.
    await expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    // A writing run re-reads the settings when it ends: an edit made meanwhile would be lost.
    await expect(section.getByLabelText("Default zoom setting")).toBeDisabled();
    toolActionGate.resolve();
    await expect(section.findByText("cad.library finished")).resolves.toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: /(Fetch|Refresh) Tools/ })).toBeEnabled()
    );
    await expect(toolActionRuns).toEqual([{ toolName: "cad.library", confirmed: false }]);

    await userEvent.click(section.getByRole("button", { name: "Run Reset parts" }));
    await userEvent.click(await page.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(page.queryByText("Run Reset parts?")).not.toBeInTheDocument());
    await expect(toolActionRuns).toHaveLength(1);
    await userEvent.click(section.getByRole("button", { name: "Run Reset parts" }));
    await userEvent.click(await page.findByRole("button", { name: "Run" }));
    // A tool that can write: the dialog reads the settings again, which remounts the section.
    await expect(within(dialog).findByText("cad.reset finished")).resolves.toBeInTheDocument();
    section = within(within(dialog).getByTestId("mcp-server-settings"));
    await expect(toolActionRuns[1]).toEqual({ toolName: "cad.reset", confirmed: true });

    // An unsaved edit blocks the runs: the tool would see the saved settings, not the draft.
    const zoom = section.getByLabelText("Default zoom setting");
    await userEvent.clear(zoom);
    await userEvent.type(zoom, "3");
    await waitFor(() =>
      expect(section.getByRole("button", { name: "Run Part library" })).toBeDisabled()
    );
    await userEvent.clear(zoom);
    await userEvent.type(zoom, "2");
    await waitFor(() =>
      expect(section.getByRole("button", { name: "Run Part library" })).toBeEnabled()
    );

    await expect(section.getByText("Not available")).toBeInTheDocument();
    await expect(section.queryByRole("button", { name: /cad\.export/ })).toBeNull();

    // The MCP App tool can write too: it opens only after the confirmation, in a modal.
    await userEvent.click(section.getByRole("button", { name: "Open Payment method" }));
    await userEvent.click(await page.findByRole("button", { name: "Run" }));
    const appDialog = await page.findByRole("dialog", { name: "Payment method" });
    await expect(toolActionRuns[2]).toEqual({ toolName: "cad.payment", confirmed: true });
    await waitFor(() => expect(appDialog.querySelector("iframe")).not.toBeNull());
    // The header names the server by the label the backend sent, not the bare key.
    await expect(within(appDialog).getByText("cad-plugin · cad")).toBeInTheDocument();
    // One Close control: the panel's own header (the dialog's corner button is hidden).
    await expect(within(appDialog).getAllByRole("button", { name: /close/i })).toHaveLength(1);
    // Escape closes the app modal and leaves the settings dialog open.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog", { name: "Payment method" })).toBeNull());
    await expect(within(dialog).getByTestId("mcp-server-settings")).toBeInTheDocument();
  },
};

/** CAD_SETTINGS with Part library (cad.library) no longer read-only. */
const CAD_SETTINGS_LIBRARY_WRITES: MCPSettingsSnapshot = {
  ...CAD_SETTINGS,
  layout: CAD_SETTINGS.layout.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.kind === "tool" && item.tool === "cad.library" && item.action
        ? { ...item, action: { ...item.action, readOnly: false } }
        : item
    ),
  })),
};

let staleFlagRuns: Array<{ toolName: string; confirmed: boolean }> = [];
/**
 * The server dropped Part library's readOnlyHint after the dialog read it (tools/list_changed).
 * The backend refuses the unconfirmed run, and the row shows that. The row learns the new flag,
 * so the next click asks first and runs the tool.
 */
export const WorkspaceMCPServerSettingsStaleReadOnlyFlag: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    staleFlagRuns = [];
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settings: { cad: CAD_SETTINGS_LIBRARY_WRITES },
      settingsStaleFirstRead: { cad: CAD_SETTINGS },
      settingsToolRuns: staleFlagRuns,
    });
  },
  play: async ({ canvasElement }) => {
    const dialog = await findWorkspaceMCPDialog(canvasElement);
    const section = within(await within(dialog).findByTestId("mcp-server-settings"));
    const page = within(canvasElement.ownerDocument.body);
    const run = await section.findByRole("button", { name: "Run Part library" });
    await userEvent.click(run);
    await expect(
      section.findByText("'Part library' runs only after a confirmation")
    ).resolves.toBeInTheDocument();
    await waitFor(() => expect(run).toBeEnabled());
    await expect(staleFlagRuns).toHaveLength(0);

    await userEvent.click(run);
    await expect(page.findByText("Run Part library?")).resolves.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Run" }));
    // The confirmed run can write, so the dialog reads the settings again (a new section).
    await expect(within(dialog).findByText("cad.library finished")).resolves.toBeInTheDocument();
    await expect(staleFlagRuns).toEqual([{ toolName: "cad.library", confirmed: true }]);
  },
};

let restartRuns: Array<{ toolName: string; confirmed: boolean }> = [];
/**
 * The server restarted after the dialog read it, and its new instance has Part library as
 * writable. The row does not take that flag: the run carries the old instance's token, so a
 * confirmation would only lead to a refused run.
 */
export const WorkspaceMCPServerSettingsStaleFlagOtherInstance: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    restartRuns = [];
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settings: { cad: CAD_SETTINGS_LIBRARY_WRITES },
      settingsStaleFirstRead: { cad: CAD_SETTINGS },
      settingsRestartAfterFirstRead: ["cad"],
      settingsToolRuns: restartRuns,
    });
  },
  play: async ({ canvasElement }) => {
    const dialog = await findWorkspaceMCPDialog(canvasElement);
    const section = within(await within(dialog).findByTestId("mcp-server-settings"));
    const page = within(canvasElement.ownerDocument.body);
    const run = await section.findByRole("button", { name: "Run Part library" });
    await userEvent.click(run);
    await expect(
      section.findByText("'Part library' runs only after a confirmation")
    ).resolves.toBeInTheDocument();
    await waitFor(() => expect(run).toBeEnabled());
    await userEvent.click(run);
    await waitFor(() => expect(run).toBeEnabled());
    await expect(page.queryByText("Run Part library?")).toBeNull();
    await expect(restartRuns).toHaveLength(0);
  },
};

/**
 * The backend checks the SAVED tool allowlist: while the dialog has an unsaved allowlist edit
 * for the server, its tool actions do not run.
 */
export const WorkspaceMCPServerSettingsUnsavedAllowlist: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      testResults: { cad: ["cad.library", "cad.reset", "cad.payment"] },
      preCacheTools: true,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const run = await section.findByRole("button", { name: "Run Part library" });
    await expect(run).toBeEnabled();
    await userEvent.click(modal.getByRole("checkbox", { name: "cad.library" }));
    await waitFor(() => expect(run).toBeDisabled());
    await expect(section.getByRole("button", { name: "Open Payment method" })).toBeDisabled();
    // Undoing the edit (the saved allowlist again) allows the runs.
    await userEvent.click(modal.getByRole("checkbox", { name: "cad.library" }));
    await waitFor(() => expect(run).toBeEnabled());
  },
};

let retryViewRuns: Array<{ toolName: string; confirmed: boolean }> = [];
let retryViews: Record<string, McpAppView> = {};
/**
 * The settings app modal's view read fails (a transient getView error): Reload mounts the
 * stored record again, without a second tool call.
 */
export const WorkspaceMCPServerSettingsAppViewRetry: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    retryViewRuns = [];
    retryViews = {};
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settingsToolRuns: retryViewRuns,
      mcpAppViews: retryViews,
    });
  },
  play: async ({ canvasElement }) => {
    const dialog = await findWorkspaceMCPDialog(canvasElement);
    const section = within(await within(dialog).findByTestId("mcp-server-settings"));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await section.findByRole("button", { name: "Open Payment method" }));
    await userEvent.click(await page.findByRole("button", { name: "Run" }));
    const appDialog = await page.findByRole("dialog", { name: "Payment method" });
    const reload = await within(appDialog).findByRole("button", { name: "Reload" });
    retryViews["settings:cad:cad.payment"] = {
      html: "<!doctype html><html><body><strong>Card form</strong></body></html>",
      csp: {},
      prefersBorder: null,
      resultAvailable: true,
      result: { content: [] },
      invocation: null,
    };
    await userEvent.click(reload);
    await waitFor(() => expect(appDialog.querySelector("iframe")).not.toBeNull());
    await expect(retryViewRuns).toHaveLength(1);
  },
};

const rereadReads: string[][] = [];

/** Shared play: a read-only run reads nothing; Reset parts (it writes zoom 1) reads again. */
async function exerciseRereadAfterWrite(canvasElement: HTMLElement, resetText: string) {
  const modal = within(await findWorkspaceMCPDialog(canvasElement));
  const section = within(await modal.findByTestId("mcp-server-settings"));
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await section.findByRole("button", { name: "Run Part library" }));
  await expect(section.findByText("cad.library finished")).resolves.toBeInTheDocument();
  await expect(rereadReads).toHaveLength(1);
  await userEvent.click(section.getByRole("button", { name: "Run Reset parts" }));
  await userEvent.click(await page.findByRole("button", { name: "Run" }));
  // The re-read remounts the section: query it again.
  await waitFor(() => expect(modal.getByLabelText("Default zoom setting")).toHaveValue(1));
  await expect(rereadReads).toEqual([["cad"], ["cad"]]);
  await expect(modal.findByText(resetText)).resolves.toBeInTheDocument();
}

/**
 * A tool that can write (Reset parts) changes the server's settings: the dialog reads them
 * again and shows the new values, and the run's result stays. It reads them even when the tool
 * reports an error (it can fail after it wrote). A read-only run reads nothing.
 */
export const WorkspaceMCPServerSettingsRereadAfterWrite: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    rereadReads.length = 0;
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settingsReads: rereadReads,
      settingsToolRunSets: { "cad.reset": { zoom: 1 } },
      settingsToolRunErrors: ["cad.reset"],
    });
  },
  play: async ({ canvasElement }) => exerciseRereadAfterWrite(canvasElement, "cad.reset finished"),
};

/** The run fails after the dispatch (a disconnect after the write): the dialog reads again. */
export const WorkspaceMCPServerSettingsRereadAfterFailedWrite: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    rereadReads.length = 0;
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settingsReads: rereadReads,
      settingsToolRunSets: { "cad.reset": { zoom: 1 } },
      settingsToolRunFailures: ["cad.reset"],
    });
  },
  play: async ({ canvasElement }) =>
    exerciseRereadAfterWrite(canvasElement, "cad.reset disconnected"),
};

const appWriteReads: string[][] = [];
/**
 * An MCP App of a tool that can write (Payment method) may change the settings: the dialog
 * reads them again when the app closes, not while it is open (that would close it).
 */
export const WorkspaceMCPServerSettingsRereadAfterApp: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    appWriteReads.length = 0;
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settingsReads: appWriteReads,
      settingsToolRunSets: { "cad.payment": { zoom: 1 } },
      mcpAppViews: {
        "settings:cad:cad.payment": {
          html: "<!doctype html><html><body><strong>Card form</strong></body></html>",
          csp: {},
          prefersBorder: null,
          resultAvailable: true,
          result: { content: [] },
          invocation: null,
        },
      },
    });
  },
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await section.findByRole("button", { name: "Open Payment method" }));
    await userEvent.click(await page.findByRole("button", { name: "Run" }));
    const appDialog = await page.findByRole("dialog", { name: "Payment method" });
    await waitFor(() => expect(appDialog.querySelector("iframe")).not.toBeNull());
    await expect(appWriteReads).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog", { name: "Payment method" })).toBeNull());
    await waitFor(() => expect(modal.getByLabelText("Default zoom setting")).toHaveValue(1));
    await expect(appWriteReads).toEqual([["cad"], ["cad"]]);
  },
};

/** The modal mounts only while open, like the sidebar row's settings dialog. */
const RemountingWorkspaceMCPModal: FC = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open workspace MCP
      </button>
      {open && (
        <WorkspaceMCPModal
          workspaceId={WORKSPACE_ID}
          projectPath={PROJECT_PATH}
          open
          onOpenChange={setOpen}
        />
      )}
    </>
  );
};

let remountRuns: Array<{ toolName: string; confirmed: boolean }> = [];
let remountGate = Promise.withResolvers<void>();
/**
 * A run still in flight when the dialog closes keeps blocking the runs, Refresh Tools and Save
 * of the reopened dialog until it ends.
 */
export const WorkspaceMCPServerSettingsRunAcrossRemount: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    remountRuns = [];
    remountGate = Promise.withResolvers<void>();
    return (
      <WorkspaceMCPModalStoryShell
        setup={() =>
          setupWorkspaceMCPModalStory({
            ...settingsStoryOptions(),
            settingsToolRuns: remountRuns,
            settingsToolRunGate: remountGate,
          })
        }
      >
        <RemountingWorkspaceMCPModal />
      </WorkspaceMCPModalStoryShell>
    );
  },
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    await userEvent.click(await section.findByRole("button", { name: "Run Part library" }));
    await waitFor(() => expect(remountRuns).toHaveLength(1));
    await userEvent.click(modal.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(queryWorkspaceMCPDialog(canvasElement.ownerDocument)).not.toBeInTheDocument()
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Open workspace MCP" })
    );
    const reopened = within(await findWorkspaceMCPDialog(canvasElement));
    const again = within(await reopened.findByTestId("mcp-server-settings"));
    await expect(again.findByRole("button", { name: "Run Reset parts" })).resolves.toBeDisabled();
    await expect(again.getByRole("button", { name: "Run Part library" })).toBeDisabled();
    await expect(reopened.getByRole("button", { name: /(Fetch|Refresh) Tools/ })).toBeDisabled();
    await expect(reopened.getByRole("button", { name: "Save" })).toBeDisabled();
    remountGate.resolve();
    await waitFor(() =>
      expect(again.getByRole("button", { name: "Run Reset parts" })).toBeEnabled()
    );
    await expect(reopened.getByRole("button", { name: "Save" })).toBeEnabled();
  },
};

let writeRemountGate = Promise.withResolvers<void>();
/**
 * A writing run (Reset parts) still in flight when the dialog closes: the reopened dialog reads
 * the pre-write values, and the run's end reads the settings again into that dialog.
 */
export const WorkspaceMCPServerSettingsRereadAfterRemount: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    writeRemountGate = Promise.withResolvers<void>();
    return (
      <WorkspaceMCPModalStoryShell
        setup={() =>
          setupWorkspaceMCPModalStory({
            ...settingsStoryOptions(),
            settingsToolRunGate: writeRemountGate,
            settingsToolRuns: [],
            settingsToolRunSets: { "cad.reset": { zoom: 1 } },
          })
        }
      >
        <RemountingWorkspaceMCPModal />
      </WorkspaceMCPModalStoryShell>
    );
  },
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await section.findByRole("button", { name: "Run Reset parts" }));
    await userEvent.click(await page.findByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(section.getByRole("button", { name: "Run Part library" })).toBeDisabled()
    );
    await userEvent.click(modal.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(queryWorkspaceMCPDialog(canvasElement.ownerDocument)).not.toBeInTheDocument()
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Open workspace MCP" })
    );
    const reopened = within(await findWorkspaceMCPDialog(canvasElement));
    await expect(reopened.findByLabelText("Default zoom setting")).resolves.toHaveValue(2);
    writeRemountGate.resolve();
    await waitFor(() => expect(reopened.getByLabelText("Default zoom setting")).toHaveValue(1));
  },
};

/** Not running yet: the dialog does not start it on open; Fetch Tools connects it. */
export const WorkspaceMCPServerSettingsNotConnected: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => renderWorkspaceMCPModal({ ...settingsStoryOptions(), settingsConnected: [] }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    await expect(
      modal.findByText("Connect the server to see its settings")
    ).resolves.toBeInTheDocument();
    await expect(modal.queryByTestId("mcp-server-settings")).toBeNull();
    await userEvent.click(modal.getByRole("button", { name: "Fetch Tools" }));
    await expect(modal.findByTestId("mcp-server-settings")).resolves.toBeInTheDocument();
    await expect(modal.queryByText("Connect the server to see its settings")).toBeNull();
  },
};

const settingsReads: string[][] = [];

/** Opening the dialog reads every enabled server's settings in ONE IPC call. */
export const WorkspaceMCPServerSettingsOneRead: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    settingsReads.length = 0;
    return renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      servers: {
        cad: { transport: "stdio", command: "bunx cad-mcp", disabled: false },
        lathe: { transport: "stdio", command: "bunx lathe-mcp", disabled: false },
      },
      settings: { cad: CAD_SETTINGS, lathe: CAD_SETTINGS },
      settingsConnected: ["cad", "lathe"],
      settingsReads,
    });
  },
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    await waitFor(() => expect(modal.getAllByTestId("mcp-server-settings")).toHaveLength(2));
    await expect(settingsReads).toEqual([["cad", "lathe"]]);
  },
};

/** A connected server whose settings read fails shows the error on open (not silence). */
export const WorkspaceMCPServerSettingsReadError: Story = {
  // Pixel snapshot budget: the error is a one-line note in the same style as the
  // "Connect the server" note other snapshots show; the play checks the text.
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settingsReadErrors: { cad: "settings read timed out" },
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    await expect(
      modal.findByText("Settings unavailable: settings read timed out")
    ).resolves.toBeInTheDocument();
  },
};

/** A gate a play opens by hand: holds a mock request in flight. */
function storyGate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

const saveGate = storyGate();

/** While a save is in flight the controls are locked, so no edit can be lost to its response. */
export const WorkspaceMCPServerSettingsSaveInFlight: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderWorkspaceMCPModal({ ...settingsStoryOptions(), settingsUpdateGate: saveGate }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const zoom = section.getByLabelText("Default zoom setting");
    await userEvent.clear(zoom);
    await userEvent.type(zoom, "3");
    await userEvent.click(section.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(zoom).toBeDisabled());
    await expect(section.getByLabelText("Show grid setting")).toBeDisabled();
    saveGate.open();
    // The saved snapshot replaces the section (a new mount), so query the controls again.
    await waitFor(() => expect(modal.getByLabelText("Default zoom setting")).toBeEnabled());
    await expect(modal.getByLabelText("Default zoom setting")).toHaveValue(3);
  },
};

/**
 * A server enabled only in this unsaved dialog: Fetch Tools shows its tools, but its settings
 * are not read (the backend's saved enablement would refuse the read as disabled).
 */
export const WorkspaceMCPServerSettingsUnsavedEnable: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      servers: { cad: { transport: "stdio", command: "bunx cad-mcp", disabled: true } },
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    await userEvent.click(await modal.findByRole("switch", { name: "Toggle cad MCP server" }));
    await userEvent.click(await modal.findByRole("button", { name: "Fetch Tools" }));
    await expect(modal.findByText("draw_part")).resolves.toBeInTheDocument();
    await expect(modal.queryByTestId("mcp-server-settings")).toBeNull();
  },
};

/**
 * The modal behind an open button: Cancel really closes it, so a play can
 * reopen it. A second button changes a value on the server while the dialog is
 * closed (another client, a hook), so a reopen must read again.
 */
const ReopenableWorkspaceMCPModal: FC = () => {
  const [open, setOpen] = useState(true);
  const { api } = useAPI();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open workspace MCP
      </button>
      <button
        type="button"
        onClick={() =>
          void api?.mcp.settings.update({
            workspaceId: WORKSPACE_ID,
            serverName: "cad",
            set: { zoom: 4 },
            instanceToken: "mock-instance:cad",
          })
        }
      >
        Change zoom on the server
      </button>
      <WorkspaceMCPModal
        workspaceId={WORKSPACE_ID}
        projectPath={PROJECT_PATH}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
};

const lateFetchGate = storyGate();
const lateFetchReads: string[][] = [];

/**
 * A Fetch Tools still running when the dialog closes and reopens must not read settings into
 * the new dialog (its generation is stale): only the reopen's own read happens.
 */
export const WorkspaceMCPServerSettingsLateFetch: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    lateFetchReads.length = 0;
    return (
      <WorkspaceMCPModalStoryShell
        setup={() =>
          setupWorkspaceMCPModalStory({
            ...settingsStoryOptions(),
            testGate: lateFetchGate,
            settingsReads: lateFetchReads,
          })
        }
      >
        <ReopenableWorkspaceMCPModal />
      </WorkspaceMCPModalStoryShell>
    );
  },
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    await modal.findByTestId("mcp-server-settings");
    await userEvent.click(modal.getByRole("button", { name: "Fetch Tools" }));
    await userEvent.click(modal.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(queryWorkspaceMCPDialog(canvasElement.ownerDocument)).not.toBeInTheDocument()
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Open workspace MCP" })
    );
    await within(await findWorkspaceMCPDialog(canvasElement)).findByTestId("mcp-server-settings");
    await waitFor(() => expect(lateFetchReads).toHaveLength(2));
    // The late Fetch Tools still runs (the component stayed mounted); its end clears the
    // spinner, after its settings step, which must not read again.
    const reopened = within(await findWorkspaceMCPDialog(canvasElement));
    await expect(reopened.queryByRole("button", { name: /(Fetch|Refresh) Tools/ })).toBeNull();
    lateFetchGate.open();
    await expect(reopened.findByRole("button", { name: "Refresh Tools" })).resolves.toBeEnabled();
    await expect(lateFetchReads).toHaveLength(2);
  },
};

const slowFirstReadGate = storyGate();
const slowFirstReads: string[][] = [];

/**
 * The open's read is slow; meanwhile the server's zoom changes and Fetch Tools reads cad
 * again. When the slow read lands (lathe's section appears), cad keeps the newer read.
 */
export const WorkspaceMCPServerSettingsSlowFirstRead: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => {
    slowFirstReads.length = 0;
    return (
      <WorkspaceMCPModalStoryShell
        setup={() =>
          setupWorkspaceMCPModalStory({
            ...settingsStoryOptions(),
            settingsReads: slowFirstReads,
            servers: {
              cad: { transport: "stdio", command: "bunx cad-mcp", disabled: false },
              lathe: { transport: "stdio", command: "bunx lathe-mcp", disabled: false },
            },
            settings: { cad: CAD_SETTINGS, lathe: CAD_SETTINGS },
            settingsConnected: ["cad", "lathe"],
            settingsFirstReadGate: slowFirstReadGate,
          })
        }
      >
        <ReopenableWorkspaceMCPModal />
      </WorkspaceMCPModalStoryShell>
    );
  },
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    // The open's read has taken its values (zoom 2) before the server's zoom changes.
    await waitFor(() => expect(slowFirstReads).toHaveLength(1));
    // The open modal hides the page from userEvent (aria-hidden, no pointer events).
    await fireEvent.click(
      within(canvasElement).getByRole("button", { name: "Change zoom on the server", hidden: true })
    );
    await userEvent.click((await modal.findAllByRole("button", { name: "Fetch Tools" }))[0]);
    const cad = within(await modal.findByTestId("mcp-server-settings"));
    await expect(cad.getByLabelText("Default zoom setting")).toHaveValue(4);
    slowFirstReadGate.open();
    await waitFor(() => expect(modal.getAllByTestId("mcp-server-settings")).toHaveLength(2));
    const [cadAfter] = modal.getAllByTestId("mcp-server-settings");
    await expect(within(cadAfter).getByLabelText("Default zoom setting")).toHaveValue(4);
  },
};

/**
 * The dialog's Save does not include unsaved settings: with a settings edit pending it stays
 * open and says so, instead of closing and dropping the edit. Once saved, Save closes it.
 */
export const WorkspaceMCPServerSettingsUnsavedOnSave: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <WorkspaceMCPModalStoryShell setup={() => setupWorkspaceMCPModalStory(settingsStoryOptions())}>
      <ReopenableWorkspaceMCPModal />
    </WorkspaceMCPModalStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const zoom = section.getByLabelText("Default zoom setting");
    await userEvent.clear(zoom);
    await userEvent.type(zoom, "3");
    await userEvent.click(modal.getByRole("button", { name: "Save" }));
    await expect(modal.findByText(/Unsaved settings for cad/)).resolves.toBeInTheDocument();
    await expect(queryWorkspaceMCPDialog(canvasElement.ownerDocument)).toBeInTheDocument();
    await expect(zoom).toHaveValue(3);

    const saveSettings = section.getByRole("button", { name: "Save settings" });
    await userEvent.click(saveSettings);
    await waitFor(() => expect(saveSettings).toBeDisabled());
    await userEvent.click(modal.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(queryWorkspaceMCPDialog(canvasElement.ownerDocument)).not.toBeInTheDocument()
    );
  },
};

/**
 * Switching a server off keeps its settings draft: switched back on, the edit is still there,
 * and while it is off the dialog's Save still says the edit is unsaved.
 */
export const WorkspaceMCPServerSettingsDraftAcrossToggle: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => renderWorkspaceMCPModal(settingsStoryOptions()),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const zoom = section.getByLabelText("Default zoom setting");
    await userEvent.clear(zoom);
    await userEvent.type(zoom, "3");
    const toggle = modal.getByRole("switch", { name: "Toggle cad MCP server" });
    await userEvent.click(toggle);
    await waitFor(() => expect(section.getByLabelText("Default zoom setting")).not.toBeVisible());
    await userEvent.click(modal.getByRole("button", { name: "Save" }));
    await expect(modal.findByText(/Unsaved settings for cad/)).resolves.toBeInTheDocument();
    await userEvent.click(toggle);
    const shown = within(await modal.findByTestId("mcp-server-settings"));
    await expect(shown.getByLabelText("Default zoom setting")).toHaveValue(3);
  },
};

const refreshDuringSaveGate = storyGate();

/**
 * Refresh Tools reads settings too. While a save is in flight that read could show the
 * pre-save values and drop the save's result, so Refresh Tools waits for the save.
 */
export const WorkspaceMCPServerSettingsRefreshDuringSave: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settingsUpdateGate: refreshDuringSaveGate,
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    await userEvent.click(await modal.findByRole("button", { name: "Fetch Tools" }));
    const refresh = await modal.findByRole("button", { name: "Refresh Tools" });
    await waitFor(() => expect(refresh).toBeEnabled());
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const zoom = section.getByLabelText("Default zoom setting");
    await userEvent.clear(zoom);
    await userEvent.type(zoom, "3");
    await userEvent.click(section.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(zoom).toBeDisabled());
    await expect(refresh).toBeDisabled();
    refreshDuringSaveGate.open();
    await waitFor(() => expect(refresh).toBeEnabled());
    await expect(modal.getByLabelText("Default zoom setting")).toHaveValue(3);
  },
};

const saveDuringRefreshGate = storyGate();

/** The reverse order: while Refresh Tools runs (its settings read follows), Save settings waits. */
export const WorkspaceMCPServerSettingsSaveDuringRefresh: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderWorkspaceMCPModal({ ...settingsStoryOptions(), testGate: saveDuringRefreshGate }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    const zoom = section.getByLabelText("Default zoom setting");
    await userEvent.clear(zoom);
    await userEvent.type(zoom, "3");
    const save = section.getByRole("button", { name: "Save settings" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(modal.getByRole("button", { name: "Fetch Tools" }));
    await waitFor(() => expect(save).toBeDisabled());
    saveDuringRefreshGate.open();
    await expect(modal.findByRole("button", { name: "Refresh Tools" })).resolves.toBeEnabled();
  },
};

const overlapFirstSave = storyGate();
const overlapSecondSave = storyGate();

/**
 * A save started after a close and reopen overlaps one from before it: Refresh Tools stays
 * disabled until both settle, not only the first.
 */
export const WorkspaceMCPServerSettingsOverlappingSaves: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <WorkspaceMCPModalStoryShell
      setup={() =>
        setupWorkspaceMCPModalStory({
          ...settingsStoryOptions(),
          settingsUpdateGate: [overlapFirstSave, overlapSecondSave],
        })
      }
    >
      <ReopenableWorkspaceMCPModal />
    </WorkspaceMCPModalStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const saveZoom = async (zoom: string) => {
      const section = within(
        await within(await findWorkspaceMCPDialog(canvasElement)).findByTestId(
          "mcp-server-settings"
        )
      );
      const input = section.getByLabelText("Default zoom setting");
      await userEvent.clear(input);
      await userEvent.type(input, zoom);
      await userEvent.click(section.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(input).toBeDisabled());
    };
    await saveZoom("3");
    await userEvent.click(
      within(await findWorkspaceMCPDialog(canvasElement)).getByRole("button", { name: "Cancel" })
    );
    await waitFor(() =>
      expect(queryWorkspaceMCPDialog(canvasElement.ownerDocument)).not.toBeInTheDocument()
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Open workspace MCP" })
    );
    await saveZoom("4");
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const fetchTools = modal.getByRole("button", { name: "Fetch Tools" });
    await expect(fetchTools).toBeDisabled();
    overlapFirstSave.open();
    await overlapFirstSave.promise;
    // The first save's result reaches the dialog in microtasks, and React commits its state
    // update before the next frame paints. Two frames: the settle and its commit.
    for (let frame = 0; frame < 2; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    await expect(fetchTools).toBeDisabled();
    overlapSecondSave.open();
    await waitFor(() => expect(fetchTools).toBeEnabled());
  },
};

/** The server shows "Snap to grid" only once the grid is on: the dialog shows it after Save. */
export const WorkspaceMCPServerSettingsSchemaAfterSave: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderWorkspaceMCPModal({
      ...settingsStoryOptions(),
      settings: { cad: { ...CAD_SETTINGS, values: { ...CAD_SETTINGS.values, grid: false } } },
      settingsAfterSave: {
        cad: {
          ...CAD_SETTINGS,
          properties: {
            ...CAD_SETTINGS.properties,
            snap: { type: "boolean", title: "Snap to grid" },
          },
          values: { ...CAD_SETTINGS.values, snap: false },
          layout: [
            ...CAD_SETTINGS.layout,
            { title: "Snapping", items: [{ kind: "property", property: "snap" }] },
          ],
        },
      },
    }),
  play: async ({ canvasElement }) => {
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const section = within(await modal.findByTestId("mcp-server-settings"));
    await expect(section.queryByLabelText("Snap to grid setting")).toBeNull();
    await userEvent.click(section.getByLabelText("Show grid setting"));
    await userEvent.click(section.getByRole("button", { name: "Save settings" }));
    const saved = within(await modal.findByTestId("mcp-server-settings"));
    await expect(saved.findByLabelText("Snap to grid setting")).resolves.toBeInTheDocument();
    await expect(saved.getByLabelText("Show grid setting")).toBeChecked();
    await expect(saved.getByRole("button", { name: "Save settings" })).toBeDisabled();
  },
};

/** Pick `option` in a Radix select (its list renders in a portal). */
async function chooseSetting(
  canvasElement: HTMLElement,
  select: HTMLElement,
  option: string
): Promise<void> {
  await userEvent.click(select);
  const body = within(canvasElement.ownerDocument.body);
  await userEvent.click(await body.findByRole("option", { name: option }));
}

async function saveUnits(canvasElement: HTMLElement, units: string) {
  const section = within(
    await within(await findWorkspaceMCPDialog(canvasElement)).findByTestId("mcp-server-settings")
  );
  await chooseSetting(canvasElement, section.getByLabelText("Units setting"), units);
  const save = section.getByRole("button", { name: "Save settings" });
  await waitFor(() => expect(save).toBeEnabled());
  await userEvent.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  return { section, save };
}

/**
 * Save, close and reopen: the reopened form shows the saved value and a value
 * changed elsewhere meanwhile, with no Refresh Tools.
 */
export const WorkspaceMCPServerSettingsReopen: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <WorkspaceMCPModalStoryShell setup={() => setupWorkspaceMCPModalStory(settingsStoryOptions())}>
      <ReopenableWorkspaceMCPModal />
    </WorkspaceMCPModalStoryShell>
  ),
  play: async ({ canvasElement }) => {
    await saveUnits(canvasElement, "in");
    const dialog = await findWorkspaceMCPDialog(canvasElement);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(queryWorkspaceMCPDialog(canvasElement.ownerDocument)).not.toBeInTheDocument()
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Change zoom on the server" })
    );

    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Open workspace MCP" })
    );
    const section = within(
      await within(await findWorkspaceMCPDialog(canvasElement)).findByTestId("mcp-server-settings")
    );
    await waitFor(() => expect(section.getByLabelText("Units setting")).toHaveTextContent("in"));
    await expect(section.getByLabelText("Default zoom setting")).toHaveValue(4);
  },
};

/**
 * After a save, the saved value is the form's base: choosing the previous value
 * again is a change, also after the server is toggled off and on.
 */
export const WorkspaceMCPServerSettingsOldValueAgain: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => renderWorkspaceMCPModal(settingsStoryOptions()),
  play: async ({ canvasElement }) => {
    await saveUnits(canvasElement, "in");
    const modal = within(await findWorkspaceMCPDialog(canvasElement));
    const toggle = modal.getByRole("switch", { name: "Toggle cad MCP server" });
    await userEvent.click(toggle);
    await waitFor(() => expect(modal.getByTestId("mcp-server-settings")).not.toBeVisible());
    await userEvent.click(toggle);

    const section = within(await modal.findByTestId("mcp-server-settings"));
    await waitFor(() => expect(section.getByLabelText("Units setting")).toBeVisible());
    await expect(section.getByLabelText("Units setting")).toHaveTextContent("in");
    await chooseSetting(canvasElement, section.getByLabelText("Units setting"), "mm");
    await waitFor(() =>
      expect(section.getByRole("button", { name: "Save settings" })).toBeEnabled()
    );
  },
};
