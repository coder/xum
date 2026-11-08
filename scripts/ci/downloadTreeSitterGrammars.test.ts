// Tests for scripts/ci/download_tree_sitter_grammars.py. A stub tree_sitter_language_pack on
// PYTHONPATH fails the way the real pack does when its GitHub release answers an HTTP error
// ("Download error: Failed to fetch manifest from <url>: http status: 504").
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/downloadTreeSitterGrammars.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runScript, type RunResult } from "./runScript";

const SCRIPT = path.resolve(import.meta.dir, "download_tree_sitter_grammars.py");

const STUB = `import os


class DownloadError(Exception):
    pass


def download(names):
    with open(os.environ["STUB_CALLS"], "a") as calls:
        calls.write(",".join(names) + "\\n")
    if os.environ.get("STUB_ERROR"):
        raise DownloadError(os.environ["STUB_ERROR"])
`;

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "grammars-"));
  await writeFile(path.join(work, "tree_sitter_language_pack.py"), STUB);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function download(error?: string): Promise<RunResult> {
  return runScript(["python3", SCRIPT], {
    cwd: work,
    env: {
      PYTHONPATH: work,
      PYTHONDONTWRITEBYTECODE: "1",
      STUB_CALLS: path.join(work, "calls"),
      STUB_ERROR: error ?? "",
    },
  });
}

function releaseError(status: number): string {
  return `Download error: Failed to fetch manifest from https://github.com/x/y/releases/download/v1/parsers.json: http status: ${status}`;
}

describe.skipIf(Bun.which("python3") === null)("download_tree_sitter_grammars.py", () => {
  test("downloads the grammars and exits 0", async () => {
    const result = await download();
    expect(result.exitCode).toBe(0);
    const calls = (await readFile(path.join(work, "calls"), "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
  });

  test("exits 64 on an HTTP 4xx that no retry changes, so retry.sh stops at once", async () => {
    for (const status of [400, 403, 404, 410]) {
      const result = await download(releaseError(status));
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain(`http status: ${status}`);
    }
  });

  test("exits 1 on a failure a retry can fix", async () => {
    for (const status of [408, 429, 500, 503, 504]) {
      expect((await download(releaseError(status))).exitCode).toBe(1);
    }
    expect((await download("Download error: connection reset by peer")).exitCode).toBe(1);
  });
});
