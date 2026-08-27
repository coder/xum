import { describe, test, expect } from "bun:test";
import { runBestEffortCleanup, type RunCleanupStep } from "./runCleanup";

describe("runBestEffortCleanup", () => {
  test("a throwing step does not stop later steps and never propagates", async () => {
    const ran: string[] = [];
    const reported: Array<{ step: string; error: unknown }> = [];
    const steps: RunCleanupStep[] = [
      { name: "first", run: () => void ran.push("first") },
      {
        name: "sync-throw",
        run: () => {
          throw new Error("sync boom");
        },
      },
      { name: "async-reject", run: () => Promise.reject(new Error("async boom")) },
      { name: "last", run: () => void ran.push("last") },
    ];

    await runBestEffortCleanup(steps, (step, error) => reported.push({ step, error }));

    expect(ran).toEqual(["first", "last"]);
    expect(reported.map((r) => r.step)).toEqual(["sync-throw", "async-reject"]);
    expect((reported[0].error as Error).message).toBe("sync boom");
    expect((reported[1].error as Error).message).toBe("async boom");
  });

  test("steps run in declaration order and awaited sequentially", async () => {
    const order: string[] = [];
    await runBestEffortCleanup(
      [
        {
          name: "slow",
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            order.push("slow");
          },
        },
        { name: "fast", run: () => void order.push("fast") },
      ],
      () => undefined
    );
    expect(order).toEqual(["slow", "fast"]);
  });

  test("a throwing error reporter does not break remaining cleanup", async () => {
    const ran: string[] = [];
    await runBestEffortCleanup(
      [
        {
          name: "boom",
          run: () => {
            throw new Error("boom");
          },
        },
        { name: "after", run: () => void ran.push("after") },
      ],
      () => {
        throw new Error("reporter boom");
      }
    );
    expect(ran).toEqual(["after"]);
  });
});
