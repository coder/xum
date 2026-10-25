import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Config } from "@/node/config";
import { shellQuote } from "@/common/utils/shell";
import { isPngDataUrl } from "@/common/utils/mcp/pngDataUrl";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { MCPConfigService } from "./mcpConfigService";
import { createMCPClient } from "./mcpClient";
import { MCPServerManager, wrapMCPTools } from "./mcpServerManager";
import { normalizeServerIdentity } from "./mcpServerIdentity";
import { DisposableTempDir } from "./tempDir";
import { ToolCallDisplayRegistry } from "./toolCallDisplayRegistry";
import { withExecutionScope } from "./tools/withExecutionScope";

const fixtures = path.resolve(import.meta.dir, "../../../tests/fixtures/mcp");

describe("real MCP identity negotiation", () => {
  test.each(["legacy", "modern", "response-only", "malformed", "plain"] as const)(
    "%s: handshake, result precedence, and display-free model output",
    async (mode) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(fixtures, `${mode}-server.ts`)],
        stderr: "pipe",
      });
      const client = await createMCPClient({ transport });
      try {
        const connectionIdentity = normalizeServerIdentity(client.serverInfo())?.identity;
        const hasHandshake = mode === "legacy" || mode === "modern" || mode === "malformed";
        expect(connectionIdentity?.name).toBe(hasHandshake ? "Connection identity" : undefined);
        expect(client.negotiatedProtocolVersion()).toBe(
          mode === "legacy" ? "2025-11-25" : "2026-07-28"
        );
        const registry = new ToolCallDisplayRegistry();
        const scope = { workspaceId: "workspace", messageId: "message", token: "turn" };
        registry.open(scope);
        const tools = withExecutionScope(
          wrapMCPTools(await client.tools(), {
            display: {
              connection: { key: "fixture", transport: "stdio" },
              identity: connectionIdentity,
              registry,
            },
          }),
          scope
        );
        const tool = tools.identity_probe;
        const output: unknown = await tool.execute!(
          {},
          {
            toolCallId: "probe",
            messages: [],
            context: undefined,
          }
        );
        expect(output).toMatchObject({ content: [{ type: "text", text: "fixture answer" }] });
        expect(JSON.stringify(output)).not.toContain("io.modelcontextprotocol/serverInfo");
        // Unrelated protocol _meta is dropped too.
        expect(JSON.stringify(output)).not.toContain("preserved");
        const snapshot = registry.take(scope, "probe");
        if (mode === "plain") {
          expect(snapshot).toBeUndefined();
        } else {
          const response = mode === "modern" || mode === "response-only";
          expect(snapshot).toMatchObject({
            identity: { name: response ? "Response identity" : "Connection identity" },
            source: response ? "response" : "connection",
          });
        }
        expect(registry.take(scope, "probe")).toBeUndefined();
        const modelOutput = await tool.toModelOutput!({
          output,
          input: {},
          toolCallId: "probe",
        });
        expect(JSON.stringify(modelOutput)).not.toContain("identity");
        expect(JSON.stringify(modelOutput)).toContain("fixture answer");
      } finally {
        await client.close();
        await transport.close();
      }
    },
    15_000
  );

  test.each(["legacy", "modern", "response-only", "malformed", "plain"] as const)(
    "%s: Test connection uses handshake identity without invoking a tool",
    async (mode) => {
      using tmp = new DisposableTempDir("mcp-identity-test");
      const manager = new MCPServerManager(new MCPConfigService(new Config(tmp.path)));
      try {
        const result = await manager.test({
          projectPath: tmp.path,
          command: `${shellQuote(process.execPath)} ${shellQuote(path.join(fixtures, `${mode}-server.ts`))}`,
          trusted: true,
        });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error(result.error);
        expect(result.tools).toEqual(["identity_probe"]);
        expect(result.serverInfo?.name).toBe(
          mode === "legacy" || mode === "modern" || mode === "malformed"
            ? "Connection identity"
            : undefined
        );
        // No fixture mode reports icons: a response-only server stays unbranded in Settings.
        expect(result.icon).toBeUndefined();
      } finally {
        manager.dispose();
      }
    },
    15_000
  );

  test("branded: Test connection rasterizes the handshake icon after the connection verdict", async () => {
    using tmp = new DisposableTempDir("mcp-identity-test");
    const manager = new MCPServerManager(new MCPConfigService(new Config(tmp.path)));
    try {
      const result = await manager.test({
        projectPath: tmp.path,
        command: `${shellQuote(process.execPath)} ${shellQuote(path.join(fixtures, "branded-legacy-server.ts"))}`,
        trusted: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.serverInfo?.name).toBe("Connection identity");
      expect(isPngDataUrl(result.icon)).toBe(true);
    } finally {
      manager.dispose();
    }
  }, 30_000);

  test("branded: served tool calls carry a per-generation icon ref that outlives a reconnect", async () => {
    using tmp = new DisposableTempDir("mcp-identity-serve");
    const displayRegistry = new ToolCallDisplayRegistry();
    const manager = new MCPServerManager(new MCPConfigService(new Config(tmp.path)), {
      toolCallDisplayRegistry: displayRegistry,
      inlineServers: {
        branded: `${shellQuote(process.execPath)} ${shellQuote(path.join(fixtures, "branded-legacy-server.ts"))}`,
      },
    });
    const request = {
      workspaceId: "branded-workspace",
      projectPath: tmp.path,
      workspacePath: tmp.path,
      runtime: new LocalRuntime(tmp.path),
      trusted: true,
    };
    const scope = { workspaceId: request.workspaceId, messageId: "message", token: "turn" };
    displayRegistry.open(scope);
    const probe = async (callId: string): Promise<string> => {
      const served = await manager.getToolsForWorkspace(request);
      const tools = withExecutionScope(served.tools, scope);
      const output: unknown = await tools.branded_identity_probe.execute!(
        {},
        { toolCallId: callId, messages: [], context: undefined }
      );
      expect(JSON.stringify(output)).not.toContain("data:image");
      const snapshot = displayRegistry.take(scope, callId);
      expect(snapshot).toMatchObject({
        connection: { key: "branded", transport: "stdio" },
        identity: { name: "Connection identity" },
        source: "connection",
      });
      expect(JSON.stringify(snapshot)).not.toContain("data:");
      expect(snapshot?.iconRef).toMatch(/^[a-f0-9]{32}$/);
      return snapshot!.iconRef!;
    };
    try {
      const first = await probe("first");
      // The same connected generation reuses its ref across calls.
      expect(await probe("second")).toBe(first);
      const icon = await manager.getIcon(first);
      expect(isPngDataUrl(icon)).toBe(true);

      // A reconnect under the same alias is a new generation: new ref, and
      // the historical ref still resolves to what it always did.
      await manager.stopServers(request.workspaceId);
      const reconnected = await probe("third");
      expect(reconnected).not.toBe(first);
      expect(await manager.getIcon(first)).toBe(icon);
      expect(await manager.getIcon(reconnected)).toBe(icon);
      // Lookup only: an unknown ref is null, never a fetch or decode.
      expect(await manager.getIcon("0".repeat(32))).toBeNull();
      // The bulk lookup answers every requested ref once, unknown refs included.
      expect(await manager.getIcons([first, reconnected, "0".repeat(32), first])).toEqual({
        [first]: icon,
        [reconnected]: icon,
        ["0".repeat(32)]: null,
      });
    } finally {
      await manager.stopServers(request.workspaceId);
      manager.dispose();
    }
  }, 60_000);
});
