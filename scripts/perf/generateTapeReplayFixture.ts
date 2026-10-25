/**
 * Regenerate the synthetic session tape fixture of the `perf.tapeReplay` e2e scenario:
 *   bun scripts/perf/generateTapeReplayFixture.ts
 */
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildTapeReplayFixtureTape,
  TAPE_REPLAY_FIXTURE_FILE_NAME,
} from "../../tests/e2e/fixtures/sessionTapes/tapeReplayFixture";

const target = path.join(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "e2e",
  "fixtures",
  "sessionTapes",
  TAPE_REPLAY_FIXTURE_FILE_NAME
);
writeFileSync(target, buildTapeReplayFixtureTape());
console.log(`Wrote ${path.relative(process.cwd(), target)}`);
