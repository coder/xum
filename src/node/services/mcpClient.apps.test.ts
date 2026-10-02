import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_APPS_EXTENSION_ID } from "@/common/utils/mcpApps";
import { createMCPClient, getMCPToolUi, type MCPClientHandle } from "./mcpClient";
import { McpAppResultStore } from "./mcpAppResultStore";
import { extractMcpAppResource } from "./mcpAppResource";
import { checkMcpAppToolCall, effectiveToolAllowlist, wrapMCPTools } from "./mcpServerManager";
import { DisposableTempDir } from "./tempDir";
import { ToolCallDisplayRegistry } from "./toolCallDisplayRegistry";
import { withExecutionScope } from "./tools/withExecutionScope";

const fixture = path.resolve(import.meta.dir, "../../../tests/fixtures/mcp/apps-server.ts");
const clients: MCPClientHandle[] = [];

async function connect(mcpApps: boolean) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture],
    stderr: "pipe",
  });
  const client = await createMCPClient({ transport, mcpApps });
  clients.push(client);
  return client;
}

async function probeCapabilities(client: MCPClientHandle): Promise<string> {
  const tools = await client.tools();
  const output = (await tools.capabilities_probe.execute!(
    {},
    { toolCallId: "probe", messages: [], context: undefined }
  )) as { content: Array<{ text: string }> };
  return output.content[0].text;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("MCP Apps client gating", () => {
  test("experiment off: no extension announced, no metadata kept, all tools listed", async () => {
    const client = await connect(false);
    expect(await probeCapabilities(client)).not.toContain(MCP_APPS_EXTENSION_ID);
    const tools = await client.tools();
    expect(Object.keys(tools).sort()).toEqual([
      "capabilities_probe",
      "legacy_view",
      "refresh_chart",
      "show_chart",
    ]);
    expect(getMCPToolUi(tools.show_chart)).toBeUndefined();
    expect(client.toolUi("show_chart")).toBeUndefined();
  });

  test("experiment on: announces text/html;profile=mcp-app and hides app-only tools", async () => {
    const client = await connect(true);
    const announced = JSON.parse(await probeCapabilities(client)) as {
      extensions?: Record<string, { mimeTypes: string[] }>;
    };
    expect(announced.extensions?.[MCP_APPS_EXTENSION_ID]).toEqual({
      mimeTypes: ["text/html;profile=mcp-app"],
    });
    const tools = await client.tools();
    expect(Object.keys(tools)).not.toContain("refresh_chart");
    expect(getMCPToolUi(tools.show_chart)).toEqual({
      resourceUri: "ui://chart/view",
      visibility: ["model", "app"],
    });
    // Deprecated flat key.
    expect(getMCPToolUi(tools.legacy_view)?.resourceUri).toBe("ui://chart/legacy");
    // Hidden tools stay known for view calls.
    expect(client.hasTool("refresh_chart")).toBe(true);
    expect(client.toolUi("refresh_chart")?.visibility).toEqual(["app"]);
  });
});

describe("MCP Apps view resources", () => {
  test("accepts text and base64 blob views with their declared CSP", async () => {
    const client = await connect(true);
    const view = extractMcpAppResource(
      await client.readResource("ui://chart/view"),
      "ui://chart/view"
    );
    expect(view.html).toContain("ui/initialize");
    expect(view.csp.connectDomains).toEqual(["https://api.example.com"]);
    expect(view.prefersBorder).toBe(true);
    const blob = extractMcpAppResource(
      await client.readResource("ui://chart/blob"),
      "ui://chart/blob"
    );
    expect(blob.html).toBe(view.html);
    expect(blob.prefersBorder).toBeNull();
  });

  test("rejects the wrong mime type, oversized views and mismatched URIs", async () => {
    const client = await connect(true);
    expect(() => extractMcpAppResource({ contents: [] }, "ui://chart/view")).toThrow(/no content/);
    const wrongMime = await client.readResource("ui://chart/wrong-mime");
    expect(() => extractMcpAppResource(wrongMime, "ui://chart/wrong-mime")).toThrow(/mime type/);
    const big = await client.readResource("ui://chart/big");
    expect(() => extractMcpAppResource(big, "ui://chart/big")).toThrow(/limit/);
    const view = await client.readResource("ui://chart/view");
    expect(() => extractMcpAppResource(view, "ui://chart/other")).toThrow(/no content/);
    expect(() =>
      extractMcpAppResource(
        { contents: [{ uri: "ui://x", mimeType: "text/html;profile=mcp-app", blob: "%%%" }] },
        "ui://x"
      )
    ).toThrow(/base64/);
  });
});

describe("MCP Apps tool results", () => {
  test("keeps the raw result host-only while the model copy stays stripped", async () => {
    using tempDir = new DisposableTempDir("mcp-apps-results");
    const client = await connect(true);
    const store = new McpAppResultStore((workspaceId) => path.join(tempDir.path, workspaceId));
    const registry = new ToolCallDisplayRegistry();
    const scope = { workspaceId: "ws1", messageId: "m1", token: "t1" };
    registry.open(scope);
    const tools = withExecutionScope(
      wrapMCPTools(await client.tools(), {
        display: {
          connection: { key: "apps", transport: "stdio" },
          identity: { name: "apps-fixture", version: "1" },
          registry,
        },
        appResults: { serverName: "apps", store },
      }),
      scope
    );
    const output: unknown = await tools.show_chart.execute!(
      { title: "Q3" },
      { toolCallId: "call-1", messages: [], context: undefined }
    );
    expect(JSON.stringify(output)).not.toContain("fixture/raw");
    expect(registry.take(scope, "call-1")?.app).toEqual({ resourceUri: "ui://chart/view" });

    // A fresh store reads the record back from the session dir.
    const record = await new McpAppResultStore((id) => path.join(tempDir.path, id)).get(
      "ws1",
      "call-1"
    );
    expect(record).toMatchObject({
      serverName: "apps",
      toolName: "show_chart",
      resourceUri: "ui://chart/view",
      arguments: { title: "Q3" },
      result: {
        structuredContent: { title: "Q3", values: [40, 75, 55, 90] },
        _meta: { "fixture/raw": "kept for the view only" },
      },
    });
  });
});

describe("MCP Apps failed tool calls", () => {
  test("a failed call keeps its view link and records its invocation", async () => {
    using tempDir = new DisposableTempDir("mcp-apps-results");
    const client = await connect(true);
    const store = new McpAppResultStore((workspaceId) => path.join(tempDir.path, workspaceId));
    const registry = new ToolCallDisplayRegistry();
    const scope = { workspaceId: "ws1", messageId: "m1", token: "t1" };
    registry.open(scope);
    const tools = withExecutionScope(
      wrapMCPTools(await client.tools(), {
        display: {
          connection: { key: "apps", transport: "stdio" },
          identity: { name: "apps-fixture", version: "1" },
          registry,
        },
        appResults: { serverName: "apps", store },
      }),
      scope
    );
    // An already-aborted call throws before reaching the server (interrupted stream).
    const controller = new AbortController();
    controller.abort();
    let threw = false;
    try {
      await tools.show_chart.execute!(
        // The optional "" is dropped by sanitization: the record keeps what the server got.
        { title: "Q3", subtitle: "" },
        { toolCallId: "call-2", messages: [], context: undefined, abortSignal: controller.signal }
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(registry.take(scope, "call-2")?.app).toEqual({ resourceUri: "ui://chart/view" });
    expect(await store.get("ws1", "call-2")).toMatchObject({
      serverName: "apps",
      toolName: "show_chart",
      resourceUri: "ui://chart/view",
      arguments: { title: "Q3" },
      result: null,
    });
  });
});

describe("checkMcpAppToolCall", () => {
  test("applies the visibility and consent rules", async () => {
    const client = await connect(true);
    await client.tools();
    expect(checkMcpAppToolCall(client, "nope", true, null)).toEqual({
      status: "rejected",
      reason: "Unknown tool 'nope'",
    });
    // App-only: no consent needed.
    expect(checkMcpAppToolCall(client, "refresh_chart", false, null)).toBeNull();
    // Model + app: consent per call.
    expect(checkMcpAppToolCall(client, "show_chart", false, null)).toEqual({
      status: "consent_required",
    });
    expect(checkMcpAppToolCall(client, "show_chart", true, null)).toBeNull();
    // Model-only tools are never app-callable.
    const modelOnly = {
      hasTool: () => true,
      toolUi: () => ({ resourceUri: "ui://v", visibility: ["model" as const] }),
    };
    expect(checkMcpAppToolCall(modelOnly, "x", true, null)?.status).toBe("rejected");
  });

  test("honors the project and workspace tool allowlists", async () => {
    const client = await connect(true);
    await client.tools();
    // Project allows both, the workspace narrows to show_chart: the intersection wins.
    const allowlist = effectiveToolAllowlist("chart", ["show_chart", "refresh_chart"], {
      toolAllowlist: { chart: ["show_chart"] },
    });
    expect(checkMcpAppToolCall(client, "refresh_chart", false, allowlist)).toEqual({
      status: "rejected",
      reason: "Tool 'refresh_chart' is not in the tool allowlist",
    });
    expect(checkMcpAppToolCall(client, "show_chart", true, allowlist)).toBeNull();
    // An empty allowlist blocks everything; no allowlist blocks nothing.
    expect(checkMcpAppToolCall(client, "show_chart", true, new Set())?.status).toBe("rejected");
    expect(effectiveToolAllowlist("chart", undefined, undefined)).toBeNull();
  });
});
