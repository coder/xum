import { describe, expect, test } from "bun:test";
import { ContextMutationGate } from "@/node/services/contextMutationGate";

function createGate() {
  const state = { turnWork: false, streaming: false, sendInPreflight: false, holds: 0 };
  const gate = new ContextMutationGate({
    getOrCreateSession: () => ({
      holdTurnAdmission: () => {
        state.holds++;
        return {
          [Symbol.dispose]: () => {
            state.holds--;
          },
        };
      },
      hasActiveOrPendingTurnWork: () => state.turnWork,
    }),
    isStreaming: () => state.streaming,
    hasSendInPreflight: () => state.sendInPreflight,
  });
  return { gate, state };
}

describe("ContextMutationGate", () => {
  test("an idle workspace admits one mutation, which blocks sends until disposed", () => {
    const { gate, state } = createGate();
    const result = gate.acquireContextMutationAdmissionGuard("ws", "reset context");
    expect(result.success).toBe(true);
    expect(gate.isMutating("ws")).toBe(true);
    expect(gate.isMutating("ws-other")).toBe(false);
    expect([...gate.mutatingWorkspaceIds()]).toEqual(["ws"]);
    expect(state.holds).toBe(1);

    // One mutation at a time per workspace.
    const second = gate.acquireContextMutationAdmissionGuard("ws", "replace history");
    expect(second.success).toBe(false);
    expect(state.holds).toBe(1);

    if (result.success) result.data[Symbol.dispose]();
    expect(gate.isMutating("ws")).toBe(false);
    expect(state.holds).toBe(0);
  });

  test.each([
    ["turn work", { turnWork: true }, "while a turn is active"],
    ["a stream", { streaming: true }, "while a turn is active"],
    ["a send in preflight", { sendInPreflight: true }, "while a message is being sent"],
  ] as const)("refuses and releases its hold during %s", (_name, busy, reason) => {
    const { gate, state } = createGate();
    Object.assign(state, busy);
    const result = gate.acquireContextMutationAdmissionGuard("ws", "truncate history");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(reason);
    expect(gate.isMutating("ws")).toBe(false);
    expect(state.holds).toBe(0);
  });

  test("the epoch counts completed mutations per workspace", () => {
    const { gate } = createGate();
    expect(gate.epoch("ws")).toBe(0);
    gate.advanceContextMutationEpoch("ws");
    gate.advanceContextMutationEpoch("ws");
    expect(gate.epoch("ws")).toBe(2);
    expect(gate.epoch("ws-other")).toBe(0);
  });
});
