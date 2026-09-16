import { createInterface } from "node:readline";

type Mode = "legacy" | "modern" | "response-only" | "malformed" | "plain";

// Wire fixtures deliberately do not use a server SDK: negotiation and optional
// metadata must work with the JSON a real third-party process sends.
export function runIdentityServer(mode: Mode): void {
  const key = "io.modelcontextprotocol/serverInfo";
  const connection = { name: "Connection identity", version: "1", title: "Fixture" };
  const response = { name: "Response identity", version: "2", title: "Fixture response" };
  const handshakeMeta = mode === "modern" || mode === "malformed" ? { [key]: connection } : {};
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const request = JSON.parse(line) as { id?: string | number; method: string };
    if (request.id === undefined) return;
    let result: Record<string, unknown> | undefined;
    switch (request.method) {
      case "server/discover":
        if (mode === "legacy") break;
        result = {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          _meta: handshakeMeta,
          ttlMs: 0,
          cacheScope: "private",
        };
        break;
      case "initialize":
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: connection,
        };
        break;
      case "tools/list":
        result = {
          tools: [{ name: "identity_probe", inputSchema: { type: "object", properties: {} } }],
          ttlMs: 0,
          cacheScope: "private",
        };
        break;
      case "tools/call":
        result = {
          content: [{ type: "text", text: "fixture answer" }],
          _meta: {
            unrelated: "preserved",
            ...(mode === "modern" || mode === "response-only" ? { [key]: response } : {}),
            ...(mode === "malformed" ? { [key]: { name: 42 } } : {}),
          },
        };
        break;
      case "ping":
        result = {};
        break;
    }
    const envelope =
      result === undefined
        ? { error: { code: -32601, message: "Method not found" } }
        : { result: mode === "legacy" ? result : { ...result, resultType: "complete" } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...envelope }) + "\n");
  });
}
