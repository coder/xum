import { createInterface } from "node:readline";

/**
 * Legacy-protocol (2025-11-25) MCP stdio server advertising OpenAI structured
 * settings (`openai/settings`), for mcpClient tests. Raw JSON-RPC like
 * apps-server.ts. `settings.update` echoes the arguments and `_meta` it got.
 */
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line) as {
    id?: string | number;
    method: string;
    params?: { name?: string; arguments?: unknown; _meta?: unknown };
  };
  if (request.id === undefined) return;
  let result: Record<string, unknown> | undefined;
  const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
          experimental: {
            // SETTINGS_FIXTURE_HALF: a malformed readTool (only updateTool stays valid).
            "openai/settings": {
              readTool: process.env.SETTINGS_FIXTURE_HALF === "1" ? "" : "settings.read",
              updateTool: "settings.update",
            },
          },
        },
        serverInfo: { name: "settings-fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = { tools: [tool("settings.read"), tool("settings.update"), tool("echo")] };
      break;
    case "tools/call":
      result = {
        content: [],
        structuredContent: { received: request.params?.arguments, meta: request.params?._meta },
      };
      break;
  }
  const envelope =
    result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...envelope }) + "\n");
});
