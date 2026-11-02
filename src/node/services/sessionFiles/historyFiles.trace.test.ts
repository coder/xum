/**
 * Proves that the history layer makes the same fs calls, in the same order and with the same
 * flags and modes, as the code before phase 2 moved them behind SessionFiles. The golden test
 * covers the bytes; this trace covers what bytes cannot show (a removed fsync, a rename before
 * its fsync, a changed mode). The fixture is generated: record it again with
 * `UPDATE_GOLDEN=1 bun test <this file>`, and only when a changed call is intended.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as prettier from "prettier";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { startCallTrace, type TraceRow } from "./callTrace.testHarness";
import { goldenStepContext, STEPS } from "./goldenScript.testHarness";

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "historyFiles.trace.json");

interface StepTrace {
  step: string;
  rows: TraceRow[];
}

test("today's code makes the golden fs call trace", async () => {
  const { historyService, config, tempDir, cleanup } = await createTestHistoryService();
  const context = goldenStepContext(historyService, config);
  const steps: StepTrace[] = [];
  // fs.appendFile creates chat.jsonl without a mode, so its mode (which writeFileAtomic later
  // copies into a chmod) comes from the umask. Pin a common umask so every machine records the
  // same modes.
  const umask = process.umask(0o022);
  // The outer finally removes the temp root even when a step fails.
  try {
    // The steps run without runGoldenScript's snapshots, whose reads would enter the trace.
    const trace = startCallTrace(tempDir, context.sessionDir);
    try {
      for (const step of STEPS) {
        const start = trace.rows.length;
        await step.run(context);
        steps.push({ step: step.name, rows: trace.rows.slice(start) });
      }
    } finally {
      trace.stop();
      process.umask(umask);
    }
    if (process.env.UPDATE_GOLDEN === "1") {
      // Format like `make fmt` does, so fmt-check accepts the recorded fixture as is.
      const options = await prettier.resolveConfig(FIXTURE);
      const text = await prettier.format(JSON.stringify(steps), { ...options, filepath: FIXTURE });
      await fs.writeFile(FIXTURE, text);
      return;
    }
    const fixture = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as StepTrace[];
    // toEqual reports the first step and row that differ.
    expect(steps).toEqual(fixture);
  } finally {
    await cleanup();
  }
});
