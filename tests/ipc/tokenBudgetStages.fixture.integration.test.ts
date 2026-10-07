/**
 * Integration test: Token Budget stage prompts against a loopback Anthropic fixture (#5286).
 *
 * Drives real IPC → AgentSession → TurnRequestBuilder → StreamManager against a loopback
 * Anthropic Messages SSE endpoint, so it costs nothing and needs no key. The fixture answers
 * "read N files" with file_read calls over generated workspace files, answers any request whose
 * last user text carries a Token Budget warning with a memory write to the session checkpoint,
 * and answers everything else (tool results, "Continue", side requests) with short text.
 *
 * The fixture reports provider usage through a per-test function of the request size. That is the
 * gap under test: stage prompts must be decided from the built request's estimate (E), not from
 * saved provider usage, or they are published and then refused at the ceiling (#5286).
 *
 * Numbers (limit 100,000): hard ceiling C = 91,808, final point F = 81,616, slider 70 → handoff
 * point H = 70,000. Measured with these fixtures: E ≈ 43.8k for the first request (system prompt
 * and tool schemas), and each "read 4 files" turn adds ≈ 15.7k, so the third turn starts at
 * E ≈ 75k, inside the handoff band.
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createConfigStores } from "@/node/config";
import { ServiceContainer } from "../../src/node/services/serviceContainer";
import { EXPERIMENT_IDS } from "../../src/common/constants/experiments";
import { createOrpcTestClient } from "./orpcTestClient";
import {
  preloadTestModules,
  setupProviders,
  setupWorkspaceWithoutProvider,
  shouldRunIntegrationTests,
} from "./setup";
import { readChatHistory, sendMessage } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const MODEL = "anthropic:claude-opus-5-5";
const CONTEXT_LIMIT = 100_000;
const TEST_TIMEOUT_MS = 180_000;
/** Start of every warning row's text (buildBudgetWarningText); the lead-in never contains it. */
const WARNING_MARKER = "Context budget ~";
const CHECKPOINT_PATH = "/memories/session/checkpoint.md";
const NOTE_FILES = 40;

interface Block {
  type: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}
interface FixtureRequest {
  chars: number;
  main: boolean;
  messages: { role: string; blocks: Block[] }[];
  lastUserText: string;
}
type Reply =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** Provider usage as a function of the raw request size; ≈2.4 request chars per counted token. */
type UsageFor = (requestChars: number) => number;

function sse(blocks: Reply[], inputTokens: number): string {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 },
        },
      },
    ],
  ];
  blocks.forEach((block, index) => {
    const start = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
    const delta =
      block.type === "text"
        ? { type: "text_delta", text: block.text }
        : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
    events.push([
      "content_block_start",
      { type: "content_block_start", index, content_block: start },
    ]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  const stopReason = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 20 },
    },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function textOf(blocks: Block[]): string {
  return blocks
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n");
}

async function startFixture(usageFor: UsageFor) {
  const requests: FixtureRequest[] = [];
  let nextFile = 0;
  let nextCall = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) {
        res.writeHead(404).end();
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as {
        stream?: boolean;
        tools?: { name: string }[];
        messages: { role: string; content: string | Block[] }[];
      };
      const messages = body.messages.map((message) => ({
        role: message.role,
        blocks:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content,
      }));
      const last = messages.at(-1)?.blocks ?? [];
      // Main turns carry the agent toolset; side requests (naming, status) do not.
      const main = (body.tools ?? []).some((tool) => tool.name === "file_read");
      const request = { chars: raw.length, main, messages, lastUserText: textOf(last) };
      requests.push(request);
      let reply: Reply[] = [{ type: "text", text: "Done." }];
      const toolResults = last.filter((block) => block.type === "tool_result");
      if (main && toolResults.length === 0 && request.lastUserText.includes(WARNING_MARKER)) {
        reply = [
          {
            type: "tool_use",
            id: `toolu_mem_${nextCall++}`,
            name: "memory",
            input: {
              command: "create",
              path: CHECKPOINT_PATH,
              file_text: "Goal: read the notes. Next: continue.",
            },
          },
        ];
      } else if (main && toolResults.length === 0) {
        const count = Number(/read (\d+) files/.exec(request.lastUserText)?.[1] ?? 0);
        if (count > 0)
          reply = Array.from({ length: count }, () => ({
            type: "tool_use" as const,
            id: `toolu_read_${nextCall++}`,
            name: "file_read",
            input: { path: `notes/file-${nextFile++}.txt` },
          }));
      }
      const inputTokens = usageFor(raw.length);
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 1 },
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(reply, inputTokens));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Text of about `tokens` counted tokens (measured ≈2.9 chars per token for these lines). */
function filler(label: string, tokens: number): string {
  const lines: string[] = [];
  for (let line = 0; lines.join("\n").length < tokens * 2.9; line++)
    lines.push(
      `${label} line ${line}: the deploy step ${(line * 17) % 97} finished with status ok after ${(line * 13) % 60} seconds.`
    );
  return lines.join("\n");
}

interface HistoryRow {
  id: string;
  role: string;
  parts: { type: string; text?: string; toolCallId?: string }[];
  metadata?: {
    contextBoundaryKind?: string;
    muxMetadata?: { type?: string; handoff?: boolean; final?: boolean; contextTokens?: number };
  };
}
const isWarning = (row: HistoryRow) => row.metadata?.muxMetadata?.type === "context-budget-warning";
const isReset = (row: HistoryRow) => row.metadata?.contextBoundaryKind === "reset";

async function startScenario(options: { slider: number; usageFor: UsageFor }) {
  const fixture = await startFixture(options.usageFor);
  // No-provider setup clears inherited Anthropic env auth/base URL; the fixture is the only route.
  const { env, workspaceId, workspacePath, cleanup } =
    await setupWorkspaceWithoutProvider("tbstages");
  await setupProviders(env, { anthropic: { apiKey: "fixture-key", baseUrl: fixture.baseUrl } });
  const models = await env.orpc.providers.setModels({
    provider: "anthropic",
    models: [{ id: "claude-opus-5-5", contextWindowTokens: CONTEXT_LIMIT }],
  });
  expect(models.success).toBe(true);
  await env.services.experimentsService.setOverride(EXPERIMENT_IDS.TOKEN_BUDGET, true);
  await env.services.experimentsService.setOverride(EXPERIMENT_IDS.MEMORY, true);
  // The slider is persisted per model in config.json, as Settings writes it.
  await env.config.editConfig((config) => ({
    ...config,
    userPreferences: {
      ...config.userPreferences,
      ai: {
        ...config.userPreferences?.ai,
        autoCompactionThresholdByModel: { [MODEL]: options.slider },
      },
    },
  }));
  await fs.mkdir(path.join(workspacePath, "notes"));
  for (let file = 0; file < NOTE_FILES; file++)
    await fs.writeFile(
      path.join(workspacePath, "notes", `file-${file}.txt`),
      filler(`File ${file}`, 2_750)
    );

  return {
    env,
    fixture,
    workspacePath,
    /** Sends one user message and waits until the session (and any queued follow-up) is idle. */
    async send(text: string) {
      const result = await sendMessage(env, workspaceId, text, {
        model: MODEL,
        thinkingLevel: "off",
        experiments: { tokenBudget: true, memory: true },
      });
      expect(result).toEqual({ success: true, data: undefined });
      await env.services.workspaceService.getOrCreateSession(workspaceId).waitForIdle();
    },
    /** Full history: a rollover moves the sealed window to chat-archive.jsonl (HistoryService). */
    async history(): Promise<HistoryRow[]> {
      const archivePath = path.join(env.tempDir, "sessions", workspaceId, "chat-archive.jsonl");
      const archive = (await fs.readFile(archivePath, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as HistoryRow);
      const active = (await readChatHistory(env.tempDir, workspaceId)) as unknown as HistoryRow[];
      return [...archive, ...active];
    },
    /** Main requests whose last user text carries a warning row. */
    stageRequests: () =>
      fixture.requests.filter((r) => r.main && r.lastUserText.includes(WARNING_MARKER)),
    /** A full backend restart on the same root: new ServiceContainer, sessions rebuilt from disk. */
    async restart() {
      await env.services.dispose();
      await env.services.shutdown();
      env.services = new ServiceContainer(createConfigStores(env.tempDir));
      await env.services.initialize();
      env.services.windowService.setMainWindow(env.mockWindow);
      env.orpc = createOrpcTestClient(env.services.toORPCContext());
    },
    async close() {
      try {
        await cleanup();
      } finally {
        await fixture.close();
      }
    },
  };
}

type Scenario = Awaited<ReturnType<typeof startScenario>>;

/** Saved usage stays far below every stage point; only the request estimate crosses them. */
const LOW_USAGE: UsageFor = () => 1_000;

describeIntegration("Token Budget stages (loopback fixture)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  describe("estimate-only crossing (R2a)", () => {
    let scenario: Scenario;
    beforeAll(async () => {
      scenario = await startScenario({ slider: 70, usageFor: LOW_USAGE });
      for (const turn of [0, 1, 2]) await scenario.send(`Turn ${turn}: read 4 files.`);
    }, TEST_TIMEOUT_MS);
    afterAll(async () => {
      await scenario?.close();
    });

    test("publishes the handoff from the request estimate and the checkpoint write runs", async () => {
      // Settlement schedules in provider terms (1,000 tokens), so only turn start can see E ≥ H.
      const stage = scenario.stageRequests();
      expect(stage).toHaveLength(1);
      expect(stage[0].lastUserText).toContain("Turn 2: read 4 files.");
      const memoryResult = scenario.fixture.requests
        .flatMap((r) => r.messages.at(-1)?.blocks ?? [])
        .find(
          (block) => block.type === "tool_result" && block.tool_use_id?.startsWith("toolu_mem_")
        );
      expect(JSON.stringify(memoryResult?.content)).toContain('\\"success\\":true');
      const history = await scenario.history();
      const warnings = history.filter(isWarning);
      expect(warnings.map((row) => row.metadata?.muxMetadata?.handoff)).toEqual([true]);
      // E crossed H (70,000) but stayed below the hard ceiling (91,808): the turn was not refused.
      const estimate = warnings[0].metadata?.muxMetadata?.contextTokens ?? 0;
      expect(estimate).toBeGreaterThanOrEqual(70_000);
      expect(estimate).toBeLessThan(91_808);
      expect(history.some(isReset)).toBe(false);
    });

    test("the stage request matches persisted history through the warning row, in order", async () => {
      const [stage] = scenario.stageRequests();
      expect(stage).toBeDefined();
      const history = await scenario.history();
      const warningIndex = history.findIndex(isWarning);
      // History order is [..., user, warning, assistant]: the warning follows its turn's user row.
      expect(history.slice(warningIndex - 1, warningIndex + 2).map((row) => row.role)).toEqual([
        "user",
        "user",
        "assistant",
      ]);
      const persisted = history.slice(0, warningIndex + 1);
      // Tool calls: the same ids in the same order as persisted.
      const persistedCalls = persisted.flatMap((row) =>
        row.parts.flatMap((part) => (part.toolCallId ? [part.toolCallId] : []))
      );
      const requestCalls = stage.messages.flatMap((message) =>
        message.blocks.flatMap((block) => (block.type === "tool_use" && block.id ? [block.id] : []))
      );
      expect(requestCalls).toEqual(persistedCalls);
      // User text: every persisted user row, the warning last, appears in the request in order.
      const requestText = stage.messages
        .filter((message) => message.role === "user")
        .map((message) => textOf(message.blocks))
        .join("\n");
      let cursor = 0;
      for (const row of persisted.filter((r) => r.role === "user")) {
        const text = textOf(row.parts as Block[]);
        const at = requestText.indexOf(text, cursor);
        expect({ text: text.slice(0, 40), found: at >= 0 }).toEqual({
          text: text.slice(0, 40),
          found: true,
        });
        cursor = at + text.length;
      }
      // Nothing after the warning row: the request ends with it.
      expect(requestText.slice(cursor).trim()).toBe("");
    });
  });

  test(
    "realistic usage gap (R2b): no warning row is followed by a rollover without a reply",
    async () => {
      // E/usage ≈ 1.5, as when provider usage trails the full request estimate.
      const scenario = await startScenario({
        slider: 70,
        usageFor: (chars) => Math.round(chars / 3.6),
      });
      try {
        await scenario.send("Turn 0: read 4 files.");
        await scenario.send("Turn 1: read 4 files.");
        // A large paste takes E past the ceiling while saved usage plus the paste reads only ~74k.
        await scenario.send(`Turn 2: read 0 files. Pasted deploy log:\n${filler("Paste", 25_000)}`);
        const history = await scenario.history();
        // The ceiling was reached (non-vacuous): the paste rolled the window over.
        expect(history.some(isReset)).toBe(true);
        const unanswered = history.flatMap((row, index) => {
          if (!isWarning(row)) return [];
          const next = history.slice(index + 1).find((r) => r.role === "assistant");
          return next == null || isReset(next) ? [row.id] : [];
        });
        expect(unanswered).toEqual([]);
      } finally {
        await scenario.close();
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "instruction growth: no warning when the row and its reserve no longer fit, and the turn runs",
    async () => {
      // Usage tracks E here, so an old usage-based decision would also open the handoff stage.
      const scenario = await startScenario({
        slider: 70,
        usageFor: (chars) => Math.round(chars / 2.4),
      });
      try {
        await scenario.send("Turn 0: read 4 files.");
        await scenario.send("Turn 1: read 4 files.");
        // Grow AGENTS.md so E ≈ 90.8k: below C (91,808), but E′ + 2,048 ≥ C. The assertions bracket
        // the band: less growth publishes a warning, more is refused and rolls the window over.
        await fs.writeFile(
          path.join(scenario.workspacePath, "AGENTS.md"),
          filler("Instruction", 15_300)
        );
        await scenario.send("Turn 2: read 0 files.");
        const history = await scenario.history();
        expect(history.filter(isWarning)).toEqual([]);
        expect(scenario.stageRequests()).toEqual([]);
        expect(history.some(isReset)).toBe(false);
        // The turn was dispatched and answered, not refused.
        const last = history.at(-1);
        expect(last?.role).toBe("assistant");
        expect(textOf((last?.parts ?? []) as Block[])).toContain("Done.");
      } finally {
        await scenario.close();
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "after a restart the next send decides from its own estimate and does not repeat the handoff",
    async () => {
      const scenario = await startScenario({ slider: 70, usageFor: LOW_USAGE });
      try {
        for (const turn of [0, 1, 2]) await scenario.send(`Turn ${turn}: read 4 files.`);
        expect((await scenario.history()).filter(isWarning)).toHaveLength(1);
        await scenario.restart();
        // E ≈ 84k after restart: inside the final band [81,616, C − 4,048), handoff already claimed.
        await fs.writeFile(
          path.join(scenario.workspacePath, "AGENTS.md"),
          filler("Instruction", 7_500)
        );
        await scenario.send("Turn 3: read 0 files.");
        const warnings = (await scenario.history()).filter(isWarning);
        expect(
          warnings.map(({ metadata }) => [
            metadata?.muxMetadata?.handoff,
            metadata?.muxMetadata?.final,
          ])
        ).toEqual([
          [true, undefined],
          [undefined, true],
        ]);
        expect(warnings[1].metadata?.muxMetadata?.contextTokens).toBeGreaterThanOrEqual(81_616);
        expect(scenario.stageRequests().at(-1)?.lastUserText).toContain("Turn 3: read 0 files.");
      } finally {
        await scenario.close();
      }
    },
    TEST_TIMEOUT_MS
  );
});
