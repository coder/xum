import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
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
  expect(Object.keys(await client.tools())).toEqual(["library", "reset", "echo"]);
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
  expect(Object.keys(await client.tools())).toEqual(["settings.read", "library", "reset", "echo"]);
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
  // The settings tools themselves are no actions.
  expect(client.settingsToolAction("settings.update")).toBeUndefined();

  const result = await client.callSettingsActionTool("library", { "xum/workspaceId": "ws-1" });
  expect(result.structuredContent).toEqual({ received: {}, meta: { "xum/workspaceId": "ws-1" } });
  expect(() => client!.callSettingsActionTool("settings.update", {})).toThrow();
});
