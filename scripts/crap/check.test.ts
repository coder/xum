// End-to-end tests of `scripts/crap/check.ts` in throwaway git repos. They
// need uv (the scorer runs through `uv run`), which the Test / Unit runners do
// not install, so `make test-crap-scripts` (static-check-full) runs this file
// and scripts/test-unit-ci.sh skips it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CHECK = join(import.meta.dir, "check.ts");
// Hermetic git: CI has no identity, and host config (hooks, signing) must not leak in.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let repo: string;

function git(...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: GIT_ENV,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function check(base: string, env: NodeJS.ProcessEnv = GIT_ENV) {
  const result = spawnSync(process.execPath, [CHECK, "--base", base], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

// CC 10: above the new-function limit, below the CRAP tax stage.
const BRANCHY = `export function route(a: number, b: number) {
${Array.from({ length: 9 }, (_, i) => `  if (a === ${i}) return b;`).join("\n")}
  return 0;
}
`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "crap-check-test-"));
  git("init", "-q", "-b", "main");
  write("src/demo/route.ts", BRANCHY);
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("a renamed file keeps its functions' identity", () => {
  git("mv", "src/demo/route.ts", "src/demo/router.ts");
  git("commit", "-q", "-m", "rename");

  const result = check("HEAD~1");

  // Without rename pairing, route (CC 10) would be a new-function violation.
  expect(result.status).toBe(0);
  expect(result.out).not.toContain("new-function");
});

test("a file renamed to an unscored type counts as removed", () => {
  git("mv", "src/demo/route.ts", "src/demo/route.txt");
  git("commit", "-q", "-m", "retire");

  expect(check("HEAD~1").status).toBe(0);
});

test("a file renamed into production counts as new", () => {
  git("mv", "src/demo/route.ts", "src/demo/route.test.ts");
  git("commit", "-q", "-m", "make it a test");
  git("mv", "src/demo/route.test.ts", "src/demo/route.ts");
  git("commit", "-q", "-m", "back to production");

  const result = check("HEAD~1");

  expect(result.status).toBe(1);
  expect(result.out).toContain(
    "VIOLATION new-function src/demo/route.ts:1-12 route: new function CC 10"
  );
});

test("a touched hotspot warns even with the user's diff prefix config", () => {
  // CC 31: above the CRAP tax stage.
  const hot = `export function hot(a: number) {
${Array.from({ length: 30 }, (_, i) => `  if (a === ${i}) return ${i};`).join("\n")}
  return -1;
}
`;
  write("src/demo/hot.ts", hot);
  git("add", ".");
  git("commit", "-q", "-m", "hotspot");
  write("src/demo/hot.ts", hot.replace("  return -1;", "  // why -1\n  return -1;"));
  // With this, plain `git diff` prints `+++ w/src/...`.
  git("config", "diff.mnemonicPrefix", "true");

  const result = check("HEAD");

  expect(result.status).toBe(0);
  expect(result.out).toContain(
    "warning   crap-tax     src/demo/hot.ts:1-34 hot: touched hotspot, CC 31 unchanged"
  );
});

test("a CC gain fails, and a Crap-Debt trailer turns it into a listed warning", () => {
  write(
    "src/demo/route.ts",
    BRANCHY.replace("  return 0;", "  if (b > a && a > 0) return a;\n  return 0;")
  );
  git("commit", "-q", "-am", "grow");

  const failed = check("HEAD~1");
  expect(failed.status).toBe(1);
  expect(failed.out).toContain("VIOLATION floor-cc     src/demo/route.ts:1-13 route: CC 10 -> 12");

  git("commit", "-q", "--allow-empty", "-m", "note\n\nCrap-Debt: hotfix, refactor tracked in #1");
  const bypassed = check("HEAD~2");
  expect(bypassed.status).toBe(0);
  expect(bypassed.out).toContain("warning   floor-cc");
  expect(bypassed.out).toMatch(/Crap-Debt \(commit [0-9a-f]+\): hotfix, refactor tracked in #1/);
});

test("a tool error exits 2, not 1", () => {
  expect(check("no-such-ref").status).toBe(2);

  write("src/demo/route.ts", `${BRANCHY}// edit\n`);
  // A PATH with only git: package managers often install uv next to git.
  const gitOnly = join(repo, ".bin");
  mkdirSync(gitOnly);
  symlinkSync(Bun.which("git") ?? "/usr/bin/git", join(gitOnly, "git"));
  const noUv = { ...GIT_ENV, PATH: gitOnly };
  const result = check("HEAD", noUv);
  expect(result.status).toBe(2);
  expect(result.err).toContain("crap-check: tool error");
});
