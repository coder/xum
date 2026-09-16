import "./dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shouldRunIntegrationTests } from "../testUtils";
import { preloadTestModules } from "../ipc/setup";
import { createAppHarness, type AppHarness } from "./harness";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import type { CachedMCPTestResult, MCPTestResult } from "@/common/types/mcp";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const SERVER = "notion-work";
const INFO_BUTTON = `Server information: ${SERVER}`;
const BRANDED: MCPTestResult = {
  success: true,
  tools: ["notion_ai_search", "notion_fetch"],
  serverInfo: {
    name: "Notion MCP",
    version: "1.2.0",
    description: "Search your workspace, fetch specs and PRDs.",
    websiteUrl: "https://developers.notion.com/docs/mcp",
  },
};

type Canvas = ReturnType<typeof within>;

/** The Settings row card for one configured server (contains its switch and actions). */
function serverRow(canvas: Canvas, name: string): HTMLElement {
  let element: HTMLElement | null = canvas.getByRole("switch", { name: `Toggle ${name} enabled` });
  while (element && !within(element).queryByRole("button", { name: "Test connection" })) {
    element = element.parentElement;
  }
  if (!element) throw new Error(`Settings row for ${name} not found`);
  return element;
}

async function openMcpSettings(app: AppHarness) {
  const canvas = within(app.view.container);
  fireEvent.click(await canvas.findByTestId("settings-button"));
  fireEvent.click((await canvas.findAllByRole("button", { name: "MCP" }))[0]);
  await canvas.findByRole("switch", { name: `Toggle ${SERVER} enabled` }, { timeout: 10000 });
  return canvas;
}

async function testConnection(canvas: Canvas, name: string) {
  fireEvent.click(within(serverRow(canvas, name)).getByRole("button", { name: "Test connection" }));
}

async function expectBadge(canvas: Canvas, name: string, present: boolean) {
  await waitFor(() => {
    const badge = within(serverRow(canvas, name)).queryByRole("button", {
      name: `Server information: ${name}`,
    });
    if (present && !badge) throw new Error(`Badge for ${name} not shown`);
    if (!present && badge) throw new Error(`Badge for ${name} still shown`);
  });
}

async function addStdioServer(app: AppHarness, canvas: Canvas, name: string) {
  const user = userEvent.setup({ document: app.view.container.ownerDocument });
  fireEvent.click(canvas.getByText("Add server"));
  await user.type(canvas.getByLabelText("Name"), name);
  await user.type(canvas.getByLabelText("Command"), "bun run docs-server.ts");
  await user.click(canvas.getByRole("button", { name: "Add" }));
  await canvas.findByRole("switch", { name: `Toggle ${name} enabled` });
}

function persistedCache(): Record<string, CachedMCPTestResult> {
  return readPersistedState<Record<string, CachedMCPTestResult>>(
    getMCPTestResultsKey("__global__"),
    {}
  );
}

// Full AppLoader + real IPC. Only the MCP connection test is injected: identity
// capture from a live server is the backend's slice; the UI contract under test
// is what happens to a returned serverInfo across configuration loads.
describeIntegration("MCP settings server identity", () => {
  let app: AppHarness;
  let testSpy: jest.SpyInstance;
  beforeAll(preloadTestModules);
  beforeEach(async () => {
    app = await createAppHarness({
      aiMode: "none",
      branchPrefix: "mcp-identity",
      beforeRenderEnvironment: async (env) => {
        const added = await env.orpc.mcp.add({
          name: SERVER,
          transport: "http",
          url: "https://mcp.notion.com/mcp",
        });
        if (!added.success) throw new Error(added.error);
      },
    });
    testSpy = jest
      .spyOn(app.env.services.mcpServerManager, "testForApi")
      .mockResolvedValue(BRANDED);
  }, 120000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.dispose();
  });

  test("branding appears after a test, is never persisted, and hides on reload, edit and remove", async () => {
    const canvas = await openMcpSettings(app);
    expect(canvas.queryByRole("button", { name: INFO_BUTTON })).toBeNull();

    await testConnection(canvas, SERVER);
    await expectBadge(canvas, SERVER, true);
    const row = serverRow(canvas, SERVER);
    expect(within(row).getByText("2 tools")).toBeTruthy();
    // Configured label stays the primary identifier.
    expect(within(row).getByText(SERVER, { exact: true })).toBeTruthy();

    // The localStorage cache keeps tools/testedAt exactly as before and no identity.
    const cached = persistedCache()[SERVER];
    expect(cached.result).toEqual({ success: true, tools: BRANDED.tools });
    expect(typeof cached.testedAt).toBe("number");

    // Popover: display name, version, configured connection, website and disclaimer.
    fireEvent.click(within(row).getByRole("button", { name: INFO_BUTTON }));
    const popover = await within(document.body).findByRole("dialog", { name: `About ${SERVER}` });
    expect(within(popover).getByText("Notion MCP")).toBeTruthy();
    expect(within(popover).getByText("v1.2.0")).toBeTruthy();
    expect(within(popover).getByText(SERVER, { exact: true })).toBeTruthy();
    expect(within(popover).getByText("http · https://mcp.notion.com")).toBeTruthy();
    expect(
      within(popover)
        .getByRole("link", { name: /Website/ })
        .getAttribute("href")
    ).toBe("https://developers.notion.com/docs/mcp");
    expect(
      within(popover).getByText("Server-provided display information. Not a verified identity.")
    ).toBeTruthy();
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => {
      if (within(document.body).queryByRole("dialog", { name: `About ${SERVER}` }))
        throw new Error("Popover still open");
    });

    // A configuration reload (adding another server) hides branding but keeps the count.
    await addStdioServer(app, canvas, "local-docs");
    await expectBadge(canvas, SERVER, false);
    expect(within(serverRow(canvas, SERVER)).getByText("2 tools")).toBeTruthy();
    expect(
      within(serverRow(canvas, "local-docs")).queryByRole("button", { name: /Server information/ })
    ).toBeNull();

    // Re-testing in the new load brings it back.
    await testConnection(canvas, SERVER);
    await expectBadge(canvas, SERVER, true);

    // Leaving and re-entering the section restores the cached count only.
    fireEvent.click(canvas.getAllByRole("button", { name: "General" })[0]);
    await waitFor(() => {
      if (canvas.queryByRole("switch", { name: `Toggle ${SERVER} enabled` }))
        throw new Error("MCP section still shown");
    });
    fireEvent.click(canvas.getAllByRole("button", { name: "MCP" })[0]);
    await canvas.findByRole("switch", { name: `Toggle ${SERVER} enabled` });
    expect(within(serverRow(canvas, SERVER)).getByText("2 tools")).toBeTruthy();
    await expectBadge(canvas, SERVER, false);

    // Edit + save clears the cached result (existing behavior) and the branding.
    await testConnection(canvas, SERVER);
    await expectBadge(canvas, SERVER, true);
    fireEvent.click(within(serverRow(canvas, SERVER)).getByRole("button", { name: "Edit server" }));
    const input = within(serverRow(canvas, SERVER)).getByDisplayValue("https://mcp.notion.com/mcp");
    fireEvent.change(input, { target: { value: "https://mcp.notion.com/v2/mcp" } });
    fireEvent.click(within(serverRow(canvas, SERVER)).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      if (!within(serverRow(canvas, SERVER)).queryByText("https://mcp.notion.com/v2/mcp"))
        throw new Error("Edit not saved yet");
    });
    await expectBadge(canvas, SERVER, false);
    expect(within(serverRow(canvas, SERVER)).queryByText("2 tools")).toBeNull();

    await testConnection(canvas, SERVER);
    await expectBadge(canvas, SERVER, true);
    fireEvent.click(
      within(serverRow(canvas, SERVER)).getByRole("button", { name: "Remove server" })
    );
    // The list is replaced by a loading indicator during the remove; wait for the reload.
    await waitFor(() => {
      if (canvas.queryByText("Loading servers…")) throw new Error("Still loading");
      if (canvas.queryByRole("switch", { name: `Toggle ${SERVER} enabled` }))
        throw new Error("Row still present");
    });
    expect(canvas.getByRole("switch", { name: "Toggle local-docs enabled" })).toBeTruthy();
    expect(canvas.queryByRole("button", { name: INFO_BUTTON })).toBeNull();
    expect(persistedCache()[SERVER]).toBeUndefined();
  }, 60000);

  test("a test completion from a previous configuration load is cached but not branded", async () => {
    const canvas = await openMcpSettings(app);
    let release: (() => void) | undefined;
    testSpy.mockImplementationOnce(
      () =>
        new Promise<MCPTestResult>((resolve) => {
          release = () => resolve(BRANDED);
        })
    );
    await testConnection(canvas, SERVER);
    await waitFor(() => {
      if (!release) throw new Error("Test not started");
    });

    // Reload while the test is still in flight.
    await addStdioServer(app, canvas, "local-docs");
    release!();

    await waitFor(() => {
      if (!within(serverRow(canvas, SERVER)).queryByText("2 tools"))
        throw new Error("Cached tool count not shown yet");
    });
    expect(persistedCache()[SERVER].result).toEqual({ success: true, tools: BRANDED.tools });
    await expectBadge(canvas, SERVER, false);

    // The next test in the current load is branded.
    await testConnection(canvas, SERVER);
    await expectBadge(canvas, SERVER, true);
  }, 60000);
});
