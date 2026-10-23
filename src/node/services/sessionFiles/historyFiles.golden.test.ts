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
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { runGoldenScript, STEPS, type GoldenSnapshot } from "./goldenScript.testHarness";

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "historyFiles.golden.json");

test("today's code writes the golden session folder", async () => {
  const { historyService, config, cleanup } = await createTestHistoryService();
  try {
    const snapshots = await runGoldenScript(historyService, config, STEPS);
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
