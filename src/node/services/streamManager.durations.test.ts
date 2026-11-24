import { describe, expect, test } from "bun:test";

import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import { StreamManager, type TurnEngineEvent } from "./streamManager";
import { eventsOfType } from "./streamManager.liveStream.testHarness";
import {
  appendPartialAssistantForTests,
  createTestLanguageModel,
  historyService,
  installStreamManagerTestHistory,
  runTurnForTests,
  scriptedStreamText,
  STOP_FINISH,
  testStartOptions,
  type ScriptedAttempt,
} from "./streamManager.suite.testHarness";
import { createStreamManagerForTests } from "./streamManager.testHarness";

installStreamManagerTestHistory();

function managerOnTestClock(clock: TestEffectRunner, attempt: ScriptedAttempt) {
  const events: TurnEngineEvent[] = [];
  const streamManager = createStreamManagerForTests(historyService, {
    runner: clock.runner,
    eventSink: (event) => {
      events.push(event);
    },
    streamText: scriptedStreamText([attempt]),
  });
  return { events, streamManager };
}

// Durations are intervals on the stream's HostClock (#7282), so a test that advances the
// TestClock sees exactly that time instead of the few wall-clock milliseconds the run took.
describe("StreamManager - durations on the HostClock", () => {
  test("stream-end duration is the HostClock time since the stream started", async () => {
    const clock = makeTestEffectRunner();
    try {
      const { events, streamManager } = managerOnTestClock(clock, {
        chunks: [
          () => clock.adjust("90 seconds"),
          { type: "text-delta", text: "done" },
          STOP_FINISH,
        ],
      });
      const { completion } = await runTurnForTests(streamManager, { workspaceId: "duration-end" });
      expect(completion.status).toBe("completed");
      expect(eventsOfType(events, "stream-end")[0]?.metadata.duration).toBe(90_000);
    } finally {
      await clock.dispose();
    }
  });

  test("stream-abort duration is the HostClock time since the stream started", async () => {
    const clock = makeTestEffectRunner();
    try {
      const processed = Promise.withResolvers<void>();
      const { events, streamManager } = managerOnTestClock(clock, {
        chunks: [
          { type: "text-delta", text: "partial" },
          () => clock.adjust("45 seconds"),
          () => processed.resolve(),
        ],
        holdUntilAbort: true,
      });
      const workspaceId = "duration-abort";
      await appendPartialAssistantForTests(workspaceId, "duration-abort-message", 1);
      const started = await streamManager.startStream(
        testStartOptions({
          workspaceId,
          messageId: "duration-abort-message",
          model: createTestLanguageModel(),
          providedRuntimeTempDir: "",
        })
      );
      if (!started.success) throw new Error("Expected stream to start");
      await processed.promise;
      await streamManager.stopStream(workspaceId, { abortReason: "user" });
      expect((await started.data.completion).status).toBe("aborted");
      expect(eventsOfType(events, "stream-abort")[0]?.metadata?.duration).toBe(45_000);
    } finally {
      await clock.dispose();
    }
  });

  test("startup-abort duration is the HostClock time since the startup began", async () => {
    const clock = makeTestEffectRunner();
    const events: TurnEngineEvent[] = [];
    const streamManager = new StreamManager(
      historyService,
      undefined,
      undefined,
      (event) => {
        events.push(event);
      },
      clock.runner
    );
    try {
      const startup = streamManager.beginStreamStart({ workspaceId: "duration-startup" });
      await clock.adjust("30 seconds");
      await streamManager.stopStream("duration-startup", { abortReason: "user" });
      startup.finish();
      expect(eventsOfType(events, "stream-abort")[0]?.metadata?.duration).toBe(30_000);
    } finally {
      await clock.dispose();
    }
  });
});
