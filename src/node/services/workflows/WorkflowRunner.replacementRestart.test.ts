/**
 * G2 acceptance across a real process restart: process 1 ends a workflow step's child, process 2
 * (a fresh `bun` process on the same Xum root) resumes the run. See replacementRestart.testHarness.ts.
 */
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";

const FIXTURE = path.join(import.meta.dir, "replacementRestart.testHarness.ts");

async function runFixture(args: string[]): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, FIXTURE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split("\n").find((l) => l.startsWith("FIXTURE_RESULT "));
  if (exitCode !== 0 || line == null) {
    throw new Error(`fixture ${args[0]} failed (${exitCode}): ${stderr.slice(-4000)}`);
  }
  return JSON.parse(line.slice("FIXTURE_RESULT ".length)) as Record<string, unknown>;
}

describe("workflow step replacement across a backend restart (G2)", () => {
  let root: DisposableTempDir;

  beforeEach(() => {
    root = new DisposableTempDir("g2-replacement-restart");
  });
  afterEach(() => {
    root[Symbol.dispose]();
  });

  test("a child stopped without a report is replaced exactly once by the next process", async () => {
    const ended = await runFixture(["end", root.path, "no-report"]);
    expect(ended).toMatchObject({ childId: "priorchild01", row: { taskStatus: "interrupted" } });

    const resumed = await runFixture(["resume", root.path]);
    expect(resumed).toMatchObject({
      result: { reportMarkdown: "Final: report from replacement01" },
      children: ["priorchild01", "replacement01"],
      journal: "replacement01",
      priorRetiredBy: {
        childTaskId: "priorchild01",
        mode: "no-report",
        replacementTaskId: "replacement01",
      },
    });
  }, 60_000);

  test("a child that reported is never replaced: the next process uses its report", async () => {
    await runFixture(["end", root.path, "reported"]);

    const resumed = await runFixture(["resume", root.path]);
    expect(resumed).toMatchObject({
      result: { reportMarkdown: "Final: the prior child's report" },
      children: ["priorchild01"],
      journal: "priorchild01",
    });
    expect(resumed.priorRetiredBy).toBeUndefined();
  }, 60_000);
});
