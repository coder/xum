import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { unlockedHistoryScans } from "./unlockedHistoryScans";

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("unlockedHistoryScans", () => {
  test("waits for every scan holding a path, and a repeated release frees nothing extra", async () => {
    const file = path.join("unlocked-history-scans", "chat.jsonl");
    const first = unlockedHistoryScans.track([file]);
    const second = unlockedHistoryScans.track([file]);
    let closed = false;
    const wait = unlockedHistoryScans.waitForClose(file).then(() => (closed = true));
    first();
    first();
    await drainMicrotasks();
    expect(closed).toBe(false);
    second();
    await wait;
    expect(closed).toBe(true);
  });
});
