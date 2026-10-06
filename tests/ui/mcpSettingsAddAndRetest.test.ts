import "./dom";
import { createServer, type Server, type ServerResponse } from "http";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { BoundFunctions, queries } from "@testing-library/react";
import { shouldRunIntegrationTests } from "../testUtils";
import { preloadTestModules } from "../ipc/setup";
import { createAppHarness, type AppHarness } from "./harness";
import { openSettingsDialog } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const SERVER = "held-remote";
const OTHER_SERVER = "held-remote-2";

type Canvas = BoundFunctions<typeof queries>;

/** The Settings row card for one configured server (contains its switch and actions). */
function serverRow(canvas: Canvas, name: string): HTMLElement {
  let element: HTMLElement | null = canvas.getByRole("switch", { name: `Toggle ${name} enabled` });
  while (element && !within(element).queryByRole("button", { name: "Test connection" })) {
    element = element.parentElement;
  }
  // The card also holds the test-result area below the header grid.
  const card = element?.parentElement;
  if (!card) throw new Error(`Settings row for ${name} not found`);
  return card;
}

/**
 * HTTP endpoint whose replies the test releases one by one, so a running
 * connection test can be observed before its result lands.
 */
function createHeldServer() {
  const held: ServerResponse[] = [];
  const server: Server = createServer((_req, res) => {
    held.push(res);
  });
  return {
    server,
    heldCount: () => held.length,
    /** Answer every held request with a plain-text error status. */
    releaseAll(status: number) {
      for (const res of held.splice(0)) {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/plain");
        res.end("unavailable");
      }
    },
  };
}

// Full AppLoader + real IPC: the user-visible Settings > MCP behavior under test.
describeIntegration("MCP settings add and re-test", () => {
  let app: AppHarness;
  let held: ReturnType<typeof createHeldServer>;
  let url = "";

  beforeAll(preloadTestModules);
  beforeEach(async () => {
    held = createHeldServer();
    await new Promise<void>((resolve) => held.server.listen(0, "127.0.0.1", resolve));
    const address = held.server.address();
    if (!address || typeof address === "string") throw new Error("held server did not bind");
    url = `http://127.0.0.1:${address.port}/mcp`;
    app = await createAppHarness({
      aiMode: "none",
      branchPrefix: "mcp-add-retest",
      beforeRenderEnvironment: async (env) => {
        for (const name of [SERVER, OTHER_SERVER]) {
          const added = await env.orpc.mcp.add({ name, transport: "http", url });
          if (!added.success) throw new Error(added.error);
        }
      },
    });
  }, 120000);
  afterEach(async () => {
    held?.releaseAll(503);
    await app?.dispose();
    await new Promise<void>((resolve) => held?.server.close(() => resolve()));
  });

  test("Add refuses a name that an existing server already uses (#5679)", async () => {
    const canvas = await openSettingsDialog(app.view.container);
    fireEvent.click(await canvas.findByRole("button", { name: "MCP" }));
    await canvas.findByRole("switch", { name: `Toggle ${SERVER} enabled` }, { timeout: 10000 });

    fireEvent.change(canvas.getByLabelText("Name"), { target: { value: `  ${SERVER} ` } });
    fireEvent.change(canvas.getByLabelText("Command"), { target: { value: "echo replaced" } });

    const add = canvas.getByRole<HTMLButtonElement>("button", { name: "Add" });
    expect(add.disabled).toBe(true);
    expect(canvas.getByText("A server with this name already exists")).toBeTruthy();

    fireEvent.click(add);
    const servers = await app.env.orpc.mcp.list({});
    expect(servers[SERVER]).toMatchObject({ transport: "http", url });

    // A new name is accepted again.
    fireEvent.change(canvas.getByLabelText("Name"), { target: { value: "fresh-name" } });
    expect(canvas.getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled).toBe(false);
    expect(canvas.queryByText("A server with this name already exists")).toBeNull();

    // Names inherited from Object.prototype are not configured servers.
    fireEvent.change(canvas.getByLabelText("Name"), { target: { value: "constructor" } });
    expect(canvas.getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled).toBe(false);
  }, 60000);

  test("tests on two rows each show their own progress", async () => {
    const canvas = await openSettingsDialog(app.view.container);
    fireEvent.click(await canvas.findByRole("button", { name: "MCP" }));
    await canvas.findByRole(
      "switch",
      { name: `Toggle ${OTHER_SERVER} enabled` },
      { timeout: 10000 }
    );

    for (const name of [SERVER, OTHER_SERVER]) {
      fireEvent.click(
        within(serverRow(canvas, name)).getByRole("button", { name: "Test connection" })
      );
    }
    await waitFor(() => expect(held.heldCount()).toBeGreaterThanOrEqual(2), { timeout: 10000 });
    for (const name of [SERVER, OTHER_SERVER]) {
      expect(within(serverRow(canvas, name)).getByText("Testing connection…")).toBeTruthy();
    }

    held.releaseAll(500);
    for (const name of [SERVER, OTHER_SERVER]) {
      await within(serverRow(canvas, name)).findByText(/HTTP 500/, {}, { timeout: 10000 });
    }
  }, 60000);

  test("re-testing a saved server replaces the old result while the test runs (#5680)", async () => {
    const canvas = await openSettingsDialog(app.view.container);
    fireEvent.click(await canvas.findByRole("button", { name: "MCP" }));
    await canvas.findByRole("switch", { name: `Toggle ${SERVER} enabled` }, { timeout: 10000 });

    const testButton = () =>
      within(serverRow(canvas, SERVER)).getByRole("button", { name: "Test connection" });

    fireEvent.click(testButton());
    await waitFor(() => expect(held.heldCount()).toBeGreaterThan(0), { timeout: 10000 });
    held.releaseAll(500);
    await within(serverRow(canvas, SERVER)).findByText(/HTTP 500/, {}, { timeout: 10000 });

    // Re-test: the old result must not stay on screen as if nothing ran.
    fireEvent.click(testButton());
    await waitFor(() => expect(held.heldCount()).toBeGreaterThan(0), { timeout: 10000 });
    const row = serverRow(canvas, SERVER);
    expect(within(row).queryByText(/HTTP 500/)).toBeNull();
    expect(within(row).getByText("Testing connection…")).toBeTruthy();

    held.releaseAll(502);
    await within(serverRow(canvas, SERVER)).findByText(/HTTP 502/, {}, { timeout: 10000 });
    expect(within(serverRow(canvas, SERVER)).queryByText("Testing connection…")).toBeNull();
  }, 60000);
});
