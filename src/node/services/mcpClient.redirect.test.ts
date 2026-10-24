import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import { createMCPClient, type MCPClientHandle } from "./mcpClient";

// #7384 (CVE-2026-111769): an MCP server that redirects to another origin must not receive the
// user's custom headers there. Runs the real SDK transport against two local HTTP servers on
// different ports, which are different origins.

let configured: Server;
let other: Server;
let configuredUrl: string;
let otherUrl: string;
/** Headers of every request the other origin received. */
let otherRequests: IncomingHttpHeaders[];
let client: MCPClientHandle | undefined;

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Failed to bind"));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

/** A minimal Streamable HTTP MCP server: initialize and tools/list over plain JSON replies. */
function answerMcp(body: string, res: import("http").ServerResponse) {
  const message = JSON.parse(body || "{}") as { id?: number; method?: string };
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "redirect", version: "1.0.0" },
        }
      : { tools: [] };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

beforeEach(async () => {
  otherRequests = [];
  other = createServer((req, res) => {
    otherRequests.push(req.headers);
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => answerMcp(body, res));
  });
  otherUrl = await listen(other);
  configured = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      if (req.url === "/cross") {
        res.writeHead(307, { location: `${otherUrl}/mcp` }).end();
      } else if (req.url === "/same") {
        res.writeHead(307, { location: "/same/" }).end();
      } else {
        answerMcp(body, res);
      }
    });
  });
  configuredUrl = await listen(configured);
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  for (const server of [configured, other]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a redirect to another origin fails and never sends the custom headers there", async () => {
  const failure = await createMCPClient({
    transport: { type: "http", url: `${configuredUrl}/cross`, headers: { "X-Api-Key": "secret" } },
    prior: { kind: "legacy" },
  }).then(
    (handle) => {
      client = handle;
      return undefined;
    },
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Error);
  expect(otherRequests.map((headers) => headers["x-api-key"])).not.toContain("secret");
});

test("a redirect within the configured origin (trailing slash) still connects", async () => {
  client = await createMCPClient({
    transport: { type: "http", url: `${configuredUrl}/same`, headers: { "X-Api-Key": "secret" } },
    prior: { kind: "legacy" },
  });
  expect(await client.tools()).toEqual({});
});
