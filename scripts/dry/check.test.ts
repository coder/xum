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

test("a new copy that shares a name with an old match is a finding", () => {
  // Base: B.render already matches cents. The diff adds A.render, a copy, above
  // it. Both are "render", so only git's hunks tell the new one from the old one.
  const method = (cls: string) =>
    `export class ${cls} {\n  render(n: number): string {\n    if (n === 0) return "0";\n    if (n < 100) return "1-99";\n    if (n < 1000) return "100-999";\n    return "1000+";\n  }\n}\n`;
  write("src/r.ts", `${method("B")}\n${bucket("cents")}`);
  git("add", ".");
  git("commit", "-q", "-m", "old pair");
  write("src/r.ts", `${method("A")}\n${method("B")}\n${bucket("cents")}`);

  const { status, report } = check();

  expect(status).toBe(1);
  type Side = { path: string; name: string; startLine: number };
  const pairs = (report.pairs as Array<{ left: Side; right: Side }>)
    .filter((p) => p.left.path === "src/r.ts" && p.left.startLine === 2)
    .filter((p) => p.right.path === "src/r.ts")
    .map((p) => p.right.name);
  // The copy matches both B.render and cents; the cents pair is the one a
  // name-based base lookup hid (it read B.render's base match as A's).
  expect(pairs.sort()).toEqual(["cents", "render"]);
});

test("a dry-duplicate-ok marker in the changed function accepts the pair", () => {
  const marked = bucket("fee").replace(
    "export function",
    "// dry-duplicate-ok: fees and cents must change apart\nexport function"
  );
  write("src/b.ts", marked);
  git("add", "-N", "src/b.ts");

  const { status, report } = check();

  expect(status).toBe(0);
  const reasons = (report.pairs as Array<{ accepted?: string }>).map((p) => p.accepted);
  expect(reasons).toEqual(["fees and cents must change apart", "fees and cents must change apart"]);
});

test("a marker on the old side does not excuse a new copy", () => {
  const path = join(repo, "src/a.ts");
  writeFileSync(path, `// dry-duplicate-ok: an old excuse\n${readFileSync(path, "utf8")}`);
  git("commit", "-qam", "old marker");
  write("src/b.ts", bucket("fee"));
  git("add", "-N", "src/b.ts");

  const { status, report } = check();

  expect(status).toBe(1);
  expect((report.pairs as Array<{ accepted?: string }>).some((p) => p.accepted)).toBe(false);
});

test("a function moved to another file keeps its old pairs quiet", () => {
  // src/a.ts keeps other code, so git sees two edits, not a rename.
  const other = `export function keep(s: string): number {
  const parts = s.split(",");
  let total = 0;
  for (const p of parts) total += p.length * 3;
  return total - parts.length;
}
`;
  write("src/a.ts", `${bucket("cents")}\n${other}`);
  write("src/c.ts", bucket("count"));
  write("src/b.ts", other.replace("keep", "keepB"));
  git("add", ".");
  git("commit", "-q", "-m", "before the move");
  write("src/a.ts", other);
  write("src/b.ts", `${other.replace("keep", "keepB")}\n${bucket("cents")}`);

  const { status, report } = check();

  expect(status).toBe(0);
  expect(report.pairs).toEqual([]);
});
