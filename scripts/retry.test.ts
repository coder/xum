// Tests for scripts/retry.sh: each test spawns the real script. A stub `sleep` first on PATH
// records each wait and returns at once, so the wait sequence is asserted without waiting.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally: bun test ./scripts/retry.test.ts
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SPAWNING_TEST_TIMEOUT_MS,
  runScript,
  writeExecutable,
  type RunResult,
} from "./ci/runScript";

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

const RETRY = path.resolve(import.meta.dir, "retry.sh");

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "retry-"));
  await writeExecutable(path.join(work, "sleep"), `echo "$1" >> "${work}/sleeps"`);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function retry(args: string[]): Promise<RunResult> {
  return runScript([RETRY, ...args], {
    cwd: work,
    env: { PATH: `${work}:${process.env.PATH ?? ""}` },
  });
}

async function lines(file: string): Promise<string[]> {
  const text = await readFile(path.join(work, file), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

// Appends a line to `runs` and exits `status` until it has run `succeedOn` times.
async function command(options: { succeedOn?: number; status?: number; seconds?: number }) {
  const script = path.join(work, "cmd");
  const { succeedOn = Infinity, status = 1, seconds = 0 } = options;
  const nap = seconds > 0 ? `/bin/sleep ${seconds}` : "true";
  await writeExecutable(
    script,
    `echo run >> "${work}/runs"\n${nap}\n[ "$(wc -l < "${work}/runs")" -ge ${succeedOn} ] || exit ${status}`
  );
  return script;
}

describe("fixed backoff (the original interface)", () => {
  test("waits the same time before each retry and stops at the first success", async () => {
    const result = await retry(["3", "30", await command({ succeedOn: 3 })]);
    expect(result.exitCode).toBe(0);
    expect(await lines("runs")).toHaveLength(3);
    expect(await lines("sleeps")).toEqual(["30", "30"]);
  });

  test("gives up after max_attempts with exit 1 and no wait after the last try", async () => {
    const result = await retry(["3", "30", await command({})]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("All 3 attempts failed");
    expect(await lines("runs")).toHaveLength(3);
    expect(await lines("sleeps")).toEqual(["30", "30"]);
  });

  test("passes its arguments to the command unchanged", async () => {
    const result = await retry(["1", "0", "printf", "%s|", "a b", "c"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a b|c|");
  });
});

describe("exponential backoff", () => {
  test("doubles the wait up to the cap", async () => {
    const result = await retry([
      "--max-backoff-secs",
      "60",
      "--budget-secs",
      "900",
      "0",
      "2",
      await command({ succeedOn: 9 }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(await lines("sleeps")).toEqual(["2", "4", "8", "16", "32", "60", "60", "60"]);
  });

  test("stops when the next wait would end after the budget, counting the wait", async () => {
    // Each try takes 1 s, so the wait before try 4 (16 s) is the first to pass the 15 s budget.
    // A budget check that ignored the wait would run on until the tries alone took 15 s.
    const result = await retry([
      "--max-backoff-secs",
      "60",
      "--budget-secs",
      "15",
      "0",
      "2",
      await command({ seconds: 1 }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("15s budget is spent");
    expect(await lines("runs")).toHaveLength(4);
    expect(await lines("sleeps")).toEqual(["2", "4", "8"]);
  });

  test("gives up at once on a fatal status", async () => {
    const result = await retry([
      "--fatal-status",
      "64",
      "--budget-secs",
      "60",
      "0",
      "2",
      await command({ status: 64 }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("retrying cannot change");
    expect(await lines("runs")).toHaveLength(1);
    expect(await lines("sleeps")).toEqual([]);
  });

  test("keeps retrying a status that is not fatal", async () => {
    const result = await retry([
      "--fatal-status",
      "64",
      "--budget-secs",
      "60",
      "0",
      "2",
      await command({ status: 3, succeedOn: 2 }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(await lines("runs")).toHaveLength(2);
  });
});

describe.skipIf(!Bun.which("timeout") && !Bun.which("gtimeout"))(
  "cutting a running try off",
  () => {
    // A stub `timeout` records its arguments (`-k 5 <secs> cmd...`) and runs cmd, so the cut that
    // retry.sh asks for is read, not waited for. retry.sh takes `timeout` first and `gtimeout`
    // second, so the stub stands in for both.
    async function stubTimeout(): Promise<void> {
      for (const name of ["timeout", "gtimeout"]) {
        await writeExecutable(
          path.join(work, name),
          `echo "$1 $2 $3" >> "${work}/cuts"\nshift 3\nexec "$@"`
        );
      }
    }

    // bash counts `$SECONDS` in whole seconds, and retry.sh reads it twice (when it starts the budget
    // and when it cuts a try), so a second boundary between the two reads takes one second off a cut:
    // 8 for 9. A host that stalls the script for longer takes more off. So one cut can be anything
    // from 5 to 9. Of three runs at least one has no stall, so the largest first cut is the whole
    // budget. A budget that is off by one second (remaining - 1, + 1, - 2, + 2) never cuts at 9.
    test("cuts each later try off at what is left of the budget, not at the whole budget", async () => {
      await stubTimeout();
      for (let run = 0; run < 3; run++) {
        // `command` counts its runs in the file `runs`: start each run with a new count.
        await rm(path.join(work, "runs"), { force: true });
        const result = await retry([
          "--budget-secs",
          "9",
          "0",
          "0",
          await command({ succeedOn: 2, seconds: 2 }),
        ]);
        expect(result.exitCode).toBe(0);
      }
      const seconds = (await lines("cuts")).map((cut) => Number(cut.split(" ")[2]));
      expect(seconds).toHaveLength(6);
      const firsts = [seconds[0], seconds[2], seconds[4]];
      for (const first of firsts) {
        expect(first).toBeGreaterThanOrEqual(5);
        expect(first).toBeLessThanOrEqual(9);
      }
      expect(Math.max(...firsts)).toBe(9);
      // The second try follows a try that took 2 s, so it is cut off at 7 s or less, never at 9.
      for (const second of [seconds[1], seconds[3], seconds[5]]) {
        expect(second).toBeGreaterThan(0);
        expect(second).toBeLessThanOrEqual(7);
      }
    });

    test("kills a try that ignores the TERM 5 seconds after the cut", async () => {
      await stubTimeout();
      // The same rule as the test above: each cut is 5 to 9, and one of three runs cuts at 9.
      for (let run = 0; run < 3; run++) {
        await retry(["--budget-secs", "9", "0", "0", await command({ succeedOn: 1 })]);
      }
      const cuts = await lines("cuts");
      expect(cuts).toHaveLength(3);
      for (const cut of cuts) expect(cut).toMatch(/^-k 5 [5-9]$/);
      expect(cuts).toContain("-k 5 9");
    });

    test("still cuts a try off when nothing is left of the budget", async () => {
      // `timeout 0` means no limit. With a budget of 0 the first try starts with 0 seconds left,
      // and retry.sh must still cut it off (at 1 second) instead of letting it run to its end.
      const started = Date.now();
      const result = await retry(["--budget-secs", "0", "0", "1", "/bin/sleep", "15"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("exit 124");
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  }
);

describe("usage", () => {
  test("refuses missing arguments, non-numeric values and an unlimited retry without a budget", async () => {
    expect((await retry([])).exitCode).toBe(2);
    expect((await retry(["3", "soon", "true"])).exitCode).toBe(2);
    expect((await retry(["--budget-secs", "many", "3", "1", "true"])).exitCode).toBe(2);
    expect((await retry(["--unknown", "1", "3", "1", "true"])).exitCode).toBe(2);
    expect((await retry(["0", "1", "true"])).exitCode).toBe(2);
  });
});
