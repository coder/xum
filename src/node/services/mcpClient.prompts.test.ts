import { afterEach, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMCPClient, type MCPClientHandle } from "./mcpClient";

// This fixture advertises tools but not the `prompts` capability.
const fixture = path.resolve(import.meta.dir, "../../../tests/fixtures/mcp/settings-server.ts");
let client: MCPClientHandle | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

test("a server without the prompts capability yields no prompts and no SDK warning", async () => {
  client = await createMCPClient({
    transport: new StdioClientTransport({ command: process.execPath, args: [fixture] }),
  });
  // The SDK's listPrompts() prints a console.debug line on every call to such a
  // server; Xum lists prompts often (composer, tool descriptions), which flooded
  // the server log.
  const debug = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    expect(await client.prompts()).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
  } finally {
    debug.mockRestore();
  }
});
