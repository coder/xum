import { describe, test } from "bun:test";

import { CliStreamWaits } from "./runStreamWaits";

/** The run's own first turn: armed by the send, then started and ended. */
async function completeSentTurn(waits: CliStreamWaits): Promise<void> {
  waits.arm();
  waits.onStreamStart();
  waits.onStreamEnd();
  await waits.waitForCompletion();
}

describe("CliStreamWaits", () => {
  // The session's stream-end hook dispatched the goal continuation, and its stream
  // started, before the goal driver called prepareForContinuation.
  test("the driver awaits a continuation that started before it armed its wait", async () => {
    const waits = new CliStreamWaits();
    await completeSentTurn(waits);

    waits.onStreamStart();
    waits.prepareForContinuation();
    const started = waits.waitForStreamStarted();
    waits.onStreamEnd();

    await started;
    await waits.waitForCompletion();
  });

  test("without an early stream, the driver waits for the continuation it requests", async () => {
    const waits = new CliStreamWaits();
    await completeSentTurn(waits);

    waits.prepareForContinuation();
    const started = waits.waitForStreamStarted();
    waits.onStreamStart();
    waits.onStreamEnd();

    await started;
    await waits.waitForCompletion();
  });
});
