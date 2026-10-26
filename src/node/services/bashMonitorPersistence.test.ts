import { describe, expect, mock, test } from "bun:test";
import type { MonitorArmedPayload } from "@/node/services/backgroundProcessManager";
import { BashMonitorPersistence } from "@/node/services/bashMonitorPersistence";

const armed: MonitorArmedPayload = {
  processId: "proc-1",
  taskId: "bash:1",
  workspaceId: "ws",
  filter: "ERROR",
  filterExclude: false,
  script: "make test",
  createdAt: "2026-10-26T00:00:00.000Z",
};

function harness(options: { removing?: boolean } = {}) {
  const registry = {
    upsert: mock((_payload: MonitorArmedPayload) => Promise.resolve()),
    remove: mock(() => Promise.resolve()),
    recordTerminal: mock(() => Promise.resolve()),
    recordLost: mock((..._args: unknown[]) => Promise.resolve()),
  };
  const discardProcess = mock(() => Promise.resolve());
  const persisted: string[] = [];
  const persistence = new BashMonitorPersistence({
    registry: () => registry,
    discardProcess,
    isRemoving: () => options.removing === true,
    onPersisted: (workspaceId) => persisted.push(workspaceId),
  });
  return { persistence, registry, discardProcess, persisted };
}

describe("BashMonitorPersistence", () => {
  test("drain waits for an armed write, and the reconcile follows it", async () => {
    const { persistence, registry, persisted } = harness();
    let release!: () => void;
    registry.upsert.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    persistence.onMonitorArmed(armed);
    let drained = false;
    const drain = persistence.drainBashMonitorPersistence("ws").then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);

    release();
    await drain;
    expect(persisted).toEqual(["ws"]);
  });

  test("a removing workspace persists nothing", async () => {
    const { persistence, registry, discardProcess } = harness({ removing: true });
    persistence.onMonitorArmed(armed);
    persistence.onMonitorStopped("ws", {
      processId: "proc-1",
      reason: "canceled",
      armMetadata: armed,
    });
    await persistence.drainBashMonitorPersistence("ws");
    expect(registry.upsert).not.toHaveBeenCalled();
    expect(discardProcess).not.toHaveBeenCalled();
  });

  test("a failed write is retried, then the monitor is recorded as lost", async () => {
    const { persistence, registry, persisted } = harness();
    registry.recordLost.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    persistence.onMonitorStopped("ws", {
      processId: "proc-1",
      reason: "failed",
      failureMessage: "probe failed",
      armMetadata: armed,
    });
    await persistence.drainBashMonitorPersistence("ws");
    expect(registry.recordLost).toHaveBeenCalledTimes(2);
    expect(registry.recordLost.mock.calls[1]?.[3]).toMatchObject({
      reason: "runtime-failure",
      failureMessage: "probe failed",
    });
    expect(persisted).toEqual(["ws"]);
  });

  test("a cancellation stops the failed monitor's retries and discards it", async () => {
    const { persistence, registry, discardProcess, persisted } = harness();
    registry.recordLost.mockImplementation(() => Promise.reject(new Error("disk full")));
    persistence.onMonitorStopped("ws", {
      processId: "proc-1",
      reason: "failed",
      armMetadata: armed,
    });
    // Let the first attempt fail, so the chain sits in its retry delay.
    await new Promise((resolve) => setTimeout(resolve, 10));
    persistence.onMonitorStopped("ws", {
      processId: "proc-1",
      reason: "canceled",
      armMetadata: armed,
    });
    await persistence.drainBashMonitorPersistence("ws");

    expect(registry.recordLost).toHaveBeenCalledTimes(1);
    expect(discardProcess).toHaveBeenCalledWith("ws", "proc-1", armed.createdAt);
    expect(registry.remove).toHaveBeenCalledWith("ws", "proc-1", armed.createdAt);
    // Only the cancellation reconciles: the canceled failure chain never reports success.
    expect(persisted).toEqual(["ws"]);
  });

  test("a cancellation during the lost write keeps the failed chain from reconciling", async () => {
    const { persistence, registry, persisted } = harness();
    let release!: () => void;
    registry.recordLost.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    persistence.onMonitorStopped("ws", {
      processId: "proc-1",
      reason: "failed",
      armMetadata: armed,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    persistence.onMonitorStopped("ws", {
      processId: "proc-1",
      reason: "canceled",
      armMetadata: armed,
    });
    release();
    await persistence.drainBashMonitorPersistence("ws");
    expect(persisted).toEqual(["ws"]);
  });
});
