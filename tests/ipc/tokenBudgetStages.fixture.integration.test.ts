/**
 * Integration test: Token Budget stage prompts against a loopback Anthropic fixture (#5286).
 *
 * Drives real IPC → AgentSession → TurnRequestBuilder → StreamManager against a loopback
 * Anthropic Messages SSE endpoint, so it costs nothing and needs no key. The fixture answers
 * "read N files" with file_read calls over generated workspace files, answers any request whose
 * last user text carries a Token Budget warning with a memory write to the session checkpoint,
 * and answers everything else (tool results, "Continue", side requests) with short text.
 *
 * The fixture reports provider usage through a per-test function of the request size. Stage
 * prompts are decided on E, the count the turn-start check enforces: the newest reply's provider
 * usage plus the messages after it (#7662), else the full estimate. Step zero counts the same
 * way, so a published prompt is never refused at the ceiling (#5286).
 *
 * Numbers (limit 100,000): hard ceiling C = 91,808, final point F = 81,616, slider 70 → handoff
 * point H = 70,000. Measured with these fixtures and the real tokenizer: the system prompt and
 * tool schemas count ≈ 43.8k once padded (below), and each file read adds ≈ 3.9k, so after two
 * "read 4 files" turns the third turn starts at E ≈ 73k, inside the handoff band.
 *
 * The system prompt also lists global skills and instructions found under HOME, so the first E
 * differs between machines (≈ 25k with an empty HOME, as in CI). After the first turn each
 * scenario pads the workspace scratchpad up to CALIBRATED_FIRST_ESTIMATE, so every later E stays
 * within about 1k of the measured bands. The pad and the later growth go in the scratchpad, not
 * AGENTS.md: inside a context segment an AGENTS.md change is sent as a row with the whole new
 * block while the system prompt keeps the old one (prompt-cache mechanism 10), so it would grow
 * E by more than its own size.
 */

import assert from "node:assert/strict";
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
import * as contextBudgetCounting from "../../src/node/services/contextBudgetCounting";
import { writeAdditionalSystemContext } from "../../src/node/services/additionalSystemContext";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const PRIMARY_MODEL_ID = "claude-opus-5-5";
const MODEL = `anthropic:${PRIMARY_MODEL_ID}`;
const FALLBACK_MODEL_ID = "claude-sonnet-5-5";
const FALLBACK_MODEL = `anthropic:${FALLBACK_MODEL_ID}`;
const CONTEXT_LIMIT = 100_000;
/** Text that makes the fixture refuse a primary request (stop_reason "refusal", no output). */
const REFUSE_MARKER = "[refuse]";
const TEST_TIMEOUT_MS = 180_000;
/** Start of every warning row's text (buildBudgetWarningText); the lead-in never contains it. */
const WARNING_MARKER = "Context budget ~";
const CHECKPOINT_PATH = "/memories/session/checkpoint.md";
const NOTE_FILES = 40;
/** First-request E that each scenario is padded to; the bands in this file were measured from it. */
const CALIBRATED_FIRST_ESTIMATE = 43_800;

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
  model: string;
  messages: { role: string; blocks: Block[] }[];
  lastUserText: string;
}
type Reply =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** Provider usage as a function of the raw request size; ≈2.4 request chars per counted token. */
type UsageFor = (requestChars: number) => number;

function sse(blocks: Reply[], inputTokens: number, refused = false): string {
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
  const stopReason = refused
    ? "refusal"
    : blocks.some((block) => block.type === "tool_use")
      ? "tool_use"
      : "end_turn";
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
        model: string;
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
      const request = {
        chars: raw.length,
        main,
        model: body.model,
        messages,
        lastUserText: textOf(last),
      };
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
      // The primary refuses any request whose last user text asks it to (no output).
      const refused =
        main && body.model === PRIMARY_MODEL_ID && request.lastUserText.includes(REFUSE_MARKER);
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(sse(refused ? [] : reply, inputTokens, refused));
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
    modelFallback?: { refusedModels?: string[] };
    muxMetadata?: { type?: string; handoff?: boolean; final?: boolean; contextTokens?: number };
  };
}
const isWarning = (row: HistoryRow) => row.metadata?.muxMetadata?.type === "context-budget-warning";
const isReset = (row: HistoryRow) => row.metadata?.contextBoundaryKind === "reset";

/** Observes (does not change) each full count; a send's first one is its turn-start E. */
const fullCounts = jest.spyOn(contextBudgetCounting, "measureAssembledRequestBudgetForModel");

async function startScenario(options: {
  slider: number;
  usageFor: UsageFor;
  /** Primary window, and a refusal fallback to FALLBACK_MODEL with a CONTEXT_LIMIT window. */
  refusalFallback?: { primaryLimit: number };
}) {
  const fixture = await startFixture(options.usageFor);
  // No-provider setup clears inherited Anthropic env auth/base URL; the fixture is the only route.
  const { env, workspaceId, workspacePath, cleanup } =
    await setupWorkspaceWithoutProvider("tbstages");
  await setupProviders(env, { anthropic: { apiKey: "fixture-key", baseUrl: fixture.baseUrl } });
  const models = await env.orpc.providers.setModels({
    provider: "anthropic",
    models: [
      {
        id: PRIMARY_MODEL_ID,
        contextWindowTokens: options.refusalFallback?.primaryLimit ?? CONTEXT_LIMIT,
      },
      { id: FALLBACK_MODEL_ID, contextWindowTokens: CONTEXT_LIMIT },
    ],
  });
  expect(models.success).toBe(true);
  if (options.refusalFallback)
    await env.orpc.config.updateModelFallbacks({
      modelFallbacks: { [MODEL]: { models: [FALLBACK_MODEL] } },
    });
  await env.services.experimentsService.setOverride(EXPERIMENT_IDS.TOKEN_BUDGET, true);
  await env.services.experimentsService.setOverride(EXPERIMENT_IDS.MEMORY, true);
  // The slider is persisted per model in config.json, as Settings writes it.
  await env.config.editConfig((config) => ({
    ...config,
    userPreferences: {
      ...config.userPreferences,
      ai: {
        ...config.userPreferences?.ai,
        autoCompactionThresholdByModel: {
          [MODEL]: options.slider,
          [FALLBACK_MODEL]: options.slider,
        },
      },
    },
  }));
  await fs.mkdir(path.join(workspacePath, "notes"));
  for (let file = 0; file < NOTE_FILES; file++)
    await fs.writeFile(
      path.join(workspacePath, "notes", `file-${file}.txt`),
      filler(`File ${file}`, 2_750)
    );

  let baselinePad: string | undefined;
  const writeInstructions = (extra: string) =>
    writeAdditionalSystemContext(env.config, workspaceId, {
      content: [baselinePad ?? "", extra].filter((part) => part !== "").join("\n"),
      enabled: true,
    });

  return {
    env,
    fixture,
    workspacePath,
    /** Scratchpad content after the baseline pad; grows E from the next send on. */
    writeInstructions,
    /** Sends one user message and waits until the session (and any queued follow-up) is idle. */
    async send(text: string, model = MODEL) {
      const countsBefore = fullCounts.mock.results.length;
      const result = await sendMessage(env, workspaceId, text, {
        model,
        thinkingLevel: "off",
      });
      expect(result).toEqual({ success: true, data: undefined });
      await env.services.workspaceService.getOrCreateSession(workspaceId).waitForIdle();
      if (baselinePad !== undefined) return;
      const firstCount = fullCounts.mock.results[countsBefore]?.value as ReturnType<
        typeof contextBudgetCounting.measureAssembledRequestBudgetForModel
      >;
      const firstEstimate = (await firstCount)?.estimate;
      assert(firstEstimate != null, "Expected the first turn's turn-start count");
      const missing = CALIBRATED_FIRST_ESTIMATE - firstEstimate;
      // A HOME with more global skills than the calibration machine cannot be padded down.
      assert(missing > -500, `First E ${firstEstimate} exceeds the calibration; use an empty HOME`);
      baselinePad = missing > 0 ? filler("Baseline", missing) : "";
      await writeInstructions("");
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

/** Provider usage that tracks the full estimate, so the anchored E keeps the measured bands. */
const TRACKING_USAGE: UsageFor = (chars) => Math.round(chars / 2.4);

/** Three turns; only the last turn start crosses H (E ≈ 76.5k), and the handoff is published. */
async function sendUntilHandoff(scenario: Scenario) {
  await scenario.send("Turn 0: read 4 files.");
  // One file keeps turn 1's estimate below H, so its settlement opens no stage.
  await scenario.send("Turn 1: read 1 files.");
  await scenario.send(`Turn 2: read 4 files. Pasted deploy log:\n${filler("Paste", 14_000)}`);
}

describeIntegration("Token Budget stages (loopback fixture)", () => {
  // Rows record systemMessageTokens with the real tokenizer, as in production: the turn anchor
  // compares the sent system text against that count (#7662).
  const forceRealTokenizer = process.env.XUM_FORCE_REAL_TOKENIZER;
  beforeAll(async () => {
    process.env.XUM_FORCE_REAL_TOKENIZER = "1";
    await preloadTestModules();
  });
  afterAll(() => {
    if (forceRealTokenizer == null) delete process.env.XUM_FORCE_REAL_TOKENIZER;
    else process.env.XUM_FORCE_REAL_TOKENIZER = forceRealTokenizer;
  });

  describe("turn-start crossing (R2a)", () => {
    let scenario: Scenario;
    beforeAll(async () => {
      scenario = await startScenario({ slider: 70, usageFor: TRACKING_USAGE });
      await sendUntilHandoff(scenario);
    }, TEST_TIMEOUT_MS);
    afterAll(async () => {
      await scenario?.close();
    });

    test("publishes the handoff from the request estimate and the checkpoint write runs", async () => {
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
    "realistic usage gap (R2b): a warning decided on the provider count is answered, not refused",
    async () => {
      // E/usage ≈ 1.5, as when provider usage trails the full request estimate. E follows the
      // provider count (#7662), and step zero counts the same way.
      const scenario = await startScenario({
        slider: 70,
        usageFor: (chars) => Math.round(chars / 3.6),
      });
      try {
        await scenario.send("Turn 0: read 4 files.");
        await scenario.send("Turn 1: read 4 files.");
        // Saved usage plus the paste reads ≈76k, inside the handoff band.
        await scenario.send(`Turn 2: read 0 files. Pasted deploy log:\n${filler("Paste", 25_000)}`);
        const history = await scenario.history();
        expect(history.filter(isWarning).map((row) => row.metadata?.muxMetadata?.handoff)).toEqual([
          true,
        ]);
        // Non-vacuous: the full estimate (≈2.4 request chars per token) of the sent stage request
        // is past the hard ceiling, so a full count at step zero would have refused it.
        const [stage] = scenario.stageRequests();
        expect(stage.chars / 2.4).toBeGreaterThan(91_808);
        expect(history.some(isReset)).toBe(false);
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
      const scenario = await startScenario({ slider: 70, usageFor: TRACKING_USAGE });
      try {
        await scenario.send("Turn 0: read 4 files.");
        // One file keeps turn 1's estimate below H, so its settlement opens no stage (#5223).
        await scenario.send("Turn 1: read 1 files.");
        // Grow the instructions so E ≈ 90.6k: below C (91,808), but E′ + 2,048 ≥ C. The assertions bracket
        // the band: less growth publishes a warning, more is refused and rolls the window over.
        await scenario.writeInstructions(filler("Instruction", 29_400));
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
      const scenario = await startScenario({ slider: 70, usageFor: TRACKING_USAGE });
      try {
        await sendUntilHandoff(scenario);
        expect((await scenario.history()).filter(isWarning)).toHaveLength(1);
        await scenario.restart();
        // E ≈ 84k after restart: inside the final band [81,616, C − 4,048), handoff already claimed.
        await scenario.writeInstructions(filler("Instruction", 5_500));
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

  test(
    "a refusal fallback with a stage due is sent without one, and the next turn start offers it once",
    async () => {
      // The primary's window (200k, H = 140k) has no stage due at E ≈ 73k. The fallback's window
      // (100k, H = 70k) does. The fallback request is sent as built, with no stage decision: the
      // warning cannot sit before the turn's placeholder row, and a handover would need a new
      // mechanism (#5286). The stage comes at the next turn start that reaches it, one turn late.
      const scenario = await startScenario({
        slider: 70,
        usageFor: TRACKING_USAGE,
        refusalFallback: { primaryLimit: 200_000 },
      });
      try {
        await scenario.send("Turn 0: read 4 files.");
        await scenario.send("Turn 1: read 4 files.");
        await scenario.send(`Turn 2: read 0 files. ${REFUSE_MARKER}`);
        const fallbackRequests = () =>
          scenario.fixture.requests.filter((r) => r.main && r.model === FALLBACK_MODEL_ID);
        expect(fallbackRequests().map((r) => r.lastUserText.includes(REFUSE_MARKER))).toEqual([
          true,
        ]);
        expect(scenario.stageRequests()).toEqual([]);
        let history = await scenario.history();
        expect(history.filter(isWarning)).toEqual([]);
        expect(history.some((row) => textOf(row.parts as Block[]) === "Continue")).toBe(false);
        const answered = history.at(-1);
        expect(answered?.metadata?.modelFallback?.refusedModels).toEqual([MODEL]);
        expect(textOf((answered?.parts ?? []) as Block[])).toContain("Done.");

        // The user goes on with the model that answered: its turn start decides the stage on its
        // own built request and publishes the handoff warning once.
        await scenario.send("Turn 3: read 0 files.", FALLBACK_MODEL);
        history = await scenario.history();
        const warnings = history.filter(isWarning);
        expect(warnings.map((row) => row.metadata?.muxMetadata?.handoff)).toEqual([true]);
        expect(scenario.stageRequests().map((r) => r.model)).toEqual([FALLBACK_MODEL_ID]);
        expect(scenario.stageRequests()[0]?.lastUserText).toContain("Turn 3: read 0 files.");
      } finally {
        await scenario.close();
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a rollover whose first request is past the handoff point publishes the warning in the new window",
    async () => {
      const scenario = await startScenario({ slider: 70, usageFor: TRACKING_USAGE });
      try {
        await scenario.send("Turn 0: read 4 files.");
        // Two files keep turn 1's estimate below H, so the old window publishes no stage.
        await scenario.send("Turn 1: read 2 files.");
        // The paste takes the old window past C, so the send rolls it over. The fresh window's
        // own first request (system prompt, lead-in, paste) is past H (70k) and still has room
        // for the row and its reserve below C (#7215).
        await scenario.send(`Turn 2: read 0 files. Pasted deploy log:\n${filler("Paste", 30_000)}`);
        const history = await scenario.history();
        const reset = history.findLastIndex(isReset);
        expect(reset).toBeGreaterThanOrEqual(0);
        const window = history.slice(reset);
        const user = window.findIndex((row) => textOf(row.parts as Block[]).includes("Pasted"));
        expect(user).toBeGreaterThan(0);
        // The warning follows the copied user row, and the request that was sent carries it.
        const warning = window[user + 1];
        expect(warning && isWarning(warning)).toBe(true);
        expect(warning?.metadata?.muxMetadata?.handoff).toBe(true);
        const stage = scenario.stageRequests();
        expect(stage).toHaveLength(1);
        expect(stage[0]?.messages.some((m) => textOf(m.blocks).includes("Pasted"))).toBe(true);
        // The new window's request is the one with the warning: nothing sealed sits before it.
        expect(stage[0]?.messages.some((m) => textOf(m.blocks).includes("Turn 0"))).toBe(false);
      } finally {
        await scenario.close();
      }
    },
    TEST_TIMEOUT_MS
  );
});
