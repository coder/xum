import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";

import type { BranchListResult } from "@/common/orpc/types";
import { startBranchListLoad, type BranchListLoadOutcome } from "./branchListLoad";

const LIST: BranchListResult = { branches: ["main", "dev"], recommendedTrunk: "main" };

/** A list whose settlement the test controls. */
function heldList() {
  let resolve!: (result: BranchListResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<BranchListResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { load: () => promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const advance = (ms: number) =>
  (jest as unknown as { advanceTimersByTime: (ms: number) => void }).advanceTimersByTime(ms);

describe("startBranchListLoad", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    mock.restore();
  });

  test("reports the list when it loads in time", async () => {
    const list = heldList();
    const outcomes: BranchListLoadOutcome[] = [];
    startBranchListLoad(list.load, (outcome) => outcomes.push(outcome), 1_000);
    list.resolve(LIST);
    await flush();
    advance(2_000);
    expect(outcomes).toEqual([{ status: "loaded", ...LIST }]);
  });

  test("reports failed when the list rejects", async () => {
    const list = heldList();
    const outcomes: BranchListLoadOutcome[] = [];
    startBranchListLoad(list.load, (outcome) => outcomes.push(outcome), 1_000);
    list.reject(new Error("git for-each-ref failed"));
    await flush();
    expect(outcomes).toEqual([{ status: "failed" }]);
  });

  test("reports failed at the deadline, then the list if it settles later", async () => {
    const list = heldList();
    const outcomes: BranchListLoadOutcome[] = [];
    startBranchListLoad(list.load, (outcome) => outcomes.push(outcome), 1_000);
    advance(999);
    expect(outcomes).toEqual([]);
    advance(1);
    expect(outcomes).toEqual([{ status: "failed" }]);
    list.resolve(LIST);
    await flush();
    expect(outcomes).toEqual([{ status: "failed" }, { status: "loaded", ...LIST }]);
  });

  test("reports nothing after cancel", async () => {
    const list = heldList();
    const outcomes: BranchListLoadOutcome[] = [];
    const cancel = startBranchListLoad(list.load, (outcome) => outcomes.push(outcome), 1_000);
    cancel();
    advance(2_000);
    list.resolve(LIST);
    await flush();
    expect(outcomes).toEqual([]);
  });
});
