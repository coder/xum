import { describe, expect, test } from "bun:test";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createReplayBufferedStreamMessageRelay } from "./replayBufferedStreamMessageRelay";

describe("createReplayBufferedStreamMessageRelay", () => {
  test("buffers live init events until replay finishes", () => {
    const pushed: WorkspaceChatMessage[] = [];
    const relay = createReplayBufferedStreamMessageRelay((message) => {
      pushed.push(message);
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Replayed init output",
      isError: false,
      timestamp: 1_001,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Live init output",
      isError: false,
      timestamp: 1_002,
    });

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "Replayed init output",
        isError: false,
        timestamp: 1_001,
        replay: true,
      },
    ]);

    relay.finishReplay();

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "Replayed init output",
        isError: false,
        timestamp: 1_001,
        replay: true,
      },
      {
        type: "init-output",
        line: "Live init output",
        isError: false,
        timestamp: 1_002,
      },
    ]);
  });

  test("keeps buffered init lines with the same text/timestamp when lineNumber differs", () => {
    const pushed: WorkspaceChatMessage[] = [];
    const relay = createReplayBufferedStreamMessageRelay((message) => {
      pushed.push(message);
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "duplicate line",
      isError: false,
      timestamp: 1_001,
      lineNumber: 0,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "duplicate line",
      isError: false,
      timestamp: 1_001,
      lineNumber: 1,
    });

    relay.finishReplay();

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "duplicate line",
        isError: false,
        timestamp: 1_001,
        lineNumber: 0,
        replay: true,
      },
      {
        type: "init-output",
        line: "duplicate line",
        isError: false,
        timestamp: 1_001,
        lineNumber: 1,
      },
    ]);
  });

  test("drops buffered init events that replay already covered", () => {
    const pushed: WorkspaceChatMessage[] = [];
    const relay = createReplayBufferedStreamMessageRelay((message) => {
      pushed.push(message);
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Replayed init output",
      isError: false,
      timestamp: 1_001,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: 1_005,
      replay: true,
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Replayed init output",
      isError: false,
      timestamp: 1_001,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Live init tail",
      isError: false,
      timestamp: 1_002,
    });
    relay.handleSessionMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: 1_005,
    });

    relay.finishReplay();

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "Replayed init output",
        isError: false,
        timestamp: 1_001,
        replay: true,
      },
      {
        type: "init-end",
        exitCode: 0,
        timestamp: 1_005,
        replay: true,
      },
      {
        type: "init-output",
        line: "Live init tail",
        isError: false,
        timestamp: 1_002,
      },
    ]);
  });
});
