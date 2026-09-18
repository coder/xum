import "./dom";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shouldRunIntegrationTests } from "../testUtils";
import { preloadTestModules } from "../ipc/setup";
import { createAppHarness, type AppHarness } from "./harness";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/manifest";
import { AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/mcpConfig";
import type { MCPTestResult } from "@/common/types/mcp";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const PLUGIN = "docs-plugin";
const PLUGIN_SERVER = "docs";
/** Settings labels plugin rows `<plugin>/<server>`; the map key is an opaque instance key. */
const PLUGIN_LABEL = `${PLUGIN}/${PLUGIN_SERVER}`;
const REGULAR = "local-docs";
const LONG_TOOL = "fetch_page_property_item_with_pagination_and_rich_text_expansion_v2";
const PLUGIN_TOOLS = ["search_docs", LONG_TOOL, "read_doc"];
const REGULAR_TOOLS = ["search", "read"];

type Canvas = ReturnType<typeof within>;

/**
 * The Settings card for one configured server: the header grid (switch, name,
 * actions) plus its sibling error/tools sections below it.
 */
function serverRow(canvas: Canvas, label: string): HTMLElement {
  let header: HTMLElement | null = canvas.getByRole("switch", { name: `Toggle ${label} enabled` });
  while (header && !within(header).queryByRole("button", { name: "Test connection" })) {
    header = header.parentElement;
  }
  const card = header?.parentElement;
  if (!card) throw new Error(`Settings row for ${label} not found`);
  return card;
}

async function openMcpSettings(app: AppHarness) {
  const canvas = within(app.view.container);
  fireEvent.click(await canvas.findByTestId("settings-button"));
  fireEvent.click((await canvas.findAllByRole("button", { name: "MCP" }))[0]);
  await canvas.findByRole("switch", { name: `Toggle ${PLUGIN_LABEL} enabled` }, { timeout: 10000 });
  await canvas.findByRole("switch", { name: `Toggle ${REGULAR} enabled` });
  return canvas;
}

function testConnection(canvas: Canvas, label: string) {
  fireEvent.click(
    within(serverRow(canvas, label)).getByRole("button", { name: "Test connection" })
  );
}

/** The expandable tools header inside a row, if any (`Tools: 3` / `Tools: 2/2`). */
function toolsToggle(row: HTMLElement): HTMLElement | null {
  return within(row).queryByRole("button", { name: /^Tools:/ });
}

async function waitForTestToSettle(canvas: Canvas, label: string) {
  await waitFor(() => {
    const button = within(serverRow(canvas, label)).getByRole<HTMLButtonElement>("button", {
      name: "Test connection",
    });
    if (button.disabled) throw new Error("Test is still running");
  });
}

// Full AppLoader + real IPC. The plugin is a real global Agent Plugin directory
// discovered by the backend; only the MCP connection test itself is injected so
// no server process is launched.
describeIntegration("MCP settings plugin tool inspection", () => {
  let app: AppHarness;
  let testSpy: jest.SpyInstance;
  let allowlistSpy: jest.SpyInstance;
  beforeAll(preloadTestModules);
  beforeEach(async () => {
    app = await createAppHarness({
      aiMode: "none",
      branchPrefix: "mcp-plugin-tools",
      beforeRenderEnvironment: async (env) => {
        await env.orpc.experiments.setOverride({
          experimentId: EXPERIMENT_IDS.AGENT_PLUGINS,
          enabled: true,
        });
        const pluginDir = path.join(env.config.rootDir, "plugins", PLUGIN);
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "plugin.json"),
          JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: PLUGIN })
        );
        await fs.writeFile(
          path.join(pluginDir, "mcp.json"),
          JSON.stringify({
            $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
            mcpServers: {
              [PLUGIN_SERVER]: { type: "stdio", command: "bun", args: ["run", "docs-server.ts"] },
            },
          })
        );
        const added = await env.orpc.mcp.add({
          name: REGULAR,
          transport: "stdio",
          command: "bun run docs-server.ts",
        });
        if (!added.success) throw new Error(added.error);
      },
    });
    testSpy = jest
      .spyOn(app.env.services.mcpServerManager, "testForApi")
      .mockImplementation((input): Promise<MCPTestResult> => {
        const tools = input.name?.startsWith("plugin:") ? PLUGIN_TOOLS : REGULAR_TOOLS;
        return Promise.resolve({ success: true, tools });
      });
    // Real implementation keeps running; the spy only records writes.
    allowlistSpy = jest.spyOn(app.env.services.mcpConfigService, "setToolAllowlistForApi");
  }, 120000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.dispose();
  });

  test("a tested plugin server lists its discovered tools read-only", async () => {
    const canvas = await openMcpSettings(app);
    const row = () => serverRow(canvas, PLUGIN_LABEL);
    expect(toolsToggle(row())).toBeNull();

    testConnection(canvas, PLUGIN_LABEL);
    const toggle = await within(row()).findByRole("button", { name: /^Tools: 3\b/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(row()).queryByText(LONG_TOOL)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    for (const tool of PLUGIN_TOOLS) expect(within(row()).getByText(tool)).toBeTruthy();
    // Read-only: no per-tool permission controls and no All/None actions.
    expect(within(row()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(row()).queryByRole("button", { name: "All" })).toBeNull();
    expect(within(row()).queryByRole("button", { name: "None" })).toBeNull();

    // Keyboard expand/collapse on the focused header.
    const user = userEvent.setup({ document: app.view.container.ownerDocument });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(row()).queryByText(LONG_TOOL)).toBeNull();
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(row()).getByText(LONG_TOOL)).toBeTruthy();

    // Enabling the plugin server (global consent) keeps working; the discovered
    // count badge appears, the open list stays, and no allowlist is written.
    fireEvent.click(canvas.getByRole("switch", { name: `Toggle ${PLUGIN_LABEL} enabled` }));
    await within(row()).findByText("3 tools");
    expect(within(row()).getByText(LONG_TOOL)).toBeTruthy();
    expect(within(row()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(allowlistSpy).not.toHaveBeenCalled();
  }, 60000);

  test("regular servers keep their editable allowlist", async () => {
    const canvas = await openMcpSettings(app);
    const row = () => serverRow(canvas, REGULAR);
    const user = userEvent.setup({ document: app.view.container.ownerDocument });

    testConnection(canvas, REGULAR);
    fireEvent.click(await within(row()).findByRole("button", { name: /^Tools: 2\/2\b/ }));
    expect(within(row()).getAllByRole("checkbox")).toHaveLength(2);

    // Controls are disabled while a save is in flight, so wait for each
    // control to become clickable and for the write to reach the backend.
    const edit = async (
      role: "checkbox" | "button",
      name: string,
      expected: string[],
      header: RegExp
    ) => {
      const control = () => within(row()).getByRole<HTMLButtonElement>(role, { name });
      await waitFor(() => {
        if (control().disabled) throw new Error("Previous save in flight");
      });
      await user.click(control());
      await within(row()).findByRole("button", { name: header });
      await waitFor(() => expect(allowlistSpy).toHaveBeenLastCalledWith(REGULAR, expected));
    };
    await edit("checkbox", "read", ["search"], /^Tools: 1\/2\b/);
    await edit("button", "None", [], /^Tools: 0\/2\b/);
    await edit("button", "All", REGULAR_TOOLS, /^Tools: 2\/2\b/);
    // The plugin row is untouched by regular-server edits.
    expect(toolsToggle(serverRow(canvas, PLUGIN_LABEL))).toBeNull();
  }, 60000);

  test.each([
    ["empty", { success: true, tools: [] } satisfies MCPTestResult],
    ["failed", { success: false, error: "spawn failed" } satisfies MCPTestResult],
  ])(
    "%s discovery shows no tool list for a plugin server",
    async (_label, result) => {
      const canvas = await openMcpSettings(app);
      testSpy.mockResolvedValueOnce(result);
      testConnection(canvas, PLUGIN_LABEL);
      await waitForTestToSettle(canvas, PLUGIN_LABEL);
      if (!result.success) {
        expect(within(serverRow(canvas, PLUGIN_LABEL)).getByText(result.error)).toBeTruthy();
      }
      expect(toolsToggle(serverRow(canvas, PLUGIN_LABEL))).toBeNull();
      expect(within(serverRow(canvas, PLUGIN_LABEL)).queryAllByRole("checkbox")).toHaveLength(0);
      expect(allowlistSpy).not.toHaveBeenCalled();
    },
    60000
  );
});
