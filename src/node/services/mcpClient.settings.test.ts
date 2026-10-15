import { afterEach, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMCPClient, type MCPClientHandle } from "./mcpClient";

const fixture = path.resolve(import.meta.dir, "../../../tests/fixtures/mcp/settings-server.ts");
let client: MCPClientHandle | undefined;

afterEach(async () => {
  await client?.close();
});

test("settings tools are hidden from the model and called with the host's _meta", async () => {
  client = await createMCPClient({
    transport: new StdioClientTransport({ command: process.execPath, args: [fixture] }),
  });
  expect(client.settingsCapability()).toEqual({
    readTool: "settings.read",
    updateTool: "settings.update",
  });
  // The model sees only ordinary tools: it cannot change the user's settings.
  expect(Object.keys(await client.tools())).toEqual(["library", "reset", "viewer", "echo"]);
  // Nor can an MCP App view: app calls go only to listed tools.
  expect(client.hasTool("echo")).toBe(true);
  expect(client.hasTool("settings.update")).toBe(false);

  const result = await client.callSettingsTool(
    "settings.update",
    { set: { units: "mm" } },
    { "xum/workspaceId": "ws-1" }
  );
  expect(result.structuredContent).toEqual({
    received: { set: { units: "mm" } },
    meta: { "xum/workspaceId": "ws-1" },
  });
  // Only the advertised settings tools go through this host-only path.
  expect(() => client!.callSettingsTool("echo", {}, {})).toThrow();
});

test("a half-malformed capability still hides its valid tool from the model and apps", async () => {
  const env: Record<string, string> = { SETTINGS_FIXTURE_HALF: "1" };
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  client = await createMCPClient({
    transport: new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      env,
    }),
  });
  expect(client.settingsCapability()).toBeUndefined();
  expect(Object.keys(await client.tools())).toEqual([
    "settings.read",
    "library",
    "reset",
    "viewer",
    "echo",
  ]);
  expect(client.hasTool("settings.update")).toBe(false);
});

test("settings tool actions: the spec's display name order, readOnlyHint, and {} arguments", async () => {
  client = await createMCPClient({
    transport: new StdioClientTransport({ command: process.execPath, args: [fixture] }),
  });
  // Before tools/list there is nothing to act on.
  expect(client.settingsToolAction("library")).toBeUndefined();
  await client.tools();
  expect(client.settingsToolAction("library")).toEqual({
    title: "Part library",
    readOnly: true,
    opensApp: false,
  });
  expect(client.settingsToolAction("reset")).toEqual({
    title: "Reset parts",
    readOnly: false,
    opensApp: false,
  });
  expect(client.settingsToolAction("echo")).toEqual({
    title: "echo",
    readOnly: false,
    opensApp: false,
  });
  expect(client.settingsToolAction("viewer")?.opensApp).toBe(true);
  // The settings tools themselves are no actions.
  expect(client.settingsToolAction("settings.update")).toBeUndefined();

  // relistTools re-reads the catalog (tools/list), as a settings action does before a dispatch.
  await client.relistTools();
  expect(client.settingsToolAction("library")?.title).toBe("Part library");
  const result = await client.callSettingsActionTool("library", { "xum/workspaceId": "ws-1" });
  expect(result.structuredContent).toEqual({ received: {}, meta: { "xum/workspaceId": "ws-1" } });
  expect(() => client!.callSettingsActionTool("settings.update", {})).toThrow();
});

test("overlapping tool listings: a late, older tools/list response keeps the newer catalog", async () => {
  client = await createMCPClient({
    transport: new StdioClientTransport({ command: process.execPath, args: [fixture] }),
  });
  await client.tools();
  // Two re-lists overlap. The first one's response arrives last and still lacks "reset", as
  // the server listed it before a tools/list_changed.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with each client as `this`
  const realListTools = Client.prototype.listTools;
  const firstHeld = Promise.withResolvers<void>();
  let calls = 0;
  const listTools = spyOn(Client.prototype, "listTools").mockImplementation(async function (
    this: Client,
    ...args: Parameters<Client["listTools"]>
  ) {
    const call = ++calls;
    const result = await realListTools.apply(this, args);
    if (call !== 1) return result;
    await firstHeld.promise;
    return { ...result, tools: result.tools.filter((tool) => tool.name !== "reset") };
  });
  try {
    const older = client.relistTools();
    const newer = client.relistTools();
    await newer;
    firstHeld.resolve();
    await older;
  } finally {
    listTools.mockRestore();
  }
  expect(calls).toBe(2);
  expect(client.settingsToolAction("reset")?.title).toBe("Reset parts");
});
