import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { hashSessionTapeWorkspaceId } from "@/node/services/sessionTapes/sessionTapeRecorder";
import { readSessionTapeFile } from "@/node/services/sessionTapes/sessionTapeFile";
import {
  buildTapeReplayFixtureTape,
  TAPE_REPLAY_FIXTURE_FILE_NAME,
  TAPE_REPLAY_FIXTURE_WORKSPACE_ID,
} from "../../tests/e2e/fixtures/sessionTapes/tapeReplayFixture";

const FIXTURE_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "e2e",
  "fixtures",
  "sessionTapes",
  TAPE_REPLAY_FIXTURE_FILE_NAME
);

describe("perf.tapeReplay fixture tape", () => {
  test("loads as a complete tape recorded for the scenario's workspace id", async () => {
    const result = await readSessionTapeFile(FIXTURE_PATH);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The replay source refuses a tape whose hash does not match the mapped workspace.
    expect(result.header.workspaceIdHash).toBe(
      hashSessionTapeWorkspaceId(TAPE_REPLAY_FIXTURE_WORKSPACE_ID)
    );
  });

  test("matches its generator (run bun scripts/perf/generateTapeReplayFixture.ts after edits)", () => {
    expect(readFileSync(FIXTURE_PATH, "utf-8")).toBe(buildTapeReplayFixtureTape());
  });
});
