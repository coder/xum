import { EventEmitter } from "node:events";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { Err, Ok } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import type { TurnCompletion } from "./streamManager";

const workspaceId = "session-plan-review-snapshot";
const model = "openai:gpt-4o";
const sendOptions = { model, agentId: "exec" };
const end: StreamEndEvent = {
  type: "stream-end",
  workspaceId,
  messageId: "assistant-1",
  metadata: { model },
  parts: [{ type: "text", text: "Proposed." }],
};

describe("AgentSession plan-review snapshot capture", () => {
  let h: AgentSessionHarness | undefined;
  // Stands in for the slow runtime read: the capture cannot finish until the gate opens.
  let metadataGate = Promise.withResolvers<void>();

  afterEach(async () => {
    // A failed assertion must not leave the capture (and dispose) waiting on the gate forever.
    metadataGate.resolve();
    await h?.session.dispose();
    await h?.cleanup();
    h = undefined;
    metadataGate = Promise.withResolvers<void>();
  });

  test("turn completion waits for an in-flight propose_plan snapshot capture", async () => {
    // The tool-call-end listener runs detached (`void handler(...)`), so awaiting the capture
    // inside it never delayed anything. The plan file is mutable: if the turn settles while
    // getWorkspaceMetadata/readPlanFile are still pending, the next turn (or the user) can
    // revise the plan and the snapshot keyed to THIS proposal captures the later revision.
    const completion = Promise.withResolvers<TurnCompletion>();
    const metadataRequested = Promise.withResolvers<void>();
    const emitter = new EventEmitter();
    const order: string[] = [];
    const settled = Promise.withResolvers<void>();
    let gateArmed = false;
    h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      onTurnSettled: () => {
        order.push("settled");
        settled.resolve();
      },
      aiServiceOverrides: {
        streamMessage: mock(() => {
          emitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId: "assistant-1",
            model,
            startTime: Date.now(),
          });
          return Promise.resolve(Ok({ messageId: "assistant-1", completion: completion.promise }));
        }),
        // Send preflight reads metadata too; only the capture's read (after tool-call-end)
        // is parked on the gate.
        getWorkspaceMetadata: mock(async (id: string) => {
          if (!gateArmed) {
            return Ok({
              id,
              name: id,
              projectName: "project",
              projectPath: "/tmp/project",
              runtimeConfig: { type: "local" as const },
            });
          }
          metadataRequested.resolve();
          await metadataGate.promise;
          order.push("capture-settled");
          return Err("workspace metadata unavailable in this fixture");
        }),
      },
    });
    expect((await h.session.sendMessage("propose", sendOptions)).success).toBe(true);
    gateArmed = true;
    emitter.emit("tool-call-end", {
      type: "tool-call-end",
      workspaceId,
      messageId: "assistant-1",
      toolCallId: "call-plan",
      toolName: "propose_plan",
      result: { success: true },
      timestamp: Date.now(),
    });
    await metadataRequested.promise;
    completion.resolve({ status: "completed", streamEnd: end });

    // Generous bound: the completion policy has every chance to run to idle here, and must not.
    const settledEarly = await Promise.race([
      settled.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(settledEarly).toBe(false);
    expect(h.session.isBusy()).toBe(true);

    metadataGate.resolve();
    await settled.promise;
    await h.session.waitForIdle();
    // Non-throwing capture failures (metadata unavailable) still release the turn.
    expect(order).toEqual(["capture-settled", "settled"]);
    expect(h.events.filter((event) => event.type === "stream-end")).toHaveLength(1);
  });
});
