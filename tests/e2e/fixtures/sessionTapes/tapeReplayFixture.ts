/**
 * Synthetic session tape for the `perf.tapeReplay` scenario. The committed
 * `perf-tape-replay.jsonl` next to this file is `buildTapeReplayFixtureTape()`'s output
 * (regenerate with `bun scripts/perf/generateTapeReplayFixture.ts`; a unit test guards drift).
 * Synthetic only: real tapes hold full chat content and must never become fixtures.
 *
 * Content: a history batch, caught-up, then one streamed turn with reasoning, a tool call and a
 * final reply whose markdown embeds two probe images (one remote, one loopback). The scenario
 * proves the renderer egress block cancels both. The tool call's command is a marker that is not
 * a shell builtin, so a process trace would show it if replay ever executed a tool.
 */
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { buildSyntheticSessionTape } from "@/node/services/sessionTapes/sessionTapes.testFixtures";

/** Stable-format (10 hex) id the scenario registers its workspace under. */
export const TAPE_REPLAY_FIXTURE_WORKSPACE_ID = "7a9e0c3d51";
export const TAPE_REPLAY_FIXTURE_FILE_NAME = "perf-tape-replay.jsonl";

export const TAPE_REPLAY_PROBE_URLS = [
  "https://replay-egress-probe.invalid/replay-egress-probe.png",
  "http://127.0.0.1:47999/replay-egress-probe.png",
] as const;

export const TAPE_REPLAY_TEXTS = {
  historyUser: "Replay fixture: how do I list the files in this repo?",
  historyAssistant: "Replay fixture: run git ls-files from the repository root.",
  liveUser: "Replay fixture: check the marker command please.",
  liveText: "Running the marker command now. ",
  markerCommand: "xum-tape-replay-marker --check",
  finalReply: "Replay fixture final reply: the marker command finished.",
} as const;

/** Recorded offset of event `index`: 40 ms apart, like a brisk live stream. */
const EVENT_SPACING_MS = 40;

function buildTapeReplayFixtureEvents(): WorkspaceChatMessage[] {
  const workspaceId = TAPE_REPLAY_FIXTURE_WORKSPACE_ID;
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  const model = "anthropic:claude-opus-5-5";
  const usage = { inputTokens: 120, outputTokens: 40, totalTokens: 160 };
  const messageId = "msg-replay-live";
  const toolCallId = "call-replay-marker";
  const toolInput = { script: TAPE_REPLAY_TEXTS.markerCommand };
  const toolOutput = { success: true, output: "marker ok", exitCode: 0 };
  const finalMarkdown = [
    TAPE_REPLAY_TEXTS.finalReply,
    "",
    `![remote probe](${TAPE_REPLAY_PROBE_URLS[0]})`,
    "",
    `![loopback probe](${TAPE_REPLAY_PROBE_URLS[1]})`,
  ].join("\n");
  const userRow = (id: string, text: string, historySequence: number) => ({
    type: "message",
    id,
    role: "user",
    createdAt,
    parts: [{ type: "text", text }],
    metadata: { historySequence, timestamp: historySequence },
  });
  const raw: unknown[] = [
    {
      type: "message-batch",
      messages: [
        userRow("msg-replay-user-1", TAPE_REPLAY_TEXTS.historyUser, 1),
        {
          type: "message",
          id: "msg-replay-assistant-1",
          role: "assistant",
          createdAt,
          parts: [{ type: "text", text: TAPE_REPLAY_TEXTS.historyAssistant }],
          metadata: { historySequence: 2, timestamp: 2, model, usage },
        },
        userRow("msg-replay-user-2", TAPE_REPLAY_TEXTS.liveUser, 3),
      ],
    },
    { type: "caught-up", replay: "full", historyReplayStatus: "complete" },
    { type: "stream-start", workspaceId, messageId, model, historySequence: 4, startTime: 4 },
    {
      type: "reasoning-delta",
      workspaceId,
      messageId,
      delta: "Check the marker.",
      tokens: 4,
      timestamp: 5,
    },
    { type: "reasoning-end", workspaceId, messageId },
    {
      type: "stream-delta",
      workspaceId,
      messageId,
      delta: TAPE_REPLAY_TEXTS.liveText,
      tokens: 6,
      timestamp: 6,
    },
    {
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "bash",
      args: toolInput,
      tokens: 8,
      timestamp: 7,
    },
    {
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "bash",
      result: toolOutput,
      timestamp: 8,
    },
    { type: "stream-delta", workspaceId, messageId, delta: finalMarkdown, tokens: 20, timestamp: 9 },
    {
      type: "stream-end",
      workspaceId,
      messageId,
      metadata: { model, usage, historySequence: 4 },
      parts: [
        { type: "reasoning", text: "Check the marker." },
        { type: "text", text: TAPE_REPLAY_TEXTS.liveText },
        {
          type: "dynamic-tool",
          toolCallId,
          toolName: "bash",
          state: "output-available",
          input: toolInput,
          output: toolOutput,
        },
        { type: "text", text: finalMarkdown },
      ],
    },
  ];
  return raw.map((event) => WorkspaceChatMessageSchema.parse(event));
}

/** The committed fixture's exact text. */
export function buildTapeReplayFixtureTape(): string {
  return buildSyntheticSessionTape(buildTapeReplayFixtureEvents(), {
    workspaceId: TAPE_REPLAY_FIXTURE_WORKSPACE_ID,
    offsetMs: (index) => index * EVENT_SPACING_MS,
  });
}
