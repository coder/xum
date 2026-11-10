// Tests for the prebuilt-binary fallback of scripts/zizmor.sh, which runs when Docker cannot
// start the zizmor image (exit 125). The script runs from a copy of itself and its download
// helpers in a temp tree, so it caches nothing in the checkout. A stub `docker` fails the run
// with 125, and a stub `curl` answers the release URL: an HTTP status, then bytes that miss the
// pinned digest.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally: bun test ./scripts/zizmorFallback.test.ts
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SPAWNING_TEST_TIMEOUT_MS,
  runScript,
  writeExecutable,
  type RunResult,
} from "./ci/runScript";

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

const SCRIPTS = import.meta.dir;
const COPIED = ["zizmor.sh", "retry.sh", "ci/download-verified.sh", "ci/fetch-once.sh"];

let tree: string;
let stubs: string;

beforeEach(async () => {
  tree = await mkdtemp(path.join(tmpdir(), "zizmor-fallback-"));
  stubs = path.join(tree, "stubs");
  await mkdir(path.join(tree, "scripts", "ci"), { recursive: true });
  await mkdir(stubs);
  for (const file of COPIED) {
    const target = path.join(tree, "scripts", file);
    await copyFile(path.join(SCRIPTS, file), target);
    await chmod(target, 0o755);
  }
  await writeExecutable(path.join(stubs, "docker"), `[ "$1" = "run" ] && exit 125\nexit 0`);
});

afterEach(async () => {
  await rm(tree, { recursive: true, force: true });
});

// The stub curl answers the first `failures` calls with HTTP `status`, then 200 with bytes that
// match no pin (a replaced release asset).
async function runFallback(options: { status: number; failures: number }): Promise<RunResult> {
  await writeExecutable(
    path.join(stubs, "curl"),
    `echo "$*" >> "${tree}/curl-calls"
calls=$(wc -l < "${tree}/curl-calls")
status=200
if [ "$calls" -le ${options.failures} ]; then status=${options.status}; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then echo "not the pinned zizmor" > "$2"; fi
  shift
done
printf '%s' "$status"`
  );
  return runScript([path.join(tree, "scripts", "zizmor.sh"), "--version"], {
    cwd: tree,
    env: {
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      // A value, so the script does not ask `gh` for a token. The stub docker ignores it.
      GH_TOKEN: "not-a-token",
      HOME: tree,
      RELEASE_ASSETS_DIR: path.join(tree, "assets"),
      DOWNLOAD_BACKOFF_SECS: "0",
      DOWNLOAD_BUDGET_SECS: "20",
    },
  });
}

async function curlCalls(): Promise<string[]> {
  const calls = await readFile(path.join(tree, "curl-calls"), "utf8").catch(() => "");
  return calls.split("\n").filter((line) => line !== "");
}

async function runnableBinaries(): Promise<number> {
  const found = await runScript(
    ["find", path.join(tree, "node_modules"), "-name", "zizmor", "-type", "f"],
    {
      cwd: tree,
    }
  );
  return found.stdout.split("\n").filter((line) => line !== "").length;
}

describe("zizmor.sh fallback download", () => {
  test("downloads the release archive and refuses bytes that miss the pinned digest", async () => {
    const result = await runFallback({ status: 200, failures: 0 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not match the pinned sha256");
    const calls = await curlCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /zizmorcore\/zizmor\/releases\/download\/v[\d.]+\/zizmor-.*\.tar\.gz$/
    );
    expect(await runnableBinaries()).toBe(0);
  });

  test("retries a 504 from the release", async () => {
    const result = await runFallback({ status: 504, failures: 2 });
    expect(result.exitCode).not.toBe(0);
    expect(await curlCalls()).toHaveLength(3);
    expect(await runnableBinaries()).toBe(0);
  });

  test("gives up at once on a 404", async () => {
    const result = await runFallback({ status: 404, failures: 5 });
    expect(result.exitCode).not.toBe(0);
    expect(await curlCalls()).toHaveLength(1);
  });
});
