import { createInterface } from "node:readline";

type Mode = "legacy" | "modern" | "response-only" | "malformed" | "plain";

/** Optional `Implementation.icons`; every mode stays icon-free unless a wrapper opts in. */
export interface IdentityServerOptions {
  /** Icons on the handshake identity (legacy `initialize`, modern `server/discover`). */
  connectionIcons?: unknown[];
  /** Icons on the per-result identity (modern and response-only `tools/call`). */
  responseIcons?: unknown[];
}

// Wire fixtures deliberately do not use a server SDK: negotiation and optional
// metadata must work with the JSON a real third-party process sends.
export function runIdentityServer(mode: Mode, options: IdentityServerOptions = {}): void {
  const key = "io.modelcontextprotocol/serverInfo";
  const connection = {
    name: "Connection identity",
    version: "1",
    title: "Fixture",
    ...(options.connectionIcons ? { icons: options.connectionIcons } : {}),
  };
  const response = {
    name: "Response identity",
    version: "2",
    title: "Fixture response",
    ...(options.responseIcons ? { icons: options.responseIcons } : {}),
  };
  const handshakeMeta = mode === "modern" || mode === "malformed" ? { [key]: connection } : {};
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const request = JSON.parse(line) as {
      id?: string | number;
      method: string;
      params?: { arguments?: { fail?: unknown } };
    };
    if (request.id === undefined) return;
    let result: Record<string, unknown> | undefined;
    // `{ fail: true }` makes the tool call itself fail with a JSON-RPC error,
    // so tests can exercise the host's failed-call path against a real server.
    if (request.method === "tools/call" && request.params?.arguments?.fail === true) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: "fixture tool failure" },
        }) + "\n"
      );
      return;
    }
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
