import { describe, expect, test } from "bun:test";
import type { HeldInput } from "@/common/orpc/types";
import type { DisplayedMessage, DisplayedUserMessage } from "@/common/types/message";
import { formatAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import {
  deriveLastMessageReceipt,
  deriveStatusActivity,
  findStartHereSource,
  isTurnActive,
  recentTranscriptRows,
  type StatusActivityFlags,
} from "./agentInterfaceStatusBar";

let sequence = 0;

function user(content: string, extra: Partial<DisplayedUserMessage> = {}): DisplayedMessage {
  sequence += 1;
  return {
    type: "user",
    id: `u${sequence}`,
    historyId: `u${sequence}`,
    content,
    historySequence: sequence,
    ...extra,
  };
}

type DisplayedAssistant = Extract<DisplayedMessage, { type: "assistant" }>;

function assistant(content: string, extra: Partial<DisplayedAssistant> = {}): DisplayedAssistant {
  sequence += 1;
  return {
    type: "assistant",
    id: `a${sequence}`,
    historyId: `a${sequence}`,
    content,
    historySequence: sequence,
    isStreaming: false,
    isPartial: false,
    isCompacted: false,
    isIdleCompacted: false,
    ...extra,
  };
}

function reasoning(isStreaming: boolean): DisplayedMessage {
  sequence += 1;
  return {
    type: "reasoning",
    id: `r${sequence}`,
    historyId: `r${sequence}`,
    content: "pondering",
    historySequence: sequence,
    isStreaming,
    isPartial: false,
  };
}

type DisplayedTool = Extract<DisplayedMessage, { type: "tool" }>;

function tool(
  toolName: string,
  status: DisplayedTool["status"],
  args: unknown = {},
  extra: Partial<DisplayedTool> = {}
): DisplayedMessage {
  sequence += 1;
  return {
    type: "tool",
    id: `t${sequence}`,
    historyId: `t${sequence}`,
    toolCallId: `call${sequence}`,
    toolName,
    args,
    status,
    isPartial: false,
    historySequence: sequence,
    ...extra,
  };
}

const streaming: StatusActivityFlags = {
  canInterrupt: true,
  isInterrupting: false,
  isStreamStarting: false,
  isCompacting: false,
  awaitingUserQuestion: false,
  activeBashMonitorCount: 0,
};
const idle: StatusActivityFlags = { ...streaming, canInterrupt: false };

describe("deriveStatusActivity", () => {
  test("a turn that is starting reports starting, with the runtime's breadcrumb when present", () => {
    const flags = { ...streaming, isStreamStarting: true };
    expect(deriveStatusActivity([tool("bash", "executing")], flags).kind).toBe("starting");
    const startingWith = (runtimeStatus: StatusActivityFlags["runtimeStatus"]) =>
      deriveStatusActivity([], { ...flags, runtimeStatus }).label;
    expect(startingWith({ phase: "starting", detail: "Waking the workspace" })).toBe(
      "Waking the workspace"
    );
    expect(startingWith({ phase: "waiting", detail: "Waiting for the runtime" })).toBe(
      "Waiting for the runtime"
    );
    // A blank breadcrumb, or one from a phase that is not starting up, names no step.
    const fallback = startingWith(null);
    expect(fallback).not.toBe("");
    expect(startingWith({ phase: "starting", detail: "  " })).toBe(fallback);
    expect(startingWith({ phase: "error", detail: "Runtime failed earlier" })).toBe(fallback);
  });

  test("a stop the backend has not finished shows over the turn's phase until the stream ends", () => {
    const turn = [user("go"), tool("bash", "executing", { display_name: "Run tests" })];
    const stopping = { ...streaming, isInterrupting: true };
    for (const flags of [
      stopping,
      { ...stopping, isCompacting: true },
      { ...stopping, awaitingUserQuestion: true },
    ]) {
      expect(deriveStatusActivity(turn, flags).kind).toBe("interrupting");
    }
    // A turn still starting shows its startup, and an ended stream leaves no stop to wait for.
    expect(deriveStatusActivity(turn, { ...stopping, isStreamStarting: true }).kind).toBe(
      "starting"
    );
    expect(deriveStatusActivity(turn, { ...stopping, canInterrupt: false }).kind).toBe("idle");
  });

  test("compacting and a pending question name their phase over the turn's running tool", () => {
    const turn = [user("go"), tool("ask_user_question", "executing")];
    expect(deriveStatusActivity(turn, { ...streaming, isCompacting: true }).kind).toBe(
      "compacting"
    );
    expect(deriveStatusActivity(turn, { ...streaming, awaitingUserQuestion: true }).kind).toBe(
      "question"
    );
  });

  test("a running tool beats streaming reasoning, which beats reply text", () => {
    const running = tool("bash", "executing", { display_name: "Run tests" });
    const turn = [user("go"), reasoning(true), running, assistant("so far", { isStreaming: true })];
    expect(deriveStatusActivity(turn, streaming)).toMatchObject({
      kind: "tool",
      detail: "Run tests",
    });

    const thinking = [user("go"), reasoning(true), assistant("so far", { isStreaming: true })];
    expect(deriveStatusActivity(thinking, streaming).kind).toBe("thinking");

    const writing = [user("go"), reasoning(false), assistant("so far", { isStreaming: true })];
    expect(deriveStatusActivity(writing, streaming).kind).toBe("writing");
  });

  test("of serialized calls, the one whose execution began is named, not a queued sibling", () => {
    const turn = [
      user("go"),
      tool("bash", "executing", { display_name: "Build" }, { executionStartedAt: 10 }),
      tool("bash", "executing", { display_name: "Test" }),
    ];
    expect(deriveStatusActivity(turn, streaming).detail).toBe("Build");
    // Provider-executed calls never report a start, so the newest running call stands.
    const provider = [
      user("go"),
      tool("web_search", "executing", { title: "Older search" }),
      tool("web_search", "executing", { title: "Search" }),
    ];
    expect(deriveStatusActivity(provider, streaming).detail).toBe("Search");
  });

  test("a parallel call still running counts after a newer call completed", () => {
    const turn = [
      user("go"),
      tool("file_read", "executing", { path: "src/a.ts" }),
      tool("file_read", "completed", { path: "src/b.ts" }),
    ];
    expect(deriveStatusActivity(turn, streaming).detail).toBe("src/a.ts");
  });

  test("a tool still marked executing in an earlier turn does not count for the current one", () => {
    const messages = [user("first"), tool("bash", "executing"), user("second")];
    expect(deriveStatusActivity(messages, streaming).kind).toBe("working");
  });

  test("not streaming is idle, or stopped when the newest row is a stream error", () => {
    expect(deriveStatusActivity([], idle).kind).toBe("idle");
    const errored: DisplayedMessage = {
      type: "stream-error",
      id: "e1",
      historyId: "e1",
      error: "overloaded",
      errorType: "unknown",
      historySequence: 99,
    };
    expect(deriveStatusActivity([user("go"), assistant("partial"), errored], idle).kind).toBe(
      "error"
    );
    // A retry that answered after the error leaves the turn settled, not stopped.
    expect(deriveStatusActivity([user("go"), errored, assistant("done")], idle).kind).toBe("idle");
  });

  test("after the turn, an armed bash monitor is waited on, not idle", () => {
    const settled = [user("go"), assistant("watching the logs")];
    expect(deriveStatusActivity(settled, { ...idle, activeBashMonitorCount: 2 }).kind).toBe(
      "monitor"
    );
    // A running turn still names its own phase.
    expect(deriveStatusActivity(settled, { ...streaming, activeBashMonitorCount: 2 }).kind).toBe(
      "working"
    );
  });

  test("a turn counts as running in every phase but idle, a stopped stream and a monitor wait", () => {
    const phases: Array<[StatusActivityFlags, DisplayedMessage[], boolean]> = [
      [{ ...idle, isStreamStarting: true }, [], true],
      [{ ...streaming, isCompacting: true }, [], true],
      [{ ...streaming, awaitingUserQuestion: true }, [], true],
      [streaming, [user("go"), tool("bash", "executing")], true],
      [idle, [user("go"), assistant("done")], false],
      [{ ...streaming, isInterrupting: true }, [user("go"), tool("bash", "executing")], true],
      [{ ...idle, activeBashMonitorCount: 1 }, [user("go"), assistant("watching")], false],
    ];
    for (const [flags, messages, active] of phases) {
      expect(isTurnActive(deriveStatusActivity(messages, flags))).toBe(active);
    }
    expect(isTurnActive({ kind: "error", label: "Stopped" })).toBe(false);
  });
});

describe("deriveLastMessageReceipt", () => {
  const held: HeldInput = {
    id: "h1",
    reason: "reported",
    displayText: "held text",
    attachmentCount: 0,
    reviewCount: 0,
  };

  test("a queued message wins over held inputs and the newest transcript row", () => {
    const receipt = deriveLastMessageReceipt(
      [user("in history")],
      { id: "q1", content: "queued text" },
      [held]
    );
    expect(receipt).toMatchObject({ state: "queued", preview: "queued text" });
  });

  test("a held input does not stand in for a message that landed; it is counted", () => {
    // Held inputs carry no time: one left from earlier must not hide a newer message's arrival.
    expect(deriveLastMessageReceipt([user("in history")], null, [held])).toMatchObject({
      state: "in-transcript",
      preview: "in history",
      otherHeldCount: 1,
    });
    expect(deriveLastMessageReceipt([user("in history")], null, [])?.otherHeldCount).toBe(0);
  });

  test("with nothing sent to show, the newest held input is the receipt and the rest count", () => {
    const middle: HeldInput = { ...held, id: "h2", displayText: "middle held text" };
    const newer: HeldInput = { ...held, id: "h3", displayText: "newer held text" };
    expect(deriveLastMessageReceipt([], null, [held, middle, newer])).toMatchObject({
      state: "held",
      preview: "newer held text",
      otherHeldCount: 2,
    });
  });

  test("the newest human row is sending until it is backed by history", () => {
    expect(
      deriveLastMessageReceipt([user("first", { isPendingSend: true })], null, [])?.state
    ).toBe("sending");
    expect(deriveLastMessageReceipt([user("landed", { timestamp: 5 })], null, [])).toMatchObject({
      state: "in-transcript",
      preview: "landed",
      timestamp: 5,
    });
  });

  test("machine-authored user rows are not the user's last message", () => {
    const messages = [
      user("mine"),
      user("synthetic row", { isSynthetic: true }),
      user("continue the goal", { isGoalContinuation: true }),
      user("wrap up the goal", { isBudgetLimitWrapup: true }),
      user("monitor fired", { bashMonitorWake: { records: [] } }),
      user("peer says hi", { agentPeerMessageTrigger: true }),
      user("context is filling up", {
        contextBudgetWarning: { contextTokens: 1, maxTokens: 2, final: false, handoff: false },
      }),
    ];
    expect(deriveLastMessageReceipt(messages, null, [])?.preview).toBe("mine");
    expect(deriveLastMessageReceipt(messages.slice(1), null, [])).toBeNull();
  });
});

describe("recentTranscriptRows", () => {
  test("keeps the newest rows oldest first, skipping rows with nothing to read", () => {
    const messages: DisplayedMessage[] = [
      user("old"),
      { type: "history-hidden", id: "hh", hiddenCount: 3, historySequence: 0 },
      assistant("reply"),
      {
        type: "compaction-boundary",
        id: "cb",
        historySequence: 50,
        position: "start",
      },
      tool("bash", "executing", { display_name: "Sleep" }),
    ];
    const rows = recentTranscriptRows(messages, 3);
    expect(rows.map((row) => row.kind)).toEqual(["assistant", "boundary", "tool"]);
    expect(rows.at(-1)?.preview).toBe("Sleep");
    expect(recentTranscriptRows(messages, 10).map((row) => row.kind)).toEqual([
      "user",
      "assistant",
      "boundary",
      "tool",
    ]);
  });

  test("another agent's message names its sender and shows its text, not the envelope", () => {
    const peerMessage = assistant(
      formatAgentMessageEnvelope({
        from: "ws-reviewer",
        fromTitle: "Reviewer",
        relationship: "sibling",
        message: "Looks good to me",
      }),
      {
        agentPeerMessage: {
          fromWorkspaceId: "ws-reviewer",
          fromTitle: "Reviewer",
          relationship: "sibling",
        },
      }
    );
    const [row] = recentTranscriptRows([peerMessage], 1);
    expect(row.label).toContain("Reviewer");
    expect(row.label).not.toBe(recentTranscriptRows([assistant("mine")], 1)[0].label);
    expect(row.preview).toBe("Looks good to me");
  });

  test("previews are one bounded line, and malformed tool arguments show none", () => {
    const long = `First line\n\n${"word ".repeat(100)}`;
    const [row] = recentTranscriptRows([user(long)], 1);
    expect(row.preview.startsWith("First line word")).toBe(true);
    expect(row.preview).not.toContain("\n");
    expect(row.preview.length).toBeLessThan(long.length);
    expect(row.preview.length).toBeLessThanOrEqual(160);
    expect(recentTranscriptRows([tool("bash", "executing", "not an object")], 1)[0].preview).toBe(
      ""
    );
  });
});

describe("findStartHereSource", () => {
  test("picks the newest settled reply, skipping streaming, empty and peer rows", () => {
    const settled = assistant("the plan");
    const messages = [
      user("go"),
      settled,
      assistant("", {}),
      assistant("from a peer", {
        agentPeerMessage: { fromWorkspaceId: "w2", relationship: "descendant" },
      }),
      assistant("still typing", { isStreaming: true }),
    ];
    expect(findStartHereSource(messages)).toBe(settled);
    expect(findStartHereSource([settled])).toBe(settled);
  });

  test("offers nothing once the newest reply is compacted or before the latest boundary", () => {
    expect(findStartHereSource([assistant("summary", { isCompacted: true })])).toBeNull();
    expect(
      findStartHereSource([
        assistant("old reply", { isBeforeLatestContextBoundary: true }),
        user("after the reset"),
      ])
    ).toBeNull();
  });
});
