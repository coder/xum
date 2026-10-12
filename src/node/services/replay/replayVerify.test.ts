/**
 * Behavior tests for replayVerifySession's pairing and failure isolation:
 * compacted histories, missing assistant rows, devtools toggling, retries,
 * corrupted turns, and the turn-envelope round-trip of request-time inputs
 * (plan-transition content, post-compaction attachments, per-send cache TTL).
 *
 * Sessions are generated in temp dirs through the same fixture harness the
 * committed golden fixture uses (appendReplayFixtureTurn), so the recorded
 * requests mirror the production pipeline's bytes.
 */

import * as fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { DevToolsStep } from "@/common/types/devtools";
import { createMuxMessage } from "@/common/types/message";
import { TOOL_SEARCH_TOOL_NAME } from "@/common/utils/tools/toolCatalog";
import { DisposableTempDir } from "@/node/services/tempDir";
import { emitTurnEnvelope } from "@/node/services/turnEnvelope";
import {
  appendReplayFixtureCompactionBoundary,
  appendReplayFixtureTurn,
  createReplayFixtureSessionContext,
  flushReplayFixtureDevtools,
  REPLAY_FIXTURE_MODEL,
  type ReplayFixtureSessionContext,
} from "./replayFixture";
import {
  collectFullHistory,
  readRecordedSteps,
  replayVerifySession,
  type ReplayVerifySessionResult,
} from "./replayVerify";

const SYSTEM_PROMPT = "You are a temp replay session agent.";

function tools(): Record<string, Tool> {
  return {
    file_read: tool({
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
    }),
  };
}

async function verify(ctx: ReplayFixtureSessionContext): Promise<ReplayVerifySessionResult> {
  await flushReplayFixtureDevtools(ctx);
  const historyResult = await collectFullHistory(ctx.historyService, ctx.workspaceId);
  if (!historyResult.success) {
    throw new Error(`history read failed: ${historyResult.error}`);
  }
  return replayVerifySession({
    sessionDir: ctx.sessionDir,
    workspaceId: ctx.workspaceId,
    historyMessages: historyResult.data,
  });
}

describe("replayVerifySession pairing", () => {
  test("verifies turns across a compaction boundary from the full history", async () => {
    using tmp = new DisposableTempDir("replay-verify-compaction");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "Before compaction.",
      assistantText: "Answer one.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    await appendReplayFixtureCompactionBoundary(ctx, "Summary of the session so far.", 1);
    await appendReplayFixtureTurn(ctx, {
      userText: "After compaction.",
      assistantText: "Answer two.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      // Post-compaction attachments are injected into the request and must be
      // reconstructible from the envelope blob alone.
      postCompactionAttachments: [
        {
          type: "plan_file_reference",
          planFilePath: "/tmp/plan.md",
          planContent: "1. do the thing",
        },
      ],
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => ({ status: turn.status, reason: turn.reason }))).toEqual([
      { status: "PASS", reason: undefined },
      { status: "PASS", reason: undefined },
    ]);

    // Guard against a vacuous pass: the injected attachment content must
    // actually be model-visible in the recorded request.
    const devtoolsRaw = ctx.devtoolsLines.join("\n");
    expect(devtoolsRaw).toContain("1. do the thing");
  });

  test("the prefix rule checks every recorded step, not only each turn's first", async () => {
    using tmp = new DisposableTempDir("replay-verify-step-prefix");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    for (const userText of ["First.", "Second."]) {
      await appendReplayFixtureTurn(ctx, {
        userText,
        assistantText: "Done.",
        systemPrompt: SYSTEM_PROMPT,
        tools: tools(),
      });
    }
    // Record a tool step inside turn 1 that chat.jsonl does not keep, so the
    // turn 2 rebuild drops it: each run's first request still verifies, but
    // turn 2 no longer extends turn 1's last step.
    const [, firstStepLine] = ctx.devtoolsLines;
    const firstStep = (JSON.parse(firstStepLine) as { step: DevToolsStep }).step;
    const firstPrompt = firstStep.input?.prompt as unknown[];
    const toolCall = { type: "tool-call", toolCallId: "t1", toolName: "bash", input: {} };
    // Insert it where it was sent: after turn 1's first step, before turn 2's run.
    ctx.devtoolsLines.splice(
      2,
      0,
      JSON.stringify({
        type: "step",
        step: {
          ...firstStep,
          id: "step-1b",
          stepNumber: 1,
          input: {
            ...firstStep.input,
            prompt: [...firstPrompt, { role: "assistant", content: [toolCall] }],
          },
        },
      })
    );

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["PASS", "PASS"]);
    expect(result.stepPrefix.comparedPairs).toBe(2);
    expect(result.stepPrefix.breaks).toMatchObject([
      {
        runId: "run-2",
        stepNumber: 0,
        boundary: "turn",
        comparison: {
          section: "messages",
          previous: { role: "assistant", type: "tool-call", toolName: "bash" },
          next: { role: "assistant", type: "text" },
        },
      },
    ]);
  });

  test("the step audit keeps the log order of overlapping runs", async () => {
    using tmp = new DisposableTempDir("replay-verify-step-order");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    for (const userText of ["First.", "Second."]) {
      await appendReplayFixtureTurn(ctx, {
        userText,
        assistantText: "Done.",
        systemPrompt: SYSTEM_PROMPT,
        tools: tools(),
      });
    }
    // Run 1 sends a later step after run 2 started: the log order is A0, B0, A1.
    const [, firstStepLine] = ctx.devtoolsLines;
    const firstStep = (JSON.parse(firstStepLine) as { step: DevToolsStep }).step;
    ctx.devtoolsLines.push(
      JSON.stringify({ type: "step", step: { ...firstStep, id: "step-1b", stepNumber: 1 } })
    );
    await flushReplayFixtureDevtools(ctx);

    const steps = await readRecordedSteps(ctx.sessionDir);
    expect(steps.map((step) => `${step.runId}:${step.stepNumber}`)).toEqual([
      "run-1:0",
      "run-2:0",
      "run-1:1",
    ]);
  });

  test("a compact-agent turn without a compaction request row is skipped", async () => {
    using tmp = new DisposableTempDir("replay-verify-compact-agent");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    await appendReplayFixtureTurn(ctx, {
      userText: "First.",
      assistantText: "Done.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    // The resume path runs the compact agent (another system prompt) with no request row.
    await appendReplayFixtureTurn(ctx, {
      userText: "Summarize.",
      assistantText: "Summary.",
      agentId: "compact",
      systemPrompt: "You are running a compaction pass.",
      tools: tools(),
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Next.",
      assistantText: "Done.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    const result = await verify(ctx);
    // The compact run is skipped and resets the baseline, so nothing is compared or broken.
    expect(result.stepPrefix).toMatchObject({ comparedPairs: 0, breaks: [] });
  });

  test("a headless run without a request sequence is skipped by the step audit", async () => {
    using tmp = new DisposableTempDir("replay-verify-headless");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    for (const userText of ["First.", "Second."]) {
      await appendReplayFixtureTurn(ctx, {
        userText,
        assistantText: "Done.",
        systemPrompt: SYSTEM_PROMPT,
        tools: tools(),
      });
    }
    // A side call (for example a branch summary) logs its own run between the turns, without a
    // request sequence and with another prompt.
    const [runLine, firstStepLine] = ctx.devtoolsLines;
    const run = (JSON.parse(runLine) as { run: { requestHistorySequence?: number } }).run;
    const step = (JSON.parse(firstStepLine) as { step: DevToolsStep }).step;
    const { requestHistorySequence: _seq, ...headlessRun } = { ...run, id: "headless-1" };
    ctx.devtoolsLines.splice(
      2,
      0,
      JSON.stringify({ type: "run", run: headlessRun }),
      JSON.stringify({
        type: "step",
        step: {
          ...step,
          id: "headless-step",
          runId: "headless-1",
          input: {
            ...step.input,
            prompt: [{ role: "user", content: [{ type: "text", text: "Summarize." }] }],
          },
        },
      })
    );

    const result = await verify(ctx);
    // The two chat runs are compared with each other; the side call breaks nothing.
    expect(result.stepPrefix).toMatchObject({ comparedPairs: 1, breaks: [] });
  });

  test("a healed duplicate run header keeps the first header and its steps", async () => {
    using tmp = new DisposableTempDir("replay-verify-duplicate-run");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    for (const userText of ["First.", "Second."]) {
      await appendReplayFixtureTurn(ctx, {
        userText,
        assistantText: "Done.",
        systemPrompt: SYSTEM_PROMPT,
        tools: tools(),
      });
    }
    // DevToolsService re-appends a header without the run metadata when a retention-evicted
    // run logs another step; that step extends the run's first step.
    const [runLine, firstStepLine] = ctx.devtoolsLines;
    const run = (JSON.parse(runLine) as { run: { requestHistorySequence?: number } }).run;
    const step = (JSON.parse(firstStepLine) as { step: DevToolsStep }).step;
    const { requestHistorySequence: _seq, ...healedRun } = run;
    const prompt = step.input?.prompt as unknown[];
    ctx.devtoolsLines.splice(
      2,
      0,
      JSON.stringify({ type: "run", run: healedRun }),
      JSON.stringify({
        type: "step",
        step: {
          ...step,
          id: "step-1b",
          stepNumber: 1,
          input: {
            ...step.input,
            prompt: [...prompt, { role: "assistant", content: [{ type: "text", text: "Hm." }] }],
          },
        },
      })
    );

    const result = await verify(ctx);
    // run-1 step 0 -> run-1 step 1 -> run-2: the healed step is audited, not dropped as headless.
    expect(result.stepPrefix).toMatchObject({ auditedSteps: 3, comparedPairs: 2 });
  });

  test("a step that failed before reaching the provider is not an audited request", async () => {
    using tmp = new DisposableTempDir("replay-verify-failed-step");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    for (const userText of ["First.", "Second."]) {
      await appendReplayFixtureTurn(ctx, {
        userText,
        assistantText: "Done.",
        systemPrompt: SYSTEM_PROMPT,
        tools: tools(),
      });
    }
    // Turn 1 started a second step with another prompt that was aborted locally: the step row
    // exists, and its update records only the error.
    const [, firstStepLine] = ctx.devtoolsLines;
    const firstStep = (JSON.parse(firstStepLine) as { step: DevToolsStep }).step;
    ctx.devtoolsLines.splice(
      2,
      0,
      JSON.stringify({
        type: "step",
        step: {
          ...firstStep,
          id: "step-aborted",
          stepNumber: 1,
          input: {
            ...firstStep.input,
            prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
          },
        },
      }),
      JSON.stringify({ type: "step-update", stepId: "step-aborted", update: { error: "aborted" } })
    );

    const result = await verify(ctx);
    expect(result.stepPrefix).toMatchObject({ comparedPairs: 1, breaks: [] });
  });

  test("a turn without an assistant row skips only itself", async () => {
    using tmp = new DisposableTempDir("replay-verify-missing-assistant");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "First.",
      assistantText: "One.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    // Stream failed before appending the assistant row: envelope + recorded
    // request exist, chat.jsonl has only the user row.
    await appendReplayFixtureTurn(ctx, {
      userText: "Second (stream died).",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Third.",
      assistantText: "Three.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["PASS", "SKIPPED", "PASS"]);
    expect(result.turns[1].reason).toContain("no assistant row");
  });

  test("a turn without a recorded devtools request skips only itself", async () => {
    using tmp = new DisposableTempDir("replay-verify-devtools-off");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "First.",
      assistantText: "One.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Second (devtools off).",
      assistantText: "Two.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      recordDevtools: false,
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Third.",
      assistantText: "Three.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["PASS", "SKIPPED", "PASS"]);
    expect(result.turns[1].reason).toContain("no recorded devtools request");
  });

  test("retried attempts are superseded; the final attempt verifies", async () => {
    using tmp = new DisposableTempDir("replay-verify-retry");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "Retry me.",
      assistantText: "Done on the second attempt.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      extraEnvelopeAttempts: 1,
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["SKIPPED", "PASS"]);
    expect(result.turns[0].reason).toContain("superseded by a later attempt");
  });

  test("a corrupted turn FAILs with the error and later turns still verify", async () => {
    using tmp = new DisposableTempDir("replay-verify-corrupt-turn");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "First.",
      assistantText: "One.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    // Hand-build a turn whose envelope carries an EMPTY system prompt blob:
    // buildReplayRequest asserts on it, and the assertion must become a FAIL
    // for this turn instead of crashing the whole verification (and the CLI).
    const userMessage = createMuxMessage("user-corrupt", "user", "Corrupted turn.", {
      timestamp: 1_700_000_500_000,
    });
    const appendUser = await ctx.historyService.appendToHistory(ctx.workspaceId, userMessage);
    expect(appendUser.success).toBe(true);
    const seq = userMessage.metadata?.historySequence;
    if (seq == null) throw new Error("user row missing historySequence");
    await emitTurnEnvelope({
      journal: ctx.journal,
      workspaceId: ctx.workspaceId,
      systemMessage: "",
      tools: tools(),
      modelString: REPLAY_FIXTURE_MODEL,
      thinkingLevel: "off",
      providerOptions: { anthropic: {} },
      requestHistorySequence: seq,
      wireProviderName: "anthropic",
    });
    ctx.devtoolsLines.push(
      JSON.stringify({
        type: "run",
        run: {
          id: "run-corrupt",
          workspaceId: ctx.workspaceId,
          startedAt: new Date(1_700_000_501_000).toISOString(),
          requestHistorySequence: seq,
        },
      }),
      JSON.stringify({
        type: "step",
        step: {
          id: "step-corrupt",
          runId: "run-corrupt",
          stepNumber: 0,
          type: "stream",
          modelId: REPLAY_FIXTURE_MODEL,
          provider: "anthropic",
          startedAt: new Date(1_700_000_501_000).toISOString(),
          durationMs: 1,
          input: { prompt: [], tools: [] },
          output: null,
          usage: null,
          error: null,
          rawRequest: null,
          requestHeaders: null,
          responseHeaders: null,
          rawResponse: null,
          rawChunks: null,
        },
      })
    );
    const assistantMessage = createMuxMessage("assistant-corrupt", "assistant", "Oops.", {
      timestamp: 1_700_000_502_000,
      model: REPLAY_FIXTURE_MODEL,
      agentId: "exec",
      thinkingLevel: "off",
      requestHistorySequence: seq,
    });
    const appendAssistant = await ctx.historyService.appendToHistory(
      ctx.workspaceId,
      assistantMessage
    );
    expect(appendAssistant.success).toBe(true);
    ctx.turnCounter += 1;

    await appendReplayFixtureTurn(ctx, {
      userText: "Third.",
      assistantText: "Three.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["PASS", "FAIL", "PASS"]);
    expect(result.turns[1].reason).toContain("system prompt");
  });

  test("plan-transition content and per-send cache TTL are log-derivable", async () => {
    using tmp = new DisposableTempDir("replay-verify-plan-transition");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "Please plan this.",
      assistantText: "Here is the plan.",
      agentId: "plan",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    // plan → exec handoff: injectAgentTransition embeds the plan content into
    // the request; the envelope blob must be enough to rebuild those bytes.
    await appendReplayFixtureTurn(ctx, {
      userText: "Plan accepted, implement it.",
      assistantText: "Implemented.",
      agentId: "exec",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      planContentForTransition: "Step 1: add the feature.\nStep 2: test it.",
      planFilePath: "/plans/feature.md",
      anthropicCacheTtl: "1h",
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => ({ status: turn.status, reason: turn.reason }))).toEqual([
      { status: "PASS", reason: undefined },
      { status: "PASS", reason: undefined },
    ]);

    // Guard against a vacuous pass: the plan content and the non-default TTL
    // must actually be model-visible in the recorded request.
    const devtoolsRaw = await fs.readFile(`${tmp.path}/devtools.jsonl`, "utf-8");
    expect(devtoolsRaw).toContain("Step 1: add the feature.");
    expect(devtoolsRaw).toContain("/plans/feature.md");
    expect(devtoolsRaw).toContain('"ttl":"1h"');
  });

  test("refusal-fallback partial continuation is log-derivable", async () => {
    using tmp = new DisposableTempDir("replay-verify-partial-continuation");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    // A refusal fallback appends the refused attempt's partial output to the
    // request as a synthetic assistant continuation. It never reaches
    // chat.jsonl at this turn's requestHistorySequence (the surviving
    // assistant row lands later), so the envelope blob must be enough to
    // rebuild the request bytes.
    const continuation = createMuxMessage(
      "assistant-partial-refusal",
      "assistant",
      "Partial output before the refusal.",
      { timestamp: 1_700_000_005_000 }
    );
    await appendReplayFixtureTurn(ctx, {
      userText: "Trigger a refusal fallback.",
      assistantText: "Fallback model finished the job.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      partialContinuation: continuation,
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => ({ status: turn.status, reason: turn.reason }))).toEqual([
      { status: "PASS", reason: undefined },
    ]);

    // Guard against a vacuous pass: the continuation text must actually be
    // model-visible in the recorded request.
    const devtoolsRaw = await fs.readFile(`${tmp.path}/devtools.jsonl`, "utf-8");
    expect(devtoolsRaw).toContain("Partial output before the refusal.");
  });

  test("native tool search results replay as tool references", async () => {
    using tmp = new DisposableTempDir("replay-verify-native-tool-search");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    const nativeTools: Record<string, Tool> = {
      ...tools(),
      [TOOL_SEARCH_TOOL_NAME]: tool({
        description: "Search deferred tools",
        inputSchema: z.object({ query: z.string() }),
      }),
      zulip_send_message: tool({
        description: "Send a Zulip message",
        inputSchema: z.object({ text: z.string() }),
        providerOptions: { anthropic: { deferLoading: true } },
      }),
    };

    await appendReplayFixtureTurn(ctx, {
      userText: "Find the Zulip tool.",
      assistantText: "Searching.",
      assistantParts: [
        {
          type: "dynamic-tool",
          state: "output-available",
          toolCallId: "toolu_search",
          toolName: TOOL_SEARCH_TOOL_NAME,
          input: { query: "zulip send" },
          output: {
            query: "zulip send",
            matches: [{ name: "zulip_send_message", description: "Send a Zulip message" }],
            totalDeferred: 1,
          },
        },
      ],
      systemPrompt: SYSTEM_PROMPT,
      tools: nativeTools,
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Continue.",
      assistantText: "Sent.",
      systemPrompt: SYSTEM_PROMPT,
      tools: nativeTools,
    });

    const result = await verify(ctx);
    expect(
      result.turns.map((turn) => ({ status: turn.status, messagesMatch: turn.messagesMatch }))
    ).toEqual([
      { status: "PASS", messagesMatch: true },
      { status: "PASS", messagesMatch: true },
    ]);

    // Guard against a vacuous pass: the second recorded request must send the
    // replayed search result as a tool reference, not the JSON result.
    const devtoolsRaw = await fs.readFile(`${tmp.path}/devtools.jsonl`, "utf-8");
    const secondStep = devtoolsRaw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type?: string; step?: { runId?: string } })
      .find((entry) => entry.type === "step" && entry.step?.runId === "run-2");
    expect(JSON.stringify(secondStep)).toContain(
      '"anthropic":{"type":"tool-reference","toolName":"zulip_send_message"}'
    );
  });

  test("a split volatile system tail is log-derivable", async () => {
    using tmp = new DisposableTempDir("replay-verify-volatile-system");
    const ctx = createReplayFixtureSessionContext(tmp.path);
    const volatileTail = "\n\n<hot_memories>note</hot_memories>";

    await appendReplayFixtureTurn(ctx, {
      userText: "Use the notes.",
      assistantText: "Done.",
      systemPrompt: SYSTEM_PROMPT + volatileTail,
      systemVolatileSuffixLength: volatileTail.length,
      tools: tools(),
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => ({ status: turn.status, reason: turn.reason }))).toEqual([
      { status: "PASS", reason: undefined },
    ]);

    // Guard against a vacuous pass: the recorded request must carry the
    // stable prompt and the tail as two system rows, and replay must have
    // split them from the envelope alone.
    const devtoolsRaw = await fs.readFile(`${tmp.path}/devtools.jsonl`, "utf-8");
    const step = devtoolsRaw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type?: string; step?: { input?: { prompt?: unknown } } })
      .find((entry) => entry.type === "step");
    const prompt = step?.step?.input?.prompt as Array<{ role: string; content: unknown }>;
    expect(prompt.slice(0, 2).map((row) => [row.role, row.content])).toEqual([
      ["system", SYSTEM_PROMPT],
      ["system", volatileTail],
    ]);
  });
});
