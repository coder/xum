/**
 * MCP Apps seed for the bug bash (`startApp.ts --mcp-apps`, used by e2e.mcpapps.config.ts).
 *
 * Mock AI cannot call MCP tools, so the chat is written directly:
 * 1. writeMcpConfig, before the seed server starts: the "demo-app" stdio MCP Apps server
 *    (server.mjs + view.html, a dice board) in the global mcp.jsonc.
 * 2. seedMcpChat, after the seed server stopped (the server owns chat.jsonl): a chat in the
 *    playground workspace with four demo-app calls. 4d6 keeps its host-only result record,
 *    2d20 has none (its view shows input only), 50d6 failed, and get_server_time has no view.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const MCP_SERVER_ENTRY = path.join(import.meta.dir, "server.mjs");
const VIEW_URI = "ui://prototype/board.html";

export function writeMcpConfig(xumRoot: string): void {
  if (!fs.existsSync(MCP_SERVER_ENTRY)) throw new Error(`missing ${MCP_SERVER_ENTRY}`);
  fs.mkdirSync(xumRoot, { recursive: true });
  fs.writeFileSync(
    path.join(xumRoot, "mcp.jsonc"),
    JSON.stringify({ servers: { "demo-app": `node ${MCP_SERVER_ENTRY}` } }, null, 2)
  );
}

function diceResult(rolls: number[], sides: number, label: string) {
  const total = rolls.reduce((a, b) => a + b, 0);
  return {
    content: [
      {
        type: "text",
        text: `Rolled ${rolls.length}d${sides}: ${rolls.join(", ")} (total ${total}).`,
      },
    ],
    structuredContent: {
      count: rolls.length,
      sides,
      rolls,
      total,
      label,
      rolledAt: "2026-10-06T08:00:00.000Z",
    },
  };
}

const APP_SNAPSHOT = {
  connection: { key: "demo-app", transport: "stdio" },
  identity: { name: "mcp-app-prototype", version: "0.1.0" },
  source: "connection",
  app: { resourceUri: VIEW_URI },
};
const PLAIN_SNAPSHOT = {
  connection: { key: "demo-app", transport: "stdio" },
  identity: { name: "mcp-app-prototype", version: "0.1.0" },
  source: "connection",
};

/** Write a chat with MCP tool calls; the server must be stopped (it owns chat.jsonl). */
export function seedMcpChat(xumRoot: string, workspaceId: string): void {
  const sessionDir = path.join(xumRoot, "sessions", workspaceId);
  const t0 = Date.now() - 10 * 60_000;
  let seq = 0;
  const rows: unknown[] = [];
  const user = (text: string) =>
    rows.push({
      id: `user-seed-${seq}`,
      role: "user",
      metadata: { timestamp: t0 + seq * 1000, historySequence: seq++ },
      parts: [{ type: "text", text, state: "done" }],
      workspaceId,
    });
  const assistant = (parts: unknown[]) =>
    rows.push({
      id: `assistant-seed-${seq}`,
      role: "assistant",
      metadata: {
        timestamp: t0 + seq * 1000,
        historySequence: seq++,
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
        mode: "exec",
        finishReason: "stop",
      },
      parts,
      workspaceId,
    });
  const toolPart = (
    toolCallId: string,
    toolName: string,
    input: unknown,
    output: unknown,
    mcpServer: unknown
  ) => ({
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "output-available",
    input,
    timestamp: t0 + seq * 1000,
    mcpServer,
    output,
  });

  const first = diceResult([4, 6, 4, 1], 6, "4d6 roll");
  user("Roll 4d6 with the dice board");
  assistant([
    toolPart(
      "call-dice-4d6",
      "demo_app_show_dice_board",
      { count: 4, sides: 6, label: "4d6 roll" },
      first,
      APP_SNAPSHOT
    ),
    { type: "text", text: "I rolled 4d6: 4, 6, 4, 1, total 15." },
  ]);
  user("Now roll 2d20 for initiative, and tell me the server time");
  assistant([
    toolPart(
      "call-dice-2d20",
      "demo_app_show_dice_board",
      { count: 2, sides: 20, label: "Initiative" },
      diceResult([17, 3], 20, "Initiative"),
      APP_SNAPSHOT
    ),
    toolPart(
      "call-server-time",
      "demo_app_get_server_time",
      {},
      { content: [{ type: "text", text: "Server time: 2026-10-06T08:00:00.000Z" }] },
      PLAIN_SNAPSHOT
    ),
    { type: "text", text: "Initiative: 17 and 3. The server time is 08:00 UTC." },
  ]);
  user("Roll 50d6");
  assistant([
    toolPart(
      "call-dice-50d6",
      "demo_app_show_dice_board",
      { count: 50, sides: 6 },
      { success: false, error: "assertion failed: count must be 1..20" },
      APP_SNAPSHOT
    ),
    { type: "text", text: "The dice board allows at most 20 dice." },
  ]);
  fs.writeFileSync(
    path.join(sessionDir, "chat.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
  );

  // Host-only result record for the first call only, so the 2d20 view opens with input only.
  const resultsDir = path.join(sessionDir, "mcp-app-results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const name = createHash("sha256").update("call-dice-4d6").digest("hex").slice(0, 40);
  fs.writeFileSync(
    path.join(resultsDir, `${name}.json`),
    JSON.stringify({
      version: 1,
      createdAt: t0,
      toolCallId: "call-dice-4d6",
      serverName: "demo-app",
      toolName: "show_dice_board",
      resourceUri: VIEW_URI,
      arguments: { count: 4, sides: 6, label: "4d6 roll" },
      result: first,
    })
  );
}
