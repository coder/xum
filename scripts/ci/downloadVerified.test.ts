// Tests for scripts/ci/download-verified.sh and scripts/ci/fetch-once.sh. Each test spawns the
// real script, which runs the real curl against a local HTTP server that answers like the
// GitHub release host: 200, a run of 504s, 429, 404.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/downloadVerified.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runScript, type RunResult } from "./runScript";

const DOWNLOAD = path.resolve(import.meta.dir, "download-verified.sh");
const FETCH_ONCE = path.resolve(import.meta.dir, "fetch-once.sh");

const BODY = "pinned release asset\n";
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");

// Answers each request by the first path segment: /ok, /missing (404), /busy/<n> (504 for
// the first n requests of the test, then 200), /limited (429 once, then 200) and /down (504).
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
      if (kind === "missing") return new Response("not found", { status: 404 });
      if (kind === "down") return new Response("gateway timeout", { status: 504 });
      if (kind === "busy" && served <= Number(arg)) {
        return new Response("gateway timeout", { status: 504 });
      }
      if (kind === "limited" && served === 1) return new Response("slow down", { status: 429 });
      return new Response(BODY);
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

let work: string;
let dest: string;

beforeEach(async () => {
  requests = [];
  work = await mkdtemp(path.join(tmpdir(), "download-verified-"));
  dest = path.join(work, "assets", "tool");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function url(route: string): string {
  return `http://127.0.0.1:${server.port}${route}`;
}

function download(
  route: string,
  sha256 = BODY_SHA256,
  env: Record<string, string> = {}
): Promise<RunResult> {
  return runScript([DOWNLOAD, url(route), sha256, dest], {
    cwd: work,
    env: { DOWNLOAD_BACKOFF_SECS: "0", DOWNLOAD_BUDGET_SECS: "30", ...env },
  });
}

async function destDirEntries(): Promise<string[]> {
  return readdir(path.dirname(dest)).catch(() => []);
}

describe("download-verified.sh", () => {
  test("downloads a missing file and keeps it only after the checksum passes", async () => {
    const result = await download("/ok");
    expect(result.exitCode).toBe(0);
    expect(await readFile(dest, "utf8")).toBe(BODY);
    expect(await destDirEntries()).toEqual(["tool"]);
  });

  test("skips the network when the file already matches the pinned checksum", async () => {
    await Bun.write(dest, BODY);
    const result = await download("/ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no download");
    expect(requests).toEqual([]);
  });

  test("downloads again when a cached file fails the checksum", async () => {
    await Bun.write(dest, "stale cache entry");
    const result = await download("/ok");
    expect(result.exitCode).toBe(0);
    expect(await readFile(dest, "utf8")).toBe(BODY);
    expect(requests).toEqual(["/ok"]);
  });

  test("keeps retrying 504s while the budget lasts", async () => {
    const result = await download("/busy/2");
    expect(result.exitCode).toBe(0);
    expect(await readFile(dest, "utf8")).toBe(BODY);
    expect(requests).toEqual(["/busy/2", "/busy/2", "/busy/2"]);
  });

  test("retries a 429", async () => {
    const result = await download("/limited");
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual(["/limited", "/limited"]);
  });

  test("gives up on a 504 that outlasts the budget", async () => {
    const result = await download("/down", BODY_SHA256, {
      DOWNLOAD_BACKOFF_SECS: "1",
      DOWNLOAD_BUDGET_SECS: "2",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("2s budget is spent");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(await destDirEntries()).toEqual([]);
  });

  test("fails at once on a 404, which no retry changes", async () => {
    const result = await download("/missing");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("HTTP 404");
    expect(requests).toEqual(["/missing"]);
    expect(await destDirEntries()).toEqual([]);
  });

  test("refuses a download that does not match and leaves nothing behind", async () => {
    const result = await download("/ok", "0".repeat(64));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match the pinned sha256");
    expect(await destDirEntries()).toEqual([]);
  });

  test("refuses a checksum that is not a lowercase sha256 digest before any request", async () => {
    for (const bad of ["", "abc", BODY_SHA256.toUpperCase(), `${BODY_SHA256}0`]) {
      const result = await download("/ok", bad);
      expect(result.exitCode).toBe(2);
    }
    expect(requests).toEqual([]);
  });

  test("refuses the wrong number of arguments", async () => {
    const result = await runScript([DOWNLOAD, url("/ok")], { cwd: work });
    expect(result.exitCode).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe("fetch-once.sh", () => {
  async function fetchOnce(target: string): Promise<number> {
    const result = await runScript([FETCH_ONCE, target, path.join(work, "out")], { cwd: work });
    return result.exitCode;
  }

  test("exits 0 on success, 1 on a failure a retry can fix, 64 on one it cannot", async () => {
    expect(await fetchOnce(url("/ok"))).toBe(0);
    expect(await fetchOnce(url("/down"))).toBe(1);
    expect(await fetchOnce(url("/missing"))).toBe(64);
    // Nothing listens on port 1: a network error is worth another try.
    expect(await fetchOnce("http://127.0.0.1:1/ok")).toBe(1);
  });
});
