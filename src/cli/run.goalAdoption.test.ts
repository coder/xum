/**
 * End-to-end tests for plain `xum run` goal adoption (#5356).
 *
 * Each test spawns the real CLI against a loopback OpenAI-compatible fixture
 * that plays a scripted model. A plain run (no `--goal`) whose model calls
 * `set_goal` must adopt that goal and drive it like `--goal`, with the same
 * exit codes; a run whose model never sets a goal must not change.
 */
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";

const BUN_EXECUTABLE = process.execPath;
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");
const MOCK_PROVIDER = "local-mock";
const MOCK_MODEL = "mock-model";

type Scenario = "complete" | "no-goal" | "turn-cap";

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

interface ChatRequest {
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

interface RunResult {
  exitCode: number;
  events: Array<Record<string, unknown> & { type: string }>;
  stdout: string;
  stderr: string;
  /** Requests that carried the agent tool set (main-turn model calls). */
  agentRequests: number;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1,
    model: MOCK_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(response: http.ServerResponse, chunks: Array<Record<string, unknown>>): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeText(response: http.ServerResponse, text: string): void {
  writeSse(response, [chunk({ role: "assistant", content: text }), chunk({}, "stop")]);
}

function writeToolCall(response: http.ServerResponse, name: string, args: unknown): void {
  writeSse(response, [
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call-${name}-${Date.now()}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ]);
}

async function runScenario(scenario: Scenario): Promise<RunResult> {
  using tmp = new DisposableTempDir(`run-goal-adoption-${scenario}`);
  const repo = path.join(tmp.path, "repo");
  const xumRoot = path.join(tmp.path, "xum-root");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(xumRoot, { recursive: true });

  let agentRequests = 0;
  const handlerErrors: unknown[] = [];
  const fixture = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (data: Buffer) => chunks.push(data));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
        const toolNames = new Set((body.tools ?? []).map((tool) => tool.function?.name));
        // Side requests (titles, status proposals) do not carry the agent tool set.
        if (!toolNames.has("set_goal")) {
          writeText(response, "ok");
          return;
        }
        agentRequests += 1;
        const messages = body.messages ?? [];
        const last = messages.at(-1);
        if (last?.role === "tool") {
          writeText(response, "Done with this step.");
          return;
        }
        const goalWasSet = messages.some((message) =>
          message.tool_calls?.some((call) => call.function?.name === "set_goal")
        );
        if (!goalWasSet) {
          if (scenario === "no-goal") {
            writeText(response, "Answered without a goal.");
            return;
          }
          writeToolCall(response, "set_goal", {
            objective: "Finish the scripted fixture goal",
            turnCap: scenario === "turn-cap" ? 1 : 5,
          });
          return;
        }
        // An automatic goal turn (continuation or budget wrap-up).
        if (scenario === "complete") {
          writeToolCall(response, "complete_goal", { summary: "Fixture goal verified." });
          return;
        }
        // A tool call keeps the turn from counting as a silent (auto-completing) continuation.
        writeToolCall(response, "get_goal", {});
      } catch (error) {
        handlerErrors.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    await fs.writeFile(
      path.join(xumRoot, "providers.jsonc"),
      JSON.stringify({
        [MOCK_PROVIDER]: {
          providerType: "openai-compatible",
          baseUrl: `${origin}/v1`,
          // Model-created goals need a priced model; borrow a catalog model's pricing.
          models: [{ id: MOCK_MODEL, mappedToModel: "anthropic:claude-haiku-4-5" }],
        },
      }),
      "utf-8"
    );
    const run =
      await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} run --dir ${repo} --model ${`${MOCK_PROVIDER}:${MOCK_MODEL}`} --json ${`Scenario ${scenario}`}`
        .env({
          ...process.env,
          XUM_ROOT: xumRoot,
          MUX_ROOT: xumRoot,
          NO_COLOR: "1",
        })
        .nothrow()
        .quiet();
    expect(handlerErrors).toEqual([]);
    const stdout = run.stdout.toString();
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
    return {
      exitCode: run.exitCode,
      events,
      stdout,
      stderr: run.stderr.toString(),
      agentRequests,
    };
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}

function eventTypes(result: RunResult): string[] {
  return result.events.map((event) => event.type).filter((type) => type.startsWith("goal-"));
}

function runComplete(result: RunResult) {
  return result.events.find((event) => event.type === "run-complete");
}

describe("plain xum run adopts a model-created goal", () => {
  test("drives the goal to completion and exits 0", async () => {
    const result = await runScenario("complete");
    expect(result.stderr).not.toContain("Error");
    expect(eventTypes(result)).toEqual(["goal-adopted", "goal-continuing", "goal-completed"]);
    expect(runComplete(result)).toMatchObject({ goal: { status: "complete" } });
    expect(result.exitCode).toBe(0);
  }, 90_000);

  test("a run whose model never sets a goal is unchanged", async () => {
    const result = await runScenario("no-goal");
    expect(eventTypes(result)).toEqual([]);
    expect(runComplete(result)).toMatchObject({ goal: null });
    expect(result.agentRequests).toBe(1);
    expect(result.exitCode).toBe(0);
  }, 90_000);

  test("ends at the goal turn cap with the --goal exit code", async () => {
    const result = await runScenario("turn-cap");
    const types = eventTypes(result);
    expect(types[0]).toBe("goal-adopted");
    expect(types.at(-1)).toBe("goal-incomplete");
    expect(result.events.find((event) => event.type === "goal-incomplete")).toMatchObject({
      status: "budget_limited",
      stopReason: "goal turn cap reached",
    });
    expect(result.exitCode).toBe(3);
  }, 90_000);
});
