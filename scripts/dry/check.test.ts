// End-to-end tests of `scripts/dry/check.ts` in throwaway git repos. They
// need uv (the scorer runs through `uv run`), which the Test / Unit runners do
// not install, so `make test-dry-scripts` (static-check-full) runs this file
// and scripts/test-unit-ci.sh skips it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CHECK = join(import.meta.dir, "check.ts");
// Hermetic git: CI has no identity, and host config (hooks, signing) must not leak in.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let repo: string;

function git(...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: GIT_ENV,
  });
  expect(result.status).toBe(0);
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function check() {
  const result = spawnSync(process.execPath, [CHECK, "--base", "HEAD", "--json"], {
    cwd: repo,
    env: GIT_ENV,
    encoding: "utf8",
  });
  return { status: result.status, report: result.status === 2 ? null : JSON.parse(result.stdout) };
}

const bucket = (name: string) => `export function ${name}(n: number): string {
  if (n === 0) return "0";
  if (n < 100) return "1-99";
  if (n < 1000) return "100-999";
  return "1000+";
}
`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "dry-check-test-"));
  git("init", "-q", "-b", "main");
  write("src/a.ts", bucket("cents") + "\n" + bucket("count"));
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("a new copy of existing code is a finding", () => {
  write("src/b.ts", bucket("fee"));
  git("add", "-N", "src/b.ts");

  const { status, report } = check();

  expect(status).toBe(1);
  const pairs = (report.pairs as Array<{ left: { name: string }; right: { name: string } }>).map(
    (pair) => `${pair.left.name}~${pair.right.name}`
  );
  expect(pairs.sort()).toEqual(["fee~cents", "fee~count"]);
});

test("an edit inside one side of an old pair is not a finding", () => {
  const path = join(repo, "src/a.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace('"1-99"', '"1 to 99"'));

  const { status, report } = check();

  expect(status).toBe(0);
  expect(report.changedFunctions).toBe(1);
});

test("a test file copy is not a finding", () => {
  write("src/a.test.ts", bucket("fixture"));
  git("add", "-N", "src/a.test.ts");

  expect(check().status).toBe(0);
});
