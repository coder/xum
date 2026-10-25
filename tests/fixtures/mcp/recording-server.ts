import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Stdio MCP stub that appends one JSON line per event to the file named by argv[2]: its own
// process start and every JSON-RPC message it receives, each with the process cwd (the checkout
// the host launched it in) and a timestamp. Tests read the file to prove whether, where and
// when a real server process ran. Serves tools and prompts so both discovery lists are exercised.
const recordFile = process.argv[2];
if (!recordFile) throw new Error("recording-server: pass the record file path as argv[2]");

const record = (event: string) =>
  appendFileSync(recordFile, JSON.stringify({ event, cwd: process.cwd(), at: Date.now() }) + "\n");
record("start");

const results: Record<string, unknown> = {
  initialize: {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {}, prompts: {} },
    serverInfo: { name: "recorder", version: "1" },
  },
  "tools/list": { tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }] },
  "prompts/list": { prompts: [{ name: "recorded" }] },
  ping: {},
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const request = JSON.parse(line) as { id?: string | number; method: string };
  record(request.method);
  if (request.id === undefined) return;
  const result = results[request.method];
  const envelope =
    result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...envelope }) + "\n");
});
