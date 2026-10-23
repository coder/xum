/**
 * Pins today's recovery after a backend dies in a turn (SIGKILL): the next
 * backend on the same root reclaims the dead holder's history write lock,
 * commits partial.json into its row and retries the turn. The fixture records
 * the behavior of the base, so later lock refactors cannot change it quietly.
 *
 * It spawns two real `xum server` processes with the mock model, because only
 * a real process death runs this path. It runs in bun test (~26 s locally).
 *
 * The fixture pins two open bugs as today's behavior: the mock reuses the
 * message id after a restart, so the retry text lands in row 1 and row 2 stays
 * empty (#7204), and a kill before partial.json exists is not retried (#7205,
 * not covered here). A PR that changes either one records the fixture again:
 * UPDATE_FIXTURE=1 bun test ./src/node/services/sessionLocks/backendKill.test.ts
 * and then `make fmt` (prettier reflows the JSON; the test compares parsed values).
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  makeProject,
  makeTempRoot,
  normalize,
  snapshot,
  startBackend,
  waitForPartial,
  writeDeadHistoryToken,
  type Backend,
} from "./backendKill.testHarness";

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "backendKill.json");

const live: Backend[] = [];
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((backend) => backend.killAndWait()));
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("a SIGKILL in a turn recovers as today", async () => {
  const root = await makeTempRoot();
  const project = await makeProject();
  temps.push(root, project);

  const a = await startBackend(root, project, live);
  const ws = await a.createWorkspace(project);
  const sending = a.send(ws, "[mock:long-stream] hello").catch((error: unknown) => error);
  await waitForPartial(root, ws);
  a.kill("SIGKILL");
  // Until Bun reaps A, the server lock of A names a live pid and B refuses to start.
  await a.exited;
  await sending;
  // A died holding the history write lock: B must judge it dead and take it over.
  await writeDeadHistoryToken(root, ws);
  const atKill = await snapshot(root, ws);

  const b = await startBackend(root, project, live); // startup recovery runs here
  await b.waitForStreamStartThenEnd(ws, 60_000);
  const recovered = await snapshot(root, ws);
  await b.stop();

  // Row 1 keeps the text that A streamed before it died.
  expect(atKill.partialText.length).toBeGreaterThan(0);
  expect(recovered.rowTexts[1].startsWith(atKill.partialText)).toBe(true);

  // The retry must persist its own output too, not only keep A's prefix. Today
  // it streams the whole mock reply again into row 1 (#7204), so the length of
  // the text after the prefix is the same in every run.
  const actual: Record<string, unknown> = {
    ...normalize(ws, { atKill, recovered }),
    retryTextLength: recovered.rowTexts[1].length - atKill.partialText.length,
  };
  if (process.env.UPDATE_FIXTURE === "1") {
    await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
    await fs.writeFile(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected = JSON.parse(await fs.readFile(FIXTURE, "utf-8")) as Record<string, unknown>;
  expect(actual).toEqual(expected);
}, 120_000);
