// Tests for scripts/ci/prefetch-appimage-tool.sh. The pinned checksum is real, so no test can make
// the script accept a fake archive. What the tests pin is what happens around it: a cache that
// already holds the tool costs no request, bytes that do not match the pin never reach the cache,
// a failed request is tried again, and unpacking leaves the tool whole or not at all. A stub
// `curl` first on PATH stands in for the network. `--unpack` runs on a real 7z that the test makes
// with the 7za that electron-builder uses.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/prefetchAppimageTool.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { path7za } from "7zip-bin";
import { runScript, writeExecutable, type RunResult } from "./runScript";

const SCRIPT = path.resolve(import.meta.dir, "prefetch-appimage-tool.sh");
const VERSION = "appimage-12.0.1";

let work: string;
let cache: string;
let assets: string;

beforeAll(async () => {
  // The install may leave the binary without its executable bit, and makeArchive runs it directly.
  await chmod(path7za, 0o755);
});

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "prefetch-appimage-tool-"));
  cache = path.join(work, "electron-builder");
  assets = path.join(work, "assets");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// A curl that answers each request with the next status of `statuses` (the last one repeats) and,
// for a 2xx, bytes that match no pin. It records every URL in `curl-calls`.
async function stubCurl(statuses: number[]): Promise<void> {
  await writeExecutable(
    path.join(work, "curl"),
    `echo "$*" >> "${work}/curl-calls"
n=$(wc -l < "${work}/curl-calls")
statuses=(${statuses.join(" ")})
status=\${statuses[$((n - 1))]:-\${statuses[-1]}}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then echo "not the pinned archive" > "$2"; fi
  shift
done
printf '%s' "$status"`
  );
}

async function curlUrls(): Promise<string[]> {
  const calls = await readFile(path.join(work, "curl-calls"), "utf8").catch(() => "");
  return calls
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" ").at(-1) ?? "");
}

function prefetch(args: string[] = []): Promise<RunResult> {
  return runScript([SCRIPT, ...args], {
    cwd: work,
    env: {
      PATH: `${work}:${process.env.PATH ?? ""}`,
      ELECTRON_BUILDER_CACHE: cache,
      RELEASE_ASSETS_DIR: assets,
      DOWNLOAD_BACKOFF_SECS: "0",
      DOWNLOAD_BUDGET_SECS: "5",
    },
  });
}

async function writeTool(dest: string): Promise<void> {
  await mkdir(path.join(dest, "linux-x64"), { recursive: true });
  await writeFile(path.join(dest, "linux-x64", "mksquashfs"), "tool");
  await writeFile(path.join(dest, "runtime-x64"), "runtime");
}

describe("a cache that holds the tool", () => {
  test("costs no request", async () => {
    await stubCurl([200]);
    await writeTool(path.join(cache, "appimage", VERSION));

    const result = await prefetch();

    expect(result.exitCode).toBe(0);
    expect(await curlUrls()).toEqual([]);
  });

  test("is not trusted when a part that app-builder runs is missing", async () => {
    await stubCurl([200]);
    const dest = path.join(cache, "appimage", VERSION);
    await writeTool(dest);
    await rm(path.join(dest, "runtime-x64"));

    const result = await prefetch();

    // The stub's bytes match no pin, so the run ends at the checksum, after it asked for the archive.
    expect(result.exitCode).not.toBe(0);
    expect(await curlUrls()).toHaveLength(1);
  });
});

describe("a cold cache", () => {
  test("asks for the pinned release asset", async () => {
    await stubCurl([200]);

    await prefetch();

    expect(await curlUrls()).toEqual([
      `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`,
    ]);
  });

  test("refuses bytes that do not match the pin and leaves nothing behind", async () => {
    await stubCurl([200]);

    const result = await prefetch();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not match the pinned sha256");
    expect(await readdir(path.join(cache, "appimage")).catch(() => [])).toEqual([]);
    expect(await readdir(assets).catch(() => [])).toEqual([]);
  });

  test("tries a failed request again", async () => {
    await stubCurl([504, 200]);

    const result = await prefetch();

    expect(await curlUrls()).toHaveLength(2);
    // The second answer is a 200 with unpinned bytes, so the run ends at the checksum, not at the 504.
    expect(result.stderr).toContain("does not match the pinned sha256");
  });

  test("gives up at once on a 404", async () => {
    await stubCurl([404]);

    const result = await prefetch();

    expect(result.exitCode).not.toBe(0);
    expect(await curlUrls()).toHaveLength(1);
  });
});

describe("--unpack", () => {
  async function makeArchive(): Promise<string> {
    const source = path.join(work, "source");
    await writeTool(source);
    const archive = path.join(work, "tool.7z");
    const made = await runScript([path7za, "a", "-bd", archive, "."], { cwd: source });
    expect(made.exitCode).toBe(0);
    return archive;
  }

  test("puts the archive's files at the destination and leaves no temporary folder", async () => {
    const dest = path.join(cache, "appimage", VERSION);

    const result = await prefetch(["--unpack", await makeArchive(), dest]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(dest, "runtime-x64"), "utf8")).toBe("runtime");
    expect(await readFile(path.join(dest, "linux-x64", "mksquashfs"), "utf8")).toBe("tool");
    expect(await readdir(path.dirname(dest))).toEqual([VERSION]);
  });

  test("replaces a destination that holds only part of the tool", async () => {
    const dest = path.join(cache, "appimage", VERSION);
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "stale"), "left by a killed job");

    const result = await prefetch(["--unpack", await makeArchive(), dest]);

    expect(result.exitCode).toBe(0);
    expect(await readdir(dest)).toContain("runtime-x64");
    expect(await readdir(dest)).not.toContain("stale");
  });

  test("keeps the destination and leaves no temporary folder when the archive is corrupt", async () => {
    const dest = path.join(cache, "appimage", VERSION);
    await writeTool(dest);
    const corrupt = path.join(work, "corrupt.7z");
    await writeFile(corrupt, "this is not a 7z archive");

    const result = await prefetch(["--unpack", corrupt, dest]);

    expect(result.exitCode).not.toBe(0);
    expect(await readFile(path.join(dest, "runtime-x64"), "utf8")).toBe("runtime");
    expect(await readdir(path.dirname(dest))).toEqual([VERSION]);
  });

  test("runs a 7za that the install left without the executable bit", async () => {
    const sevenzip = path.join(work, "7za-copy");
    await copyFile(path7za, sevenzip);
    await chmod(sevenzip, 0o644);
    const dest = path.join(cache, "appimage", VERSION);

    const result = await runScript([SCRIPT, "--unpack", await makeArchive(), dest], {
      cwd: work,
      env: { SEVENZIP: sevenzip },
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(dest, "runtime-x64"), "utf8")).toBe("runtime");
  });

  test("refuses a wrong command line", async () => {
    expect((await prefetch(["--unpack", "only-one-argument"])).exitCode).toBe(2);
    expect((await prefetch(["--something-else"])).exitCode).toBe(2);
  });
});
