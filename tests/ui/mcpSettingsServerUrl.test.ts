import "./dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { BoundFunctions, queries } from "@testing-library/react";
import { shouldRunIntegrationTests } from "../testUtils";
import { preloadTestModules } from "../ipc/setup";
import { createAppHarness, type AppHarness } from "./harness";
import { openSettingsDialog } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const SERVER = "remote-docs";
const SAVED_URL = "https://docs.example.com/mcp";

type Canvas = BoundFunctions<typeof queries>;

/** The Settings row card for one configured server (contains its switch and actions). */
function serverRow(canvas: Canvas, name: string): HTMLElement {
  let element: HTMLElement | null = canvas.getByRole("switch", { name: `Toggle ${name} enabled` });
  // The row shows Edit when idle and Save while editing.
  while (element && !within(element).queryByRole("button", { name: /^(Edit server|Save)$/ })) {
    element = element.parentElement;
  }
  if (!element) throw new Error(`Settings row for ${name} not found`);
  return element;
}

function isDisabled(button: HTMLElement): boolean {
  return (button as HTMLButtonElement).disabled;
}

// Full AppLoader + real IPC: the form gate under test is what the user can save.
describeIntegration("MCP settings server URL validation", () => {
  let app: AppHarness;
  beforeAll(preloadTestModules);
  beforeEach(async () => {
    app = await createAppHarness({
      aiMode: "none",
      branchPrefix: "mcp-server-url",
      beforeRenderEnvironment: async (env) => {
        const added = await env.orpc.mcp.add({ name: SERVER, transport: "http", url: SAVED_URL });
        if (!added.success) throw new Error(added.error);
      },
    });
  }, 120000);
  afterEach(async () => {
    await app?.dispose();
  });

  test("editing a remote server refuses a URL that is not absolute http(s)", async () => {
    const canvas = await openSettingsDialog(app.view.container);
    fireEvent.click(await canvas.findByRole("button", { name: "MCP" }));
    await canvas.findByRole("switch", { name: `Toggle ${SERVER} enabled` }, { timeout: 10000 });

    fireEvent.click(within(serverRow(canvas, SERVER)).getByRole("button", { name: "Edit server" }));
    const row = serverRow(canvas, SERVER);
    const input = within(row).getByDisplayValue(SAVED_URL);
    const save = within(row).getByRole("button", { name: "Save" });

    fireEvent.change(input, { target: { value: "docs.example.com/mcp" } });
    expect(isDisabled(save)).toBe(true);
    expect(within(row).getByText(/absolute http:\/\/ or https:\/\/ URL/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "ftp://docs.example.com/mcp" } });
    expect(isDisabled(save)).toBe(true);
    expect(within(row).getByText(/must use http:\/\/ or https:\/\//)).toBeTruthy();

    fireEvent.change(input, { target: { value: "https://docs.example.com/v2/mcp" } });
    expect(isDisabled(save)).toBe(false);
    expect(
      within(row).queryByText(/absolute http:\/\/ or https:\/\/ URL|must use http/)
    ).toBeNull();
    fireEvent.click(save);
    await waitFor(() => {
      if (!within(serverRow(canvas, SERVER)).queryByText("https://docs.example.com/v2/mcp"))
        throw new Error("Edit not saved yet");
    });
  }, 60000);
});
