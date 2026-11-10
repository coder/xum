// Tests for scripts/ci/prefetch-electron-zip.cjs. @electron/get is replaced by a stub that
// prints the options of its downloadArtifact call, so no test touches the network. The real
// node_modules/electron/install.js (the consumer of the cache) runs against the same stub, and
// the prefetch must call it with the same options: a zip saved under other options (another
// cache root, platform or version) is a cache miss for install.js.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/prefetchElectronZip.test.ts
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SPAWNING_TEST_TIMEOUT_MS } from "./runScript";

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

const PREFETCH = path.resolve(import.meta.dir, "prefetch-electron-zip.cjs");
const ELECTRON = path.resolve(import.meta.dir, "../../node_modules/electron");

// The stub library: HOOK_MODE=reject fails the download with a real HTTPError of status
// HOOK_STATUS (HOOK_MODE=network: a plain error with no status). Otherwise it returns a zip
// path for the platform and arch asked for, all in one directory (HOOK_ZIPS=split: one per
// arch, HOOK_ZIPS=windows: Windows paths).
const HOOK = `
const Module = require("node:module");
const load = Module._load;
let loadingReal = false;
Module._load = function (request, ...rest) {
  if (request !== "@electron/get" || loadingReal) return load.call(this, request, ...rest);
  return {
    downloadArtifact(options) {
      process.stdout.write("OPTIONS " + JSON.stringify(options) + "\\n");
      if (process.env.HOOK_MODE === "network") return Promise.reject(new Error("socket hang up"));
      if (process.env.HOOK_MODE !== "reject") {
        const file = "electron-" + options.platform + "-" + options.arch + ".zip";
        if (process.env.HOOK_ZIPS === "windows") return Promise.resolve("C:\\\\cache\\\\abc\\\\" + file);
        if (process.env.HOOK_ZIPS === "split") return Promise.resolve("/cache/" + options.arch + "/" + file);
        return Promise.resolve("/cache/abc/" + file);
      }
      loadingReal = true;
      const { HTTPError } = Module.createRequire(process.env.ELECTRON_DIR + "/")("@electron/get");
      loadingReal = false;
      const status = Number(process.env.HOOK_STATUS);
      return Promise.reject(new HTTPError(new Response(null, { status, statusText: "stub" })));
    },
  };
};
`;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let project: string;
let hook: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "prefetch-electron-"));
  // A copy of the package files install.js reads, with no dist: install.js exits early when
  // a matching Electron is already installed.
  const packageDir = path.join(project, "node_modules", "electron");
  await mkdir(packageDir, { recursive: true });
  for (const file of ["install.js", "package.json", "checksums.json"]) {
    await copyFile(path.join(ELECTRON, file), path.join(packageDir, file));
  }
  hook = path.join(project, "hook.cjs");
  await writeFile(hook, HOOK);
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

async function node(
  script: string,
  env: Record<string, string> = {},
  args: string[] = []
): Promise<RunResult> {
  const proc = Bun.spawn(["node", "-r", hook, script, ...args], {
    cwd: project,
    env: {
      ...process.env,
      electron_config_cache: path.join(project, "zip-cache"),
      ELECTRON_DIR: ELECTRON,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function allDownloadOptions(result: RunResult): Record<string, unknown>[] {
  return result.stdout
    .split("\n")
    .filter((l) => l.startsWith("OPTIONS "))
    .map((line) => JSON.parse(line.slice("OPTIONS ".length)) as Record<string, unknown>);
}

function downloadOptions(result: RunResult): Record<string, unknown> {
  const [first] = allDownloadOptions(result);
  if (first === undefined) {
    throw new Error(`no downloadArtifact call in: ${result.stdout}${result.stderr}`);
  }
  return first;
}

function cacheKey(options: Record<string, unknown>): Record<string, unknown> {
  const { version, artifactName, cacheRoot, checksums, platform, arch } = options;
  return { version, artifactName, cacheRoot, checksums, platform, arch };
}

test("asks @electron/get for the zip with the options install.js uses", async () => {
  const installer = await node(path.join(project, "node_modules/electron/install.js"));
  const prefetch = await node(PREFETCH);
  expect(cacheKey(downloadOptions(installer)).cacheRoot).toBe(path.join(project, "zip-cache"));
  expect(cacheKey(downloadOptions(prefetch))).toEqual(cacheKey(downloadOptions(installer)));
});

test("reports the zip it fetched, and the directory that holds it", async () => {
  const result = await node(PREFETCH);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    `Electron zip ready: /cache/abc/electron-${process.platform}-${process.arch}.zip`
  );
  expect(result.stdout).toContain("Electron zip dir: /cache/abc\n");
});

test("fetches one zip per target named, for that platform and arch, with the same options otherwise", async () => {
  const result = await node(PREFETCH, {}, ["darwin-x64", "darwin-arm64"]);
  expect(result.exitCode).toBe(0);
  const calls = allDownloadOptions(result);
  expect(calls.map((c) => [c.platform, c.arch])).toEqual([
    ["darwin", "x64"],
    ["darwin", "arm64"],
  ]);
  // Only the platform and arch differ between the calls.
  const [x64, arm64] = calls.map((call) => ({ ...call, platform: undefined, arch: undefined }));
  expect(arm64).toEqual(x64);
  expect(result.stdout).toContain("Electron zip ready: /cache/abc/electron-darwin-x64.zip");
  expect(result.stdout).toContain("Electron zip ready: /cache/abc/electron-darwin-arm64.zip");
  expect(result.stdout.match(/^Electron zip dir: .*$/gm)).toEqual(["Electron zip dir: /cache/abc"]);
});

test("prints a Windows zip's directory with forward slashes", async () => {
  const result = await node(PREFETCH, { HOOK_ZIPS: "windows" }, ["win32-x64"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Electron zip dir: C:/cache/abc\n");
});

test("exits 64 when the targets' zips are not in one directory", async () => {
  const result = await node(PREFETCH, { HOOK_ZIPS: "split" }, ["linux-x64", "linux-arm64"]);
  expect(result.exitCode).toBe(64);
  expect(result.stderr).toContain("different directories");
  expect(result.stdout).not.toContain("Electron zip dir:");
});

test("exits 64 on a target that is not <platform>-<arch>, before any download", async () => {
  for (const bad of ["darwin", "darwin-armv7", "freebsd-x64", "darwin-x64;ls"]) {
    const result = await node(PREFETCH, {}, ["linux-x64", bad]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain(bad);
    expect(allDownloadOptions(result)).toEqual([]);
  }
});

test("exits 1 with the download's error on a failure a retry can fix", async () => {
  for (const status of ["408", "429", "503", "504"]) {
    const result = await node(PREFETCH, { HOOK_MODE: "reject", HOOK_STATUS: status });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Response code ${status}`);
  }
  const network = await node(PREFETCH, { HOOK_MODE: "network" });
  expect(network.exitCode).toBe(1);
});

test("exits 64 on a 4xx that no retry changes, so retry.sh stops at once", async () => {
  for (const status of ["400", "403", "404"]) {
    const result = await node(PREFETCH, { HOOK_MODE: "reject", HOOK_STATUS: status });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain(`Response code ${status}`);
  }
});
