import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// build.sh --key names committed source only, and the key follows each of its three inputs.
// Each test runs the real script in a throwaway git repo with copies of its inputs.
const SANDBOX = "tests/bugbash/sandbox";
const lock = (version: string) =>
  `{\n  "packages": {\n    "playwright-core": ["playwright-core@1.57.0", ""],\n` +
  `    "@e2e-dev/web/playwright-core": ["playwright-core@${version}", ""],\n  }\n}\n`;

let repo = "";
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  expect(r.status).toBe(0);
}
function setup(version = "1.63.0") {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-build-key-"));
  fs.mkdirSync(path.join(repo, SANDBOX), { recursive: true });
  for (const name of ["build.sh", "Dockerfile"])
    fs.copyFileSync(path.join(import.meta.dir, name), path.join(repo, SANDBOX, name));
  fs.writeFileSync(path.join(repo, "bun.lock"), lock(version));
  git("init", "-q");
  commit();
}
function commit() {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
}
function key() {
  const r = spawnSync(path.join(repo, SANDBOX, "build.sh"), ["--key"], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

test("the key changes with each input and is stable otherwise", () => {
  setup();
  const first = key();
  expect(first.status).toBe(0);
  expect(first.out).toMatch(/^[0-9a-f]{64}$/);
  expect(key().out).toBe(first.out);

  const keys = new Set([first.out]);
  fs.writeFileSync(path.join(repo, "bun.lock"), lock("1.64.0"));
  commit();
  keys.add(key().out);
  fs.appendFileSync(path.join(repo, SANDBOX, "Dockerfile"), "# change\n");
  commit();
  keys.add(key().out);
  fs.appendFileSync(path.join(repo, SANDBOX, "build.sh"), "# change\n");
  commit();
  keys.add(key().out);
  expect(keys.size).toBe(4);
});

test("an uncommitted input refuses", () => {
  setup();
  fs.appendFileSync(path.join(repo, SANDBOX, "Dockerfile"), "# local edit\n");
  expect(key()).toMatchObject({ status: 2, out: "" });
  expect(key().err).toContain("differs from HEAD");
});

test("the version comes only from the @e2e-dev/web copy, and must be unique", () => {
  setup();
  // The root playwright-core entry (1.57.0) does not count.
  fs.writeFileSync(path.join(repo, "bun.lock"), lock("1.63.0").replace("@e2e-dev/web/", "x/"));
  commit();
  expect(key()).toMatchObject({ status: 2, out: "" });
  expect(key().err).toContain("found 0");
});
