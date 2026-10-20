/**
 * Scripted Anthropic model for the `scripted-tools` scenario (BUGBASH_SCENARIO=scripted-tools,
 * startApp.ts), the one bug-bash app that runs with agent tools on (#7027, #7029).
 *
 * Why: a prompt-cache regression lives in the tool block that Xum sends the model, and every
 * other lane hides that block. The mock AI returns before Xum builds a request, and every app with
 * a model runs with XUM_DISABLE_AGENT_TOOLS=1, which sends no tools at all. This fake is the app's
 * only model, on loopback, and it logs each agent request's tool block, so an exact-step repro
 * (repros/toolBlockAcrossNudge.e2e.ts) can compare the blocks of a turn and its TODO nudge.
 *
 * Safety (why tools may be on here, see startApp.ts): no model writes the replies. The script is
 * fixed and never reads the text that anyone types: it picks the next step only from the shape of
 * the conversation (a user text or a tool result) and from its own earlier replies. It calls only
 * todo_write and file_read, with fixed arguments, and file_read only reads the seeded README.md.
 * startApp.ts starts this scenario only in an exact-step job of the bug-bash sandbox: no network,
 * no provider proxy, no explorer model, and terminals and project automation stay off.
 *
 * Requests without todo_write in their tools (title and status side requests) get a short text.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";

import {
  SCRIPTED_DONE_TEXT as DONE_TEXT,
  SCRIPTED_STARTED_TEXT as STARTED_TEXT,
  type ScriptedModelRequest,
  type ScriptedStep,
} from "./appControl";
import { json, messageStart, sse } from "./fakeProvider";

export { DONE_TEXT, STARTED_TEXT };
const TODO_ITEM = "Read README.md";

type Json = Record<string, unknown>;
type Block = Json & { type?: unknown };

function blocks(message: Json | undefined): Block[] {
  const content = message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(message: Json | undefined): string {
  return blocks(message)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function toolResultText(block: Block): string {
  const content = block.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? (content as Block[])
        .filter((b) => b.type === "text")
        .map((b) => String(b.text))
        .join("\n")
    : "";
}

/**
 * The next step of the script, from the conversation's shape only (never from typed text):
 * a user text starts the script, unless the previous assistant reply was STARTED_TEXT (then the
 * text is Xum's nudge); a tool result moves on from the tool call it answers.
 */
export function nextStep(messages: Json[]): ScriptedStep {
  const last = messages.at(-1);
  const result = blocks(last).findLast((b) => b.type === "tool_result");
  if (last?.role === "user" && result !== undefined) {
    const call = blocks(messages.at(-2)).find(
      (b) => b.type === "tool_use" && b.id === result.tool_use_id
    );
    if (call?.name === "file_read") return "complete-todo";
    if (call?.name === "todo_write") {
      const todos = (call.input as { todos?: { status?: string }[] } | undefined)?.todos ?? [];
      return todos.every((todo) => todo.status === "completed") ? "finish" : "end-with-open-todo";
    }
    return "finish";
  }
  const previous = messages.slice(0, -1).findLast((m) => m.role === "assistant");
  return textOf(previous).includes(STARTED_TEXT) ? "read-file" : "write-open-todo";
}

/** Each step's reply: one fixed tool call, or a fixed text that ends the turn. */
const REPLIES: Record<ScriptedStep, { tool: string; input: Json } | { text: string }> = {
  "write-open-todo": {
    tool: "todo_write",
    input: { todos: [{ content: TODO_ITEM, status: "in_progress" }] },
  },
  "end-with-open-todo": { text: STARTED_TEXT },
  "read-file": { tool: "file_read", input: { path: "README.md" } },
  "complete-todo": {
    tool: "todo_write",
    input: { todos: [{ content: TODO_ITEM, status: "completed" }] },
  },
  finish: { text: DONE_TEXT },
};

let calls = 0;

function reply(res: http.ServerResponse, model: string, step: ScriptedStep | null): void {
  const answer = step === null ? { text: "Bug bash playground" } : REPLIES[step];
  const usage = { input_tokens: 500, output_tokens: 1 };
  const [block, deltas, stopReason]: [Json, Json[], string] =
    "tool" in answer
      ? [
          { type: "tool_use", id: `toolu_scripted_${++calls}`, name: answer.tool, input: {} },
          [{ type: "input_json_delta", partial_json: JSON.stringify(answer.input) }],
          "tool_use",
        ]
      : [{ type: "text", text: "" }, [{ type: "text_delta", text: answer.text }], "end_turn"];
  sse(res, [
    messageStart(model, usage),
    ["content_block_start", { index: 0, content_block: block }],
    ...deltas.map((delta): [string, Json] => ["content_block_delta", { index: 0, delta }]),
    ["content_block_stop", { index: 0 }],
    [
      "message_delta",
      { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } },
    ],
    ["message_stop", {}],
  ]);
}

function answer(res: http.ServerResponse, body: Json, logPath: string): string {
  const model = typeof body.model === "string" ? body.model : "claude-sonnet-5-5";
  const tools = Array.isArray(body.tools) ? (body.tools as Json[]) : [];
  const toolNames = tools.map((tool) => String(tool.name)).sort();
  // Side requests (titles, status) carry no todo_write: a short text, not logged.
  if (!toolNames.includes("todo_write")) {
    if (body.stream === true) reply(res, model, null);
    else
      json(res, 200, {
        id: `msg_scripted_${++calls}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "Bug bash playground" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 2 },
      });
    return "side-request";
  }
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  const step = nextStep(messages);
  const last = blocks(messages.at(-1)).findLast((b) => b.type === "tool_result");
  const record: ScriptedModelRequest = {
    step,
    toolNames,
    toolsSha256: createHash("sha256").update(JSON.stringify(body.tools)).digest("hex"),
    toolResult: last === undefined ? null : toolResultText(last),
  };
  // Logged before the reply, so the test reads this request once the UI shows its result.
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  reply(res, model, step);
  return step;
}

/** Starts the scripted model on a free loopback port and returns its origin (no trailing slash). */
export async function startScriptedModel(
  logPath: string
): Promise<{ origin: string; close: () => void }> {
  fs.rmSync(logPath, { force: true });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const route = (req.url ?? "").split("?")[0];
      let kind = "404";
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = (raw ? JSON.parse(raw) : {}) as Json;
        if (req.method === "POST" && route.endsWith("/messages")) kind = answer(res, body, logPath);
        else json(res, 404, { type: "error", error: { type: "not_found_error", message: "fake" } });
      } catch (error) {
        kind = `failed: ${String(error)}`;
        if (!res.headersSent) json(res, 500, { type: "error", error: { message: "fake failed" } });
      }
      console.log(`[scripted-model] ${req.method} ${route} ${kind}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}
