import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { historyStatusScanReaders } from "./historyStatusScanReaders";

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("historyStatusScanReaders", () => {
  test("waits for every scan holding a path, and a repeated release frees nothing extra", async () => {
    const file = path.join("status-scan-readers", "chat.jsonl");
    const first = historyStatusScanReaders.track([file]);
    const second = historyStatusScanReaders.track([file]);
    let closed = false;
    const wait = historyStatusScanReaders.waitForClose(file).then(() => (closed = true));
    first();
    first();
    await drainMicrotasks();
    expect(closed).toBe(false);
    second();
    await wait;
    expect(closed).toBe(true);
  });
});
