import "./dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { BoundFunctions, queries } from "@testing-library/react";
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
// Actual one-pixel PNG: the host-decoded icon shape the renderer accepts.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOcAAAAASUVORK5CYII=";
const BRANDED: MCPTestResult = {
  success: true,
  tools: ["notion_ai_search", "notion_fetch"],
  icon: PNG,
  serverInfo: {
    name: "Notion MCP",
    version: "1.2.0",
    description: "Search your workspace, fetch specs and PRDs.",
    websiteUrl: "https://developers.notion.com/docs/mcp",
  },
};

type Canvas = BoundFunctions<typeof queries>;

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
    // The host-decoded PNG renders as a decorative image inside the badge trigger.
    const badge = within(row).getByRole("button", { name: INFO_BUTTON });
    const icon = badge.querySelector("img");
    if (!icon) throw new Error("PNG icon not rendered");
    expect(icon.getAttribute("src")).toBe(PNG);
    expect(icon.getAttribute("alt")).toBe("");

    // The localStorage cache keeps tools/testedAt exactly as before: no identity, no icon.
    const cached = persistedCache()[SERVER];
    expect(cached.result).toEqual({ success: true, tools: BRANDED.tools });
    expect(typeof cached.testedAt).toBe("number");

    // Popover: icon, display name, version, configured connection, website and disclaimer.
    fireEvent.click(badge);
    const popover = await within(document.body).findByRole("dialog", { name: `About ${SERVER}` });
    expect(popover.querySelector("img")?.getAttribute("src")).toBe(PNG);
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

    // An icon the renderer cannot decode falls back to the generic icon; identity stays.
    fireEvent.error(icon);
    await waitFor(() => {
      if (badge.querySelector("img")) throw new Error("Broken icon still rendered");
    });
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(within(row).getByRole("button", { name: INFO_BUTTON })).toBe(badge);

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

  test.each(["Settings", "workspace modal"] as const)(
    "%s discards branding when a newer test is unbranded or fails",
    async (surface) => {
      const canvas =
        surface === "Settings"
          ? await openMcpSettings(app)
          : (() => {
              fireEvent.keyDown(window, { key: "m", ctrlKey: true, shiftKey: true });
              return within(document.body);
            })();
      if (surface === "workspace modal") {
        await canvas.findByRole("dialog", { name: "Workspace MCP Configuration" });
        await canvas.findByRole("switch", { name: `Toggle ${SERVER} MCP server` });
      }
      const row = () => {
        if (surface === "Settings") return serverRow(canvas, SERVER);
        const toggle = canvas.getByRole("switch", { name: `Toggle ${SERVER} MCP server` });
        const card = toggle.closest(".p-4");
        if (!(card instanceof HTMLElement)) throw new Error("MCP modal row not found");
        return card;
      };
      const testButton = () =>
        within(row()).getByRole<HTMLButtonElement>("button", {
          name: surface === "Settings" ? "Test connection" : /^(Fetch|Refresh) Tools$/,
        });
      const expectBranding = async (present: boolean) => {
        await waitFor(() => {
          if (testButton().disabled) throw new Error("Test is still running");
          expect(within(row()).queryByRole("button", { name: INFO_BUTTON }) !== null).toBe(present);
        });
      };

      for (const outcome of ["unbranded", "failure", "rejection"] as const) {
        testSpy.mockResolvedValueOnce(BRANDED);
        fireEvent.click(testButton());
        await expectBranding(true);

        if (outcome === "rejection") {
          testSpy.mockImplementationOnce(() => Promise.reject(new Error("Connection lost")));
        } else {
          testSpy.mockResolvedValueOnce(
            outcome === "unbranded"
              ? { success: true, tools: [] }
              : { success: false, error: "Connection failed" }
          );
        }
        fireEvent.click(testButton());
        await expectBranding(false);
      }
    },
    60000
  );

  test("adding an edited stdio draft does not reuse the tested identity or rerun its command", async () => {
    const canvas = await openMcpSettings(app);
    const user = userEvent.setup({ document: app.view.container.ownerDocument });
    fireEvent.click(canvas.getByText("Add server"));
    await user.type(canvas.getByLabelText("Name"), "draft-server");
    await user.type(canvas.getByLabelText("Command"), "bun run first-server.ts");
    await user.click(canvas.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(testSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(canvas.getByRole<HTMLButtonElement>("button", { name: "Test" }).disabled).toBe(false);
    });

    await user.clear(canvas.getByLabelText("Command"));
    await user.type(canvas.getByLabelText("Command"), "bun run changed-server.ts");
    await user.click(canvas.getByRole("button", { name: "Add" }));
    await canvas.findByRole("switch", { name: "Toggle draft-server enabled" });
    await expectBadge(canvas, "draft-server", false);
    expect(testSpy).toHaveBeenCalledTimes(1);
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
