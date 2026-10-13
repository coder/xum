import { describe, expect, spyOn, test } from "bun:test";

import { Err } from "@/common/types/result";
import { HistoryService } from "@/node/services/historyService";
import { REPLAY_FIXTURE_WORKSPACE_ID } from "@/node/services/replay/replayFixture";
import { cacheAuditCommand } from "./cache-audit";

const STEP_AUDIT_HEADER = "Prompt-cache prefix rule over every recorded step";

/** Run the command on the committed fixture session and collect what it printed. */
async function runOnFixture(): Promise<{ out: string; err: string; exitCode: unknown }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.join(" "));
  });
  const previousExitCode = process.exitCode;
  try {
    await cacheAuditCommand(REPLAY_FIXTURE_WORKSPACE_ID);
    return { out: out.join("\n"), err: err.join("\n"), exitCode: process.exitCode };
  } finally {
    // Bun keeps a set exit code when it is assigned `undefined`, so restore an unset one as 0.
    process.exitCode = previousExitCode ?? 0;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("bun debug cache-audit", () => {
  test("audits every recorded step when the history reads", async () => {
    const { out, err } = await runOnFixture();
    expect(out).toContain(STEP_AUDIT_HEADER);
    expect(err).toBe("");
  });

  test("skips the step audit and reports the error when the history read fails", async () => {
    const historySpy = spyOn(HistoryService.prototype, "iterateFullHistory").mockResolvedValue(
      Err("chat.jsonl: permission denied")
    );
    let result: Awaited<ReturnType<typeof runOnFixture>>;
    try {
      result = await runOnFixture();
    } finally {
      historySpy.mockRestore();
    }
    const { out, err, exitCode } = result;
    // The envelope audit still runs (without usage); the step audit does not.
    expect(out).toContain("Cache-bust audit");
    expect(out).not.toContain(STEP_AUDIT_HEADER);
    expect(err).toContain("chat.jsonl: permission denied");
    expect(exitCode).toBe(1);
  });
});
