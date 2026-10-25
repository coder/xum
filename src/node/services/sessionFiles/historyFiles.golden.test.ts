/**
 * Proves that the history layer writes the same session folder, byte for byte, as the code
 * before phase 2 moved its node:fs calls behind SessionFiles. The fixture is generated:
 * record it again with `UPDATE_GOLDEN=1 bun test <this file>`, and only when a byte change on
 * disk is intended (older builds read these files after a downgrade).
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as prettier from "prettier";
import { Layer } from "effect";
import { HostClockTag } from "@/node/services/di/hostClockLive";
import { createMemoryHost } from "@/node/services/hostFiles/memoryHostFiles.testHarness";
import { SessionLocksMemory } from "@/node/services/sessionLocks/memorySessionLocks.testHarness";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { nodeClock } from "@/node/utils/hostClock";
import { SessionFilesMemory } from "./memorySessionFiles.testHarness";
import { runGoldenScript, STEPS, type GoldenSnapshot } from "./goldenScript.testHarness";

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "historyFiles.golden.json");

test("today's code writes the golden session folder", async () => {
  const { historyService, config, files, cleanup } = await createTestHistoryService();
  try {
    const snapshots = await runGoldenScript(historyService, config, STEPS, files);
    if (process.env.UPDATE_GOLDEN === "1") {
      // Format like `make fmt` does, so fmt-check accepts the recorded fixture as is.
      const options = await prettier.resolveConfig(FIXTURE);
      const text = await prettier.format(JSON.stringify(snapshots), {
        ...options,
        filepath: FIXTURE,
      });
      await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
      await fs.writeFile(FIXTURE, text);
      return;
    }
    const fixture = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as GoldenSnapshot[];
    // toEqual reports the first differing step, listing entry or file content.
    expect(snapshots).toEqual(fixture);
  } finally {
    await cleanup();
  }
});

/** Every file and folder under root on the host disk, relative to root. */
async function listHostEntries(root: string): Promise<string[]> {
  const entries = await fs
    .readdir(root, { recursive: true, withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  return entries
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

// A history write that skips SessionFiles lands in the real temp folder instead of the volume,
// and a lock taken around SessionLocks, or its folder made on the disk, lands under <root>/locks.
test("the memory layers write the golden bytes and nothing on disk", async () => {
  const { historyService, config, files, tempDir, cleanup } = await createTestHistoryService({
    files: SessionFilesMemory,
    locks: SessionLocksMemory.pipe(
      Layer.provide(Layer.succeed(HostClockTag)(nodeClock)),
      Layer.provide(createMemoryHost().layer)
    ),
  });
  try {
    const snapshots = await runGoldenScript(historyService, config, STEPS, files);
    const fixture = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as GoldenSnapshot[];
    expect(snapshots).toEqual(fixture);
    expect(await listHostEntries(path.join(tempDir, "sessions"))).toEqual([]);
    // The memory locks make their folders on the memory volume.
    expect(await listHostEntries(path.join(tempDir, "locks"))).toEqual([]);
  } finally {
    await cleanup();
  }
});
