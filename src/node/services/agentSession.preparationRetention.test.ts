import { describe, expect, test } from "bun:test";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const options = { model: "openai:gpt-4o", agentId: "exec" };

/** Full GCs until the target is collected; rounds absorb stale conservative stack slots. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let round = 0; round < 20 && ref.deref() !== undefined; round++) {
    await Bun.sleep(0);
    Bun.gc(true);
  }
  return ref.deref() === undefined;
}

describe("AgentSession preparation retention", () => {
  // F29 heap snapshot: closures handed to the stream request (stopFence, onPreStartError, ...)
  // live as long as the turn's tool configuration, and a finished background command kept that
  // alive. Through streamWithHistory's `preparation`, they kept the pre-stream failure callback
  // and WorkspaceService's whole send scope behind it.
  test("a started stream's request closures do not keep the pre-stream failure callback alive", async () => {
    const h = await createAgentSessionHarness({ workspaceId: "preparation-retention" });
    try {
      // The callback and its scope live only in this helper's frame, which has finished
      // before the GC check, so only the WeakRef reaches this one. A callback held in a
      // local of this async test would stay alive across its awaits whenever JSC keeps
      // dead locals (interpreter or baseline tiers): the test then failed by chance in
      // the shared CI shard, and in 2 of 5 runs with BUN_JSC_useJIT=0 (#7061).
      const { callbackScopeRef, result } = await (async () => {
        const callbackScope = { payload: new Array<number>(1000).fill(1) };
        return {
          callbackScopeRef: new WeakRef(callbackScope),
          result: await h.session.sendMessage("hello", options, {
            acceptanceOrigin: "automatic",
            onAcceptedPreStreamFailure: () => void callbackScope.payload.length,
          }),
        };
      })();
      expect(result.success).toBe(true);
      // The stream started. The streamMessage mock keeps its call arguments, standing in for
      // a tool configuration that outlives the turn.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- a mock, never called here
      expect(h.aiService.streamMessage).toHaveBeenCalledTimes(1);

      expect(await collected(callbackScopeRef)).toBe(true);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });
});
