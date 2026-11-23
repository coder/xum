// Tests for scripts/macos-signing/mergeUpdateInfo.ts.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/macos-signing/mergeUpdateInfo.test.ts
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SPAWNING_TEST_TIMEOUT_MS, runScript, type RunResult } from "../ci/runScript";

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

const MERGE = path.resolve(import.meta.dir, "mergeUpdateInfo.ts");

// latest-mac.yml of v0.32.2, which one electron-builder run for both architectures wrote (without
// the line that `make dist-mac` appends).
const RELEASED = `version: 0.32.2
files:
  - url: xum-0.32.2-x64-mac.zip
    sha512: b0XXJpPkMudqwzEV04qHDLplcg4yfMfk6f0K0poYBvsGJ7on2+K7GlfaL1qGqK8hWy0+GsQ8D1WJ2mj32QIjmA==
    size: 349098860
  - url: xum-0.32.2-arm64-mac.zip
    sha512: kareb4eZTHJSzYcFzvz7A+n8y2Mr6gS8Oyw9nPUWeUuc1DEn07vBctonNcltRAvmBlDlg+V3erYM1VyeR11Q3A==
    size: 343784247
  - url: xum-0.32.2-x64-mac.dmg
    sha512: zfBA0CypaF9+kF7wfUSGHI3wyIPG5TTnqYsUk3Y5WUpWmmwaZCZ8qIlXmMS+PGMYuUUiojUpyDDYyC68TIWnPg==
    size: 361862317
  - url: xum-0.32.2-arm64-mac.dmg
    sha512: L+diiAS4KbJdDN2uTgjvdkcClSYtIbCQ322riyR+1myA0wd5Vz6H5umfynmxmI0TmTXfvDvyq27YOVWKkrWQnQ==
    size: 356508351
path: xum-0.32.2-x64-mac.zip
sha512: b0XXJpPkMudqwzEV04qHDLplcg4yfMfk6f0K0poYBvsGJ7on2+K7GlfaL1qGqK8hWy0+GsQ8D1WJ2mj32QIjmA==
releaseDate: '2026-11-10T20:18:11.175Z'
`;

// The file that a run for one architecture writes: its own zip and dmg, in that order.
function oneArch(arch: "x64" | "arm64", releaseDate: string, version = "0.32.2"): string {
  const entry = (ext: string) => {
    const url = `xum-0.32.2-${arch}-mac.${ext}`;
    const lines = RELEASED.split("\n");
    const at = lines.indexOf(`  - url: ${url}`);
    return lines.slice(at, at + 3);
  };
  const zip = entry("zip");
  return [
    `version: ${version}`,
    "files:",
    ...zip,
    ...entry("dmg"),
    `path: xum-0.32.2-${arch}-mac.zip`,
    zip[1].trimStart(),
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "merge-update-info-"));
  for (const dir of ["x64", "arm64", "out"]) await mkdir(path.join(work, dir));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function merge(): Promise<RunResult> {
  return runScript(["bun", MERGE, "x64", "arm64", "out"], { cwd: work });
}

test("gives the bytes of a release that one run built for both architectures", async () => {
  await writeFile(path.join(work, "x64/latest-mac.yml"), oneArch("x64", "2026-11-10T20:18:11.175Z"));
  await writeFile(
    path.join(work, "arm64/latest-mac.yml"),
    oneArch("arm64", "2026-11-10T20:19:40.000Z")
  );
  // Not an update file: electron-builder also writes this one.
  await writeFile(path.join(work, "x64/builder-debug.yml"), "x64: {}\n");

  const result = await merge();

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(await readdir(path.join(work, "out"))).toEqual(["latest-mac.yml"]);
  expect(await readFile(path.join(work, "out/latest-mac.yml"), "utf8")).toBe(RELEASED);
});

test("refuses apps of two versions", async () => {
  await writeFile(path.join(work, "x64/latest-mac.yml"), oneArch("x64", "2026-11-10T20:18:11.175Z"));
  await writeFile(
    path.join(work, "arm64/latest-mac.yml"),
    oneArch("arm64", "2026-11-10T20:18:11.175Z", "0.32.3")
  );

  const result = await merge();

  expect(result.exitCode).not.toBe(0);
  expect(await readdir(path.join(work, "out"))).toEqual([]);
});

test("refuses runs that wrote update files of different channels", async () => {
  await writeFile(path.join(work, "x64/latest-mac.yml"), oneArch("x64", "2026-11-10T20:18:11.175Z"));
  await writeFile(
    path.join(work, "arm64/nightly-mac.yml"),
    oneArch("arm64", "2026-11-10T20:18:11.175Z")
  );

  const result = await merge();

  expect(result.exitCode).not.toBe(0);
  expect(await readdir(path.join(work, "out"))).toEqual([]);
});

test("refuses a run that wrote no update file", async () => {
  expect((await merge()).exitCode).not.toBe(0);
});
