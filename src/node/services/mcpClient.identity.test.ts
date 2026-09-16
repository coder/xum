import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Config } from "@/node/config";
import { shellQuote } from "@/common/utils/shell";
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
        expect(JSON.stringify(output)).toContain("preserved");
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
      } finally {
        manager.dispose();
      }
    },
    15_000
  );
});
