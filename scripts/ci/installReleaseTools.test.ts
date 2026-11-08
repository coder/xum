// Tests for scripts/ci/install-release-tools.sh. The pinned checksums are real, so no test can
// make the script accept a fake asset. What the tests pin is the refusals: an unsupported CPU,
// bytes that do not match the pin, a wrong command line, and the asset names chosen for the
// CPU. A stub `uname` and `curl` first on PATH stand in for the host and the network.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/installReleaseTools.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runScript, writeExecutable, type RunResult } from "./runScript";

const INSTALL = path.resolve(import.meta.dir, "install-release-tools.sh");

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "install-release-tools-"));
  // curl answers 200 with bytes that match no pin; fetch-once.sh then gets what a real
  // download of a tampered asset would give.
  await writeExecutable(
    path.join(work, "curl"),
    `
echo "$*" >> "${work}/curl-calls"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then echo "not the pinned asset" > "$2"; fi
  shift
done
printf 200`
  );
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function install(args: string[], cpu: string): Promise<RunResult> {
  await writeExecutable(path.join(work, "uname"), `echo ${cpu}`);
  return runScript([INSTALL, ...args], {
    cwd: work,
    env: {
      PATH: `${work}:${process.env.PATH ?? ""}`,
      RELEASE_ASSETS_DIR: path.join(work, "assets"),
      DOWNLOAD_BACKOFF_SECS: "0",
      DOWNLOAD_BUDGET_SECS: "5",
    },
  });
}

async function curlUrls(): Promise<string[]> {
  const calls = await readFile(path.join(work, "curl-calls"), "utf8").catch(() => "");
  return calls
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" ").at(-1) ?? "");
}

const TOOL_SETS = ["shfmt-hadolint", "static-curl"];

describe("install-release-tools.sh", () => {
  test.each(TOOL_SETS)(
    "%s: refuses bytes that do not match the pin and installs nothing",
    async (set) => {
      const bin = path.join(work, "bin");
      const result = await install([set, bin], "x86_64");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("does not match the pinned sha256");
      expect(await readdir(bin).catch(() => [])).toEqual([]);
      expect(await readdir(path.join(work, "assets")).catch(() => [])).toEqual([]);
    }
  );

  test.each(TOOL_SETS)("%s: refuses a CPU it has no pin for, before any download", async (set) => {
    const result = await install([set, path.join(work, "bin")], "riscv64");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("riscv64");
    expect(await curlUrls()).toEqual([]);
  });

  test("picks the asset of the CPU it runs on", async () => {
    await install(["static-curl", path.join(work, "bin")], "aarch64");
    expect(await curlUrls()).toEqual([
      expect.stringMatching(/\/curl-linux-aarch64-musl-[\d.]+\.tar\.xz$/),
    ]);
    await rm(path.join(work, "curl-calls"));
    await install(["static-curl", path.join(work, "bin")], "x86_64");
    expect(await curlUrls()).toEqual([
      expect.stringMatching(/\/curl-linux-x86_64-musl-[\d.]+\.tar\.xz$/),
    ]);
  });

  test("refuses an unknown tool set and a wrong command line", async () => {
    expect((await install(["nope", path.join(work, "bin")], "x86_64")).exitCode).toBe(2);
    expect((await install(["static-curl"], "x86_64")).exitCode).toBe(2);
    expect((await install([], "x86_64")).exitCode).toBe(2);
  });
});
