import { describe, expect, test } from "bun:test";
import type { HeldInput } from "@/common/orpc/types";
import type { DisplayedMessage, DisplayedUserMessage } from "@/common/types/message";
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

function tool(
  toolName: string,
  status: Extract<DisplayedMessage, { type: "tool" }>["status"],
  args: unknown = {}
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
  };
}

const streaming: StatusActivityFlags = {
  canInterrupt: true,
  isStreamStarting: false,
  isCompacting: false,
  awaitingUserQuestion: false,
};
const idle: StatusActivityFlags = { ...streaming, canInterrupt: false };

describe("deriveStatusActivity", () => {
  test("a turn that is starting reports starting, with the runtime's breadcrumb when present", () => {
    const flags = { ...streaming, isStreamStarting: true };
    expect(deriveStatusActivity([tool("bash", "executing")], flags).kind).toBe("starting");
    expect(
      deriveStatusActivity([], { ...flags, runtimeDetail: "Waking the workspace" }).label
    ).toBe("Waking the workspace");
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

  test("a turn counts as running in every phase but idle and a stopped stream", () => {
    const phases: Array<[StatusActivityFlags, DisplayedMessage[], boolean]> = [
      [{ ...idle, isStreamStarting: true }, [], true],
      [{ ...streaming, isCompacting: true }, [], true],
      [{ ...streaming, awaitingUserQuestion: true }, [], true],
      [streaming, [user("go"), tool("bash", "executing")], true],
      [idle, [user("go"), assistant("done")], false],
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

  test("held inputs win over the newest transcript row, the newest held input first", () => {
    const newer: HeldInput = { ...held, id: "h2", displayText: "newer held text" };
    expect(deriveLastMessageReceipt([user("in history")], null, [held, newer])).toMatchObject({
      state: "held",
      preview: "newer held text",
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
