// End-to-end tests of `scripts/crap/check.ts` in throwaway git repos. They
// need uv (the scorer runs through `uv run`), which the Test / Unit runners do
// not install, so `make test-crap-scripts` (static-check-full) runs this file
// and scripts/test-unit-ci.sh skips it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // A PATH with git but no uv: the scorer cannot start.
  const noUv = { ...GIT_ENV, PATH: dirname(Bun.which("git") ?? "/usr/bin/git") };
  expect(Bun.which("uv", { PATH: noUv.PATH })).toBeNull();
  const result = check("HEAD", noUv);
  expect(result.status).toBe(2);
  expect(result.err).toContain("crap-check: tool error");
});
