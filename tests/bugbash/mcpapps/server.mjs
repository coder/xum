#!/usr/bin/env node
// MCP Apps prototype server (SEP-1865, `io.modelcontextprotocol/ui`).
// Dependency-free: newline-delimited JSON-RPC over stdio, the format Xum expects.
//
// Tools:
//   show_dice_board   model + app  -> has a view (ui://prototype/board.html)
//   roll_dice         app only     -> hidden from the agent, the view calls it without a prompt
//   get_server_time   model + app  -> no view; when the view calls it, Xum asks you first
//
// The view HTML is re-read from view.html on every resources/read, so you can edit it and
// reopen the view without restarting the server.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const VIEW_URI = "ui://prototype/board.html";
const VIEW_MIME = "text/html;profile=mcp-app";
const VIEW_PATH = join(dirname(fileURLToPath(import.meta.url)), "view.html");

const log = (...args) => process.stderr.write(`[mcp-app-prototype] ${args.join(" ")}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

function rollDice(count, sides) {
  assert(Number.isInteger(count) && count >= 1 && count <= 20, "count must be 1..20");
  assert(Number.isInteger(sides) && sides >= 2 && sides <= 100, "sides must be 2..100");
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  return { count, sides, rolls, total: rolls.reduce((a, b) => a + b, 0) };
}

const TOOLS = [
  {
    name: "show_dice_board",
    title: "Show dice board",
    description:
      "Roll dice and show an interactive dice board to the user in the Artifacts tab. " +
      "Use when the user asks to roll dice or wants to try the MCP Apps prototype.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 20, description: "Number of dice" },
        sides: { type: "integer", minimum: 2, maximum: 100, description: "Sides per die" },
        label: { type: "string", description: "Optional heading for the board" },
      },
    },
    _meta: { ui: { resourceUri: VIEW_URI, visibility: ["model", "app"] } },
  },
  {
    name: "roll_dice",
    title: "Roll dice (app only)",
    description: "Re-roll from the view. Hidden from the agent.",
    inputSchema: {
      type: "object",
      properties: { count: { type: "integer" }, sides: { type: "integer" } },
      required: ["count", "sides"],
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "get_server_time",
    title: "Get server time",
    description: "Return the MCP server's current time and time zone.",
    inputSchema: { type: "object", properties: {} },
  },
];

function callTool(name, args) {
  switch (name) {
    case "show_dice_board":
    case "roll_dice": {
      const result = rollDice(args.count ?? 2, args.sides ?? 6);
      const label = typeof args.label === "string" && args.label ? args.label : "Dice board";
      return {
        content: [
          {
            type: "text",
            text: `Rolled ${result.count}d${result.sides}: ${result.rolls.join(", ")} (total ${result.total}).`,
          },
        ],
        // The agent sees `content`; the view reads `structuredContent`.
        structuredContent: { ...result, label, rolledAt: new Date().toISOString() },
      };
    }
    case "get_server_time": {
      const now = new Date();
      return {
        content: [{ type: "text", text: `Server time: ${now.toISOString()}` }],
        structuredContent: {
          iso: now.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      };
    }
    default:
      return null;
  }
}

function handleRequest(id, method, params) {
  switch (method) {
    // Xum probes the 2026 "server/discover" first; method-not-found makes it fall back to
    // the classic initialize handshake.
    case "initialize": {
      const ext = params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"];
      log(`initialize from ${params?.clientInfo?.name ?? "?"}; MCP Apps announced: ${ext ? "yes" : "NO"}`);
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "mcp-app-prototype", version: "0.1.0" },
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      log(`tools/call ${params?.name}`);
      try {
        const result = callTool(params?.name, params?.arguments ?? {});
        if (result === null) return fail(id, -32602, `Unknown tool: ${params?.name}`);
        return reply(id, result);
      } catch (error) {
        // Tool errors go back as a result so the agent can read them.
        return reply(id, { isError: true, content: [{ type: "text", text: String(error.message) }] });
      }
    }
    case "resources/list":
      return reply(id, {
        resources: [{ uri: VIEW_URI, name: "Dice board view", mimeType: VIEW_MIME }],
      });
    case "resources/templates/list":
      return reply(id, { resourceTemplates: [] });
    case "resources/read": {
      if (params?.uri !== VIEW_URI) return fail(id, -32602, `Unknown resource: ${params?.uri}`);
      return reply(id, {
        contents: [
          {
            uri: VIEW_URI,
            mimeType: VIEW_MIME,
            text: readFileSync(VIEW_PATH, "utf8"),
            // No network needed: declare no domains. prefersBorder asks the host for a frame.
            _meta: { ui: { prefersBorder: true, csp: {} } },
          },
        ],
      });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  // Notifications (no id) need no reply.
  if (msg.id === undefined || msg.id === null) return;
  if (typeof msg.method !== "string") return; // a response to us; we send no requests
  handleRequest(msg.id, msg.method, msg.params);
});
log("ready");
