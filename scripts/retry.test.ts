// Tests for scripts/retry.sh: each test spawns the real script. A stub `sleep` first on PATH
// records each wait and returns at once, so the wait sequence is asserted without waiting.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally: bun test ./scripts/retry.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runScript, writeExecutable, type RunResult } from "./ci/runScript";

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

describe("usage", () => {
  test("refuses missing arguments, non-numeric values and an unlimited retry without a budget", async () => {
    expect((await retry([])).exitCode).toBe(2);
    expect((await retry(["3", "soon", "true"])).exitCode).toBe(2);
    expect((await retry(["--budget-secs", "many", "3", "1", "true"])).exitCode).toBe(2);
    expect((await retry(["--unknown", "1", "3", "1", "true"])).exitCode).toBe(2);
    expect((await retry(["0", "1", "true"])).exitCode).toBe(2);
  });
});
