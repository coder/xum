import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { EventLoopYielder } from "@/node/utils/concurrency/eventLoopYielder";
import { json, rowsToBytes } from "./historyScanner.generator.testHarness";
import { readProviderHistory } from "./historyScanner";

// #5301: the assembly loop after the per-file scans awaited only microtasks, so a large epoch was
// one long event-loop block. It now yields a macrotask once its budget is used; a fake clock
// makes every budget check due, so the test does not depend on machine speed.
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-assembly-yield-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test("assembly yields between rows and returns the same rows", async () => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    json(createMuxMessage(`m${i}`, i % 2 ? "assistant" : "user", `row ${i}`))
  );
  // A boundary in the middle: rows before it are scanned but not part of the read.
  rows.splice(
    80,
    0,
    json(
      createMuxMessage("boundary", "assistant", "Summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
      })
    )
  );
  const paths = { chat: path.join(dir, "chat.jsonl"), archive: path.join(dir, "archive.jsonl") };
  await fs.writeFile(paths.chat, rowsToBytes(rows));
  const reference = await readProviderHistory(paths);
  expect(reference.map((m) => m.id)[0]).toBe("boundary");

  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => (now += 10));
  const yields = spyOn(EventLoopYielder.prototype, "yield");
  try {
    const assembled = await readProviderHistory(paths);
    expect(assembled).toEqual(reference);
    // Every returned row was preceded by a due check, and each due check yielded.
    expect(yields.mock.calls.length).toBeGreaterThanOrEqual(reference.length);
  } finally {
    clock.mockRestore();
    yields.mockRestore();
  }
});
