// Tests for scripts/ci/prefetch-electron-builder-zip.sh. Each test spawns the real script in a
// scratch repository root that holds a fake node_modules/electron, and downloads from a local
// HTTP server that answers like the GitHub release host (ELECTRON_MIRROR names the server).
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/prefetchElectronBuilderZip.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runScript, type RunResult } from "./runScript";

const SCRIPT = path.resolve(import.meta.dir, "prefetch-electron-builder-zip.sh");

const VERSION = "99.1.2";
const ASSET = `electron-v${VERSION}-${process.platform}-${process.arch}.zip`;
const BODY = "electron zip bytes\n";
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");

// Answers by the first path segment of the mirror: /ok, and /busy/<n> (504 for the first n
// requests of the test, then 200).
let server: ReturnType<typeof Bun.serve>;
let requests: string[];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname;
      requests.push(pathname);
      const served = requests.filter((p) => p === pathname).length;
      const [, kind, arg] = pathname.split("/");
      if (kind === "busy" && served <= Number(arg)) {
        return new Response("gateway timeout", { status: 504 });
      }
      return new Response(BODY);
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

let root: string;
let cache: string;

beforeEach(async () => {
  requests = [];
  root = await mkdtemp(path.join(tmpdir(), "prefetch-electron-builder-zip-"));
  cache = path.join(root, "cache");
  await writeElectronPackage({ [ASSET]: BODY_SHA256 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeElectronPackage(checksums: Record<string, string>): Promise<void> {
  const dir = path.join(root, "node_modules", "electron");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "electron", version: VERSION })
  );
  await writeFile(path.join(dir, "checksums.json"), JSON.stringify(checksums));
}

function prefetch(mirrorRoute: string, env: Record<string, string> = {}): Promise<RunResult> {
  return runScript([SCRIPT], {
    cwd: root,
    env: {
      ELECTRON_CACHE: cache,
      ELECTRON_MIRROR: `http://127.0.0.1:${server.port}${mirrorRoute}`,
      DOWNLOAD_BACKOFF_SECS: "0",
      DOWNLOAD_BUDGET_SECS: "30",
      ...env,
    },
  });
}

describe("prefetch-electron-builder-zip.sh", () => {
  test("puts the zip flat in the cache, where app-builder looks, and names the version's path", async () => {
    const result = await prefetch("/ok/");
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(cache, ASSET), "utf8")).toBe(BODY);
    expect(await readdir(cache)).toEqual([ASSET]);
    // The release layout the mirror variable stands for: <mirror>/v<version>/<file>.
    expect(requests).toEqual([`/ok/v${VERSION}/${ASSET}`]);
  });

  test("a zip that matches the pin costs no request", async () => {
    await prefetch("/ok");
    requests = [];
    const second = await prefetch("/ok");
    expect(second.exitCode).toBe(0);
    expect(requests).toEqual([]);
  });

  test("a cached zip that does not match the pin is downloaded again", async () => {
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, ASSET), "a truncated cache entry");
    const result = await prefetch("/ok");
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(cache, ASSET), "utf8")).toBe(BODY);
    expect(requests).toHaveLength(1);
  });

  test("an outage that ends within the budget still ends with the zip", async () => {
    const result = await prefetch("/busy/3");
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(cache, ASSET), "utf8")).toBe(BODY);
    expect(requests).toHaveLength(4);
  });

  test("bytes that do not match the pin never reach the cache", async () => {
    await writeElectronPackage({ [ASSET]: "0".repeat(64) });
    const result = await prefetch("/ok");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not match the pinned sha256");
    expect(await readdir(cache)).toEqual([]);
  });

  test("a package with no checksum for this platform fails and names the asset", async () => {
    await writeElectronPackage({});
    const result = await prefetch("/ok");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`checksums.json has no ${ASSET}`);
    expect(requests).toEqual([]);
  });

  test("without ELECTRON_CACHE it refuses to guess a directory", async () => {
    const result = await prefetch("/ok", { ELECTRON_CACHE: "" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ELECTRON_CACHE must name the directory");
    expect(requests).toEqual([]);
  });
});
