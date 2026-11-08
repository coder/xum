// Tests for scripts/ci/retry.sh and scripts/ci/download-verified.sh: each test spawns the real
// script. download-verified.sh runs against a fake `curl` first on PATH, which fails a set
// number of times (like a GitHub release 504) and then serves a fixed body.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/downloadScripts.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const RETRY = path.resolve(import.meta.dir, "retry.sh");
const DOWNLOAD = path.resolve(import.meta.dir, "download-verified.sh");

const BODY = "pinned release asset\n";
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");

// Writes FAKE_CURL_BODY to the `-o` file. The first FAKE_CURL_FAILS calls fail like `curl -f`
// on an HTTP 504 (exit 22).
const FAKE_CURL = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_CURL_LOG"
calls=$(wc -l < "$FAKE_CURL_LOG")
if [ "$calls" -le "$FAKE_CURL_FAILS" ]; then
  echo "curl: (22) The requested URL returned error: 504" >&2
  exit 22
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    cp "$FAKE_CURL_BODY" "$2"
    exit 0
  fi
  shift
done
exit 2
`;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "ci-download-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function run(cmd: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: work,
    env: { ...process.env, RETRY_INITIAL_DELAY_SECS: "0", ...env },
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

async function countLines(file: string): Promise<number> {
  const text = await readFile(path.join(work, file), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").length;
}

describe("retry.sh", () => {
  // Fails until it has run `succeedOn` times; one line per run goes to `runs`.
  async function flakyCommand(succeedOn: number): Promise<string> {
    const script = path.join(work, "flaky.sh");
    await writeFile(
      script,
      `#!/usr/bin/env bash\necho run >> "${work}/runs"\n[ "$(wc -l < "${work}/runs")" -ge ${succeedOn} ]\n`
    );
    await chmod(script, 0o755);
    return script;
  }

  test("runs the command again until it succeeds", async () => {
    const result = await run([RETRY, "30", await flakyCommand(3)]);
    expect(result.exitCode).toBe(0);
    expect(await countLines("runs")).toBe(3);
  });

  test("gives up with the command's last exit status once the budget is spent", async () => {
    const result = await run([RETRY, "2", "bash", "-c", `echo run >> runs; exit 7`], {
      RETRY_INITIAL_DELAY_SECS: "1",
      RETRY_MAX_DELAY_SECS: "1",
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("the 2s budget is spent");
    expect(await countLines("runs")).toBeGreaterThan(1);
  });

  test("passes its arguments to the command unchanged", async () => {
    const result = await run([RETRY, "5", "printf", "%s|", "a b", "c"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a b|c|");
  });

  test("refuses a missing or non-numeric budget", async () => {
    expect((await run([RETRY])).exitCode).toBe(2);
    expect((await run([RETRY, "soon", "true"])).exitCode).toBe(2);
  });
});

describe("download-verified.sh", () => {
  let dest: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    const bin = path.join(work, "bin");
    dest = path.join(work, "assets", "tool");
    await Bun.write(path.join(bin, "curl"), FAKE_CURL);
    await chmod(path.join(bin, "curl"), 0o755);
    await Bun.write(path.join(work, "body"), BODY);
    env = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_CURL_BODY: path.join(work, "body"),
      FAKE_CURL_LOG: path.join(work, "curl-calls"),
      FAKE_CURL_FAILS: "0",
    };
  });

  function download(sha256 = BODY_SHA256): Promise<RunResult> {
    return run([DOWNLOAD, "https://example.test/tool", sha256, dest], env);
  }

  test("downloads a missing file and keeps it only after the checksum passes", async () => {
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(await readFile(dest, "utf8")).toBe(BODY);
    expect(await countLines("curl-calls")).toBe(1);
    expect(await readdir(path.dirname(dest))).toEqual(["tool"]);
  });

  test("skips the network when the file already matches the pinned checksum", async () => {
    await Bun.write(dest, BODY);
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no download");
    expect(await countLines("curl-calls")).toBe(0);
  });

  test("downloads again when a cached file fails the checksum", async () => {
    await Bun.write(dest, "stale cache entry");
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(await readFile(dest, "utf8")).toBe(BODY);
    expect(await countLines("curl-calls")).toBe(1);
  });

  test("keeps a 504 from failing the download while the budget lasts", async () => {
    env.FAKE_CURL_FAILS = "2";
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(await readFile(dest, "utf8")).toBe(BODY);
    expect(await countLines("curl-calls")).toBe(3);
  });

  test("refuses a download that does not match and leaves nothing behind", async () => {
    const result = await download("0".repeat(64));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match the pinned sha256");
    expect(await readdir(path.dirname(dest))).toEqual([]);
  });
});
