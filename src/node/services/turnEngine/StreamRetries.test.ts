import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { MuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
import { makeTestEffectRunner, type TestEffectRunner } from "@/node/services/di/testEffectRunner";
import type { HistoryService } from "@/node/services/historyService";
import { log } from "@/node/services/log";
import { createWorkspaceStreamInfoForTests } from "@/node/services/streamManager.suite.testHarness";
import { createTestHistoryService } from "@/node/services/testHistoryService";

import { PartialJournal } from "./PartialJournal";
import { ProviderRequest } from "./ProviderRequest";
import { StreamRetries } from "./StreamRetries";
import type { WorkspaceId } from "./types";
import { UsageLedger } from "./UsageLedger";

const WORKSPACE_ID = "retry-reset-workspace" as WorkspaceId;

const partialOf = (id: string): MuxMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: `partial of ${id}` }],
  metadata: { historySequence: 1 },
});

describe("StreamRetries.resetStreamStateForRetry", () => {
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let clock: TestEffectRunner;
  let retries: StreamRetries;

  beforeEach(async () => {
    ({ historyService, cleanup } = await createTestHistoryService());
    clock = makeTestEffectRunner();
    const deps = { getProvidersConfig: () => null, workspaceLogger: () => log };
    retries = new StreamRetries({
      partialJournal: new PartialJournal({
        historyService,
        runner: clock.runner,
        clock: clock.hostClock,
        throttleMs: 500,
      }),
      usageLedger: new UsageLedger(deps),
      providerRequest: new ProviderRequest(deps),
      getWorkspaceLogger: () => log,
      createStreamResult: () => {
        throw new Error("a reset starts no stream");
      },
      moveAnthropicThinkingReplayPoint: () => false,
      flushPartialWrite: () => Promise.resolve(),
    });
  });

  afterEach(async () => {
    await clock.dispose();
    await cleanup();
  });

  const resetWithoutParts = (messageId: string) => {
    const streamInfo = createWorkspaceStreamInfoForTests({ messageId });
    return retries.resetStreamStateForRetry(WORKSPACE_ID, streamInfo, { preserveParts: false });
  };

  // The preserve-parts reset is proven publicly by errorRecovery's step-boundary
  // previousResponseId retry, which commits stepStartPartIndices [0, 1].
  test("a reset that discards the parts discards their step indices too", async () => {
    const streamInfo = createWorkspaceStreamInfoForTests({
      parts: [{ type: "text", text: "discarded", timestamp: 1 }],
      stepStartIndices: [0, 1, 3],
      currentStepStartIndex: 1,
      streamStepOrdinals: [0, 1],
      reasoningBackfillStartIndex: 1,
      currentReasoningBlock: {},
      receivedTerminalEvent: true,
      terminalFinishReason: "stop",
    });
    await retries.resetStreamStateForRetry(WORKSPACE_ID, streamInfo, { preserveParts: false });
    expect(streamInfo.parts).toEqual([]);
    expect(streamInfo.stepStartIndices).toEqual([0]);
    expect(streamInfo.currentStepStartIndex).toBe(0);
    // The retried streamText numbers its steps from 0 and has no reasoning or finish yet.
    expect(streamInfo.streamStepOrdinals).toEqual([]);
    expect(streamInfo.reasoningBackfillStartIndex).toBeUndefined();
    expect(streamInfo.currentReasoningBlock).toBeUndefined();
    expect(streamInfo.receivedTerminalEvent).toBe(false);
    expect(streamInfo.terminalFinishReason).toBeUndefined();
  });

  // #7499: the reset clears only this stream's partial.
  test("deletes this stream's partial and keeps another stream's partial", async () => {
    await historyService.writePartial(WORKSPACE_ID, partialOf("this-message"));
    await resetWithoutParts("this-message");
    expect(await historyService.readPartial(WORKSPACE_ID)).toBeNull();

    // Another backend (XUM_ALLOW_MULTIPLE_INSTANCES) replaced partial.json: its crash-recovery
    // state must survive this stream's retry.
    await historyService.writePartial(WORKSPACE_ID, partialOf("other-message"));
    await resetWithoutParts("this-message");
    expect((await historyService.readPartial(WORKSPACE_ID))?.id).toBe("other-message");
  });

  test("logs a failed delete and continues the retry", async () => {
    await historyService.writePartial(WORKSPACE_ID, partialOf("this-message"));
    spyOn(historyService, "deletePartialIfMessageIdMatches").mockResolvedValueOnce(
      Err("Failed to delete matching partial: EACCES")
    );
    const warn = spyOn(log, "warn");
    try {
      await resetWithoutParts("this-message");
      const call = warn.mock.calls.find(
        (args) => args[0] === "Failed to clear partial state before retry"
      );
      expect(call?.[1]).toEqual({ error: "Failed to delete matching partial: EACCES" });
    } finally {
      warn.mockRestore();
    }
  });
});
