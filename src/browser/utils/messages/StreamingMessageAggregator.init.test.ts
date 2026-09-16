import { describe, it, expect } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";
import { INIT_HOOK_MAX_LINES } from "@/common/constants/toolLimits";
import { createMuxMessage } from "@/common/types/message";

interface InitDisplayedMessage {
  type: "workspace-init";
  status: "running" | "success" | "error";
  lines: Array<{ line: string; isError: boolean }>;
  exitCode: number | null;
  truncatedLines?: number;
}

// Helper to wait for throttled init output updates (100ms throttle + buffer)
const waitForInitThrottle = () => new Promise((r) => setTimeout(r, 120));

describe("Init display after cleanup changes", () => {
  it.each([false, true])(
    "places init after the first user regardless of early completion (%s)",
    (completed) => {
      const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
      aggregator.handleMessage({ type: "init-start", hookPath: "/project", timestamp: 1 });
      if (completed) aggregator.handleMessage({ type: "init-end", exitCode: 0, timestamp: 2 });
      expect(aggregator.getDisplayedMessages().map((message) => message.type)).toEqual([
        "workspace-init",
      ]);
      aggregator.handleMessage({
        type: "message",
        ...createMuxMessage("user", "user", "Create this workspace", {
          historySequence: 7,
          timestamp: 3,
        }),
      });
      expect(aggregator.getDisplayedMessages().map((message) => message.type)).toEqual([
        "user",
        "workspace-init",
      ]);
      aggregator.handleMessage({
        type: "message",
        ...createMuxMessage("assistant", "assistant", "Ready", {
          historySequence: 8,
          timestamp: 4,
        }),
      });
      aggregator.handleMessage({
        type: "message",
        ...createMuxMessage("next-user", "user", "Continue", { historySequence: 9, timestamp: 5 }),
      });
      expect(aggregator.getDisplayedMessages().map((message) => message.type)).toEqual([
        "user",
        "workspace-init",
        "assistant",
        "user",
      ]);
    }
  );

  describe("creation card across context boundaries", () => {
    const displayedTypes = (aggregator: StreamingMessageAggregator) =>
      aggregator.getDisplayedMessages().map((message) => message.type);
    const asChatMessage = (message: ReturnType<typeof createMuxMessage>) => ({
      type: "message" as const,
      ...message,
    });
    const compactionSummary = (id: string, historySequence: number, timestamp: number) =>
      createMuxMessage(id, "assistant", "Compacted summary", {
        historySequence,
        timestamp,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: historySequence,
        muxMetadata: { type: "compaction-summary" },
      });
    const finishedInit = (timestamp: number) => ({
      type: "init-start" as const,
      hookPath: "/project",
      timestamp,
      replay: true,
      completed: { exitCode: 0, endTime: timestamp + 1 },
    });
    const epoch0 = [
      createMuxMessage("user-0", "user", "Create this workspace", {
        historySequence: 1,
        timestamp: 10,
      }),
      createMuxMessage("assistant-0", "assistant", "Done", { historySequence: 2, timestamp: 11 }),
    ];
    const epoch1 = [
      compactionSummary("summary-1", 3, 100),
      createMuxMessage("user-1", "user", "Middle turn", { historySequence: 4, timestamp: 101 }),
    ];
    const epoch2 = [
      compactionSummary("summary-2", 5, 200),
      createMuxMessage("user-2", "user", "Latest turn", { historySequence: 6, timestamp: 201 }),
      createMuxMessage("assistant-2", "assistant", "Working", {
        historySequence: 7,
        timestamp: 202,
      }),
    ];

    it("hides a finished card behind the boundary until the first turn is loaded again", () => {
      const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
      aggregator.handleMessage(finishedInit(5));
      aggregator.loadHistoricalMessages(epoch2, false);
      expect(displayedTypes(aggregator)).toEqual([
        "compaction-boundary",
        "assistant",
        "user",
        "assistant",
      ]);

      // An older epoch that itself starts at a boundary still hides the transcript start.
      aggregator.loadHistoricalMessages(epoch1, false, { mode: "append", skipDerivedState: true });
      expect(displayedTypes(aggregator)).not.toContain("workspace-init");

      aggregator.loadHistoricalMessages(epoch0, false, { mode: "append", skipDerivedState: true });
      expect(displayedTypes(aggregator).slice(0, 4)).toEqual([
        "user",
        "workspace-init",
        "assistant",
        "compaction-boundary",
      ]);
    });

    it("hides the card when a live compaction prunes the first turn", () => {
      const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
      aggregator.handleMessage(finishedInit(5));
      aggregator.loadHistoricalMessages(epoch0, false);
      expect(displayedTypes(aggregator)).toEqual(["user", "workspace-init", "assistant"]);

      aggregator.handleMessage(asChatMessage(compactionSummary("summary-live", 3, 100)));
      expect(displayedTypes(aggregator)).toEqual(["compaction-boundary", "assistant"]);
    });

    it("keeps a fork's card, whose init ran after the copied boundary, in the loaded window", () => {
      const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
      aggregator.loadHistoricalMessages(epoch2, false);
      aggregator.handleMessage({ type: "init-start", hookPath: "/project", timestamp: 300 });
      expect(displayedTypes(aggregator)).toEqual([
        "compaction-boundary",
        "assistant",
        "user",
        "workspace-init",
        "assistant",
      ]);

      aggregator.handleMessage({ type: "init-end", exitCode: 0, timestamp: 301 });
      expect(displayedTypes(aggregator)).toContain("workspace-init");
    });

    it("only hides the card on positive evidence that the init predates the boundary", () => {
      // A boundary without a timestamp cannot prove the init belongs to unloaded history,
      // so a running fork init keeps its card rather than losing its progress and failure output.
      const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
      const undatedSummary = compactionSummary("summary-undated", 5, 200);
      delete undatedSummary.metadata?.timestamp;
      aggregator.loadHistoricalMessages([undatedSummary, ...epoch2.slice(1)], false);
      aggregator.handleMessage({ type: "init-start", hookPath: "/project", timestamp: 300 });
      expect(displayedTypes(aggregator)).toEqual([
        "compaction-boundary",
        "assistant",
        "user",
        "workspace-init",
        "assistant",
      ]);
    });
  });

  it("propagates steps and throttles progress until another step or completion clears it", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const progress = {
      type: "init-progress" as const,
      label: "Updating files",
      percent: 87,
      timestamp: 2,
    };
    aggregator.handleMessage(progress);
    expect(aggregator.getDisplayedMessages()).toEqual([]);
    aggregator.handleMessage({ type: "init-start", hookPath: "/project", timestamp: 1 });
    const before = aggregator.getDisplayedMessages();
    aggregator.handleMessage(progress);
    expect(aggregator.getDisplayedMessages()).toBe(before);
    aggregator.flushPendingInitOutput();
    expect(aggregator.getDisplayedMessages()[0]).toMatchObject({
      progress: { label: "Updating files", percent: 87 },
    });
    const step = { type: "init-output" as const, line: "Running hook", step: true, timestamp: 3 };
    aggregator.handleMessage(step);
    aggregator.flushPendingInitOutput();
    expect(aggregator.getDisplayedMessages()[0]).toMatchObject({
      progress: null,
      lines: [{ line: step.line, isError: false, step: true }],
    });
    aggregator.handleMessage(progress);
    aggregator.handleMessage({ type: "init-output", line: "Raw output", timestamp: 4 });
    aggregator.flushPendingInitOutput();
    expect(aggregator.getDisplayedMessages()[0]).toMatchObject({
      progress: { label: "Updating files", percent: 87 },
    });
    aggregator.handleMessage({ type: "init-end", exitCode: 0, timestamp: 5 });
    expect(aggregator.getDisplayedMessages()[0]).toMatchObject({ progress: null });
    const finished = aggregator.getDisplayedMessages();
    aggregator.handleMessage(progress);
    aggregator.flushPendingInitOutput();
    expect(aggregator.getDisplayedMessages()).toEqual(finished);
  });

  it("keeps checklist lines and live progress unchanged during reconnect replay", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const start = { type: "init-start" as const, hookPath: "/project", timestamp: 1 };
    const step = { type: "init-output" as const, line: "Checkout", step: true, timestamp: 2 };
    aggregator.handleMessage(start);
    aggregator.handleMessage(step);
    aggregator.handleMessage({
      type: "init-progress",
      label: "Updating files",
      percent: 87,
      timestamp: 3,
    });
    aggregator.flushPendingInitOutput();
    const before = aggregator.getDisplayedMessages();
    aggregator.handleMessage({ ...start, replay: true });
    aggregator.handleMessage({ ...step, replay: true });
    aggregator.flushPendingInitOutput();
    expect(aggregator.getDisplayedMessages()).toEqual(before);
    expect(aggregator.getDisplayedMessages()[0]).toMatchObject({
      lines: [{ line: step.line, isError: false, step: true }],
      progress: { label: "Updating files", percent: 87 },
    });
  });

  it("should display init messages correctly", async () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // Simulate init start
    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: Date.now(),
    });

    let messages = aggregator.getDisplayedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("workspace-init");
    expect((messages[0] as InitDisplayedMessage).status).toBe("running");

    // Simulate init output
    aggregator.handleMessage({
      type: "init-output",
      line: "Installing dependencies...",
      timestamp: Date.now(),
      isError: false,
    });

    // Wait for throttled cache invalidation
    await waitForInitThrottle();

    messages = aggregator.getDisplayedMessages();
    expect(messages).toHaveLength(1);
    expect((messages[0] as InitDisplayedMessage).lines).toContainEqual({
      line: "Installing dependencies...",
      isError: false,
    });

    // Simulate init end (flushes immediately)
    aggregator.handleMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: Date.now(),
    });

    messages = aggregator.getDisplayedMessages();
    expect(messages).toHaveLength(1);
    expect((messages[0] as InitDisplayedMessage).status).toBe("success");
    expect((messages[0] as InitDisplayedMessage).exitCode).toBe(0);
  });

  it.each([
    { exitCode: 0, status: "success" as const },
    { exitCode: 1, status: "error" as const },
  ])(
    "never publishes a running row while replaying a completed init (exit $exitCode)",
    ({ exitCode, status }) => {
      const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
      const statuses: string[] = [];
      const record = () => {
        const init = aggregator
          .getDisplayedMessages()
          .find((message) => message.type === "workspace-init");
        statuses.push(init ? init.status : "missing");
      };

      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/project",
        timestamp: 1_000,
        replay: true,
        completed: { exitCode, endTime: 4_500 },
      });
      record();
      for (const [index, line] of ["Preparing checkout", "Running hook"].entries()) {
        aggregator.handleMessage({
          type: "init-output",
          line,
          step: true,
          timestamp: 2_000 + index,
          lineNumber: index,
          replay: true,
        });
        aggregator.flushPendingInitOutput();
        record();
      }
      aggregator.handleMessage({ type: "init-end", exitCode, timestamp: 4_500, replay: true });
      record();

      expect(statuses).toEqual([status, status, status, status]);
      const init = aggregator
        .getDisplayedMessages()
        .find((message) => message.type === "workspace-init");
      expect(init).toMatchObject({
        status,
        exitCode,
        durationMs: 3_500,
        lines: [
          { line: "Preparing checkout", isError: false, step: true },
          { line: "Running hook", isError: false, step: true },
        ],
      });
    }
  );

  it("should treat replayed init-start/output for the same running init as idempotent", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: 1_000,
    });
    aggregator.handleMessage({
      type: "init-output",
      line: "Installing dependencies...",
      timestamp: 1_001,
      isError: false,
    });
    aggregator.flushPendingInitOutput();

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: 1_000,
      replay: true,
    });
    aggregator.handleMessage({
      type: "init-output",
      line: "Installing dependencies...",
      timestamp: 1_001,
      isError: false,
      replay: true,
    });
    aggregator.handleMessage({
      type: "init-output",
      line: "Syncing repository over SSH...",
      timestamp: 1_002,
      isError: false,
      replay: true,
    });
    aggregator.flushPendingInitOutput();

    const messages = aggregator.getDisplayedMessages();
    const initMsg = messages[0] as InitDisplayedMessage;

    expect(initMsg.lines).toEqual([
      { line: "Installing dependencies...", isError: false },
      { line: "Syncing repository over SSH...", isError: false },
    ]);
  });

  it("adopts terminal metadata when the same running init is replayed as completed", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const initRow = () =>
      aggregator.getDisplayedMessages().find((message) => message.type === "workspace-init");

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/project/.xum/init",
      timestamp: 1_000,
    });
    aggregator.handleMessage({
      type: "init-output",
      line: "Installing dependencies...",
      timestamp: 1_001,
      isError: false,
    });
    aggregator.flushPendingInitOutput();
    expect(initRow()).toMatchObject({ status: "running" });

    // Reconnect after the init finished server-side: the replayed init-start already knows
    // the outcome, so the retained row must not stay "running" until init-end is replayed.
    aggregator.resetForReplay();
    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/project/.xum/init",
      timestamp: 1_000,
      replay: true,
      completed: { exitCode: 0, endTime: 4_000 },
    });
    expect(initRow()).toMatchObject({
      status: "success",
      exitCode: 0,
      durationMs: 3_000,
      lines: [{ line: "Installing dependencies...", isError: false }],
    });

    aggregator.handleMessage({
      type: "init-output",
      line: "Installing dependencies...",
      timestamp: 1_001,
      isError: false,
      replay: true,
    });
    aggregator.handleMessage({ type: "init-end", exitCode: 0, timestamp: 4_000, replay: true });
    aggregator.flushPendingInitOutput();
    expect(initRow()).toMatchObject({
      status: "success",
      lines: [{ line: "Installing dependencies...", isError: false }],
    });
  });

  it("should preserve duplicate replayed init lines that share a timestamp", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: 1_000,
    });

    const duplicateReplayLineA = {
      type: "init-output" as const,
      line: "duplicate line",
      timestamp: 1_001,
      isError: false,
      replay: true,
    };
    const duplicateReplayLineB = {
      type: "init-output" as const,
      line: "duplicate line",
      timestamp: 1_001,
      isError: false,
      replay: true,
    };

    aggregator.handleMessage(duplicateReplayLineA);
    aggregator.handleMessage(duplicateReplayLineB);
    aggregator.flushPendingInitOutput();

    // Simulate the buffered catch-up pass reusing the exact same replay event objects.
    aggregator.handleMessage(duplicateReplayLineA);
    aggregator.handleMessage(duplicateReplayLineB);
    aggregator.flushPendingInitOutput();

    const messages = aggregator.getDisplayedMessages();
    const initMsg = messages[0] as InitDisplayedMessage;

    expect(initMsg.lines).toEqual([
      { line: "duplicate line", isError: false },
      { line: "duplicate line", isError: false },
    ]);
  });

  it("should handle init-output without init-start (defensive)", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // This might crash with non-null assertion if initState is null
    expect(() => {
      aggregator.handleMessage({
        type: "init-output",
        line: "Some output",
        timestamp: Date.now(),
        isError: false,
      });
    }).not.toThrow();
  });

  it("should handle init-end without init-start (defensive)", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    expect(() => {
      aggregator.handleMessage({
        type: "init-end",
        exitCode: 0,
        timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it("should truncate lines and track truncatedLines when exceeding limit", async () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: Date.now(),
    });

    // Add more lines than the limit
    const totalLines = INIT_HOOK_MAX_LINES + 50;
    for (let i = 0; i < totalLines; i++) {
      aggregator.handleMessage({
        type: "init-output",
        line: `Line ${i}`,
        timestamp: Date.now(),
        isError: false,
      });
    }

    // Wait for throttled cache invalidation
    await waitForInitThrottle();

    const messages = aggregator.getDisplayedMessages();
    const initMsg = messages[0] as InitDisplayedMessage;

    expect(initMsg.lines.length).toBe(INIT_HOOK_MAX_LINES);
    expect(initMsg.truncatedLines).toBe(50);

    // Should have the most recent lines (tail)
    expect(initMsg.lines[INIT_HOOK_MAX_LINES - 1]?.line).toBe(`Line ${totalLines - 1}`);
    // First line should be from when truncation started
    expect(initMsg.lines[0]?.line).toBe("Line 50");
  });

  it("should capture truncatedLines from init-end event", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: Date.now(),
    });

    // Add just a few lines (no frontend truncation)
    aggregator.handleMessage({
      type: "init-output",
      line: "Line 1",
      timestamp: Date.now(),
      isError: false,
    });

    // Simulate init-end with truncatedLines (from backend replay)
    aggregator.handleMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: Date.now(),
      truncatedLines: 1000, // Backend truncated 1000 lines
    });

    const messages = aggregator.getDisplayedMessages();
    const initMsg = messages[0] as InitDisplayedMessage;

    expect(initMsg.truncatedLines).toBe(1000);
  });
});
