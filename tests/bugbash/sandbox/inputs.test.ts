import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkMountSource,
  containerEnv,
  exactStepRefusal,
  jobEnv,
  outputDir,
  stage,
} from "./inputs";
import { Refusal } from "./runner";

let root = "";
let outside = "";
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xbb-inputs-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xbb-outside-")));
  fs.writeFileSync(path.join(outside, "secret"), "host secret\n");
  write("package.json", "{}");
  write("src/a.ts", "a");
  write("tests/bugbash/repros/x.e2e.ts", "x");
  write(".gitignore", "tests/bugbash/.e2e/\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
});
afterEach(() => {
  for (const dir of [root, outside]) fs.rmSync(dir, { recursive: true, force: true });
});
function write(rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function git(...args: string[]) {
  expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
}
const into = () => path.join(root, "..", `${path.basename(root)}-stage`);
afterEach(() => fs.rmSync(into(), { recursive: true, force: true }));

test("stage copies tracked and new unignored files, not ignored ones", () => {
  write("tests/bugbash/repros/new.e2e.ts", "new");
  write("tests/bugbash/.e2e/old/report.json", "old run");
  expect(stage(root, into())).toBe(4);
  expect(fs.readFileSync(path.join(into(), "tests/bugbash/repros/new.e2e.ts"), "utf8")).toBe("new");
  expect(fs.existsSync(path.join(into(), "tests/bugbash/.e2e/old"))).toBe(false);
  for (const dir of ["dist", "node_modules", "tests/bugbash/.e2e"])
    expect(fs.readdirSync(path.join(into(), dir))).toEqual([]);
});

test.each([
  [
    "a symlinked file",
    () => fs.symlinkSync(path.join(outside, "secret"), path.join(root, "src/link.ts")),
  ],
  [
    // A tracked folder replaced by a symlink: git still lists the tracked file under it, and a
    // plain lstat of that file follows the link.
    "a tracked folder that became a symlink",
    () => {
      fs.writeFileSync(path.join(outside, "x.e2e.ts"), "host secret\n");
      fs.rmSync(path.join(root, "tests/bugbash/repros"), { recursive: true });
      fs.symlinkSync(outside, path.join(root, "tests/bugbash/repros"));
      // git must not list the link itself, so only the folder check can catch it.
      fs.mkdirSync(path.join(root, ".git/info"), { recursive: true });
      fs.appendFileSync(path.join(root, ".git/info/exclude"), "tests/bugbash/repros\n");
    },
  ],
])("stage refuses %s and copies no host file", (_name, plant) => {
  plant();
  expect(() => stage(root, into())).toThrow(Refusal);
  const copied = spawnSync("grep", ["-r", "host secret", into()], { encoding: "utf8" });
  expect(copied.stdout).toBe("");
});

test("stage keeps the mode bits: an executable stays executable", () => {
  write("tests/bugbash/sandbox/build.sh", "#!/bin/sh\necho ok\n");
  fs.chmodSync(path.join(root, "tests/bugbash/sandbox/build.sh"), 0o755);
  stage(root, into());
  const staged = path.join(into(), "tests/bugbash/sandbox/build.sh");
  expect(fs.statSync(staged).mode & 0o777).toBe(0o755);
  expect(spawnSync(staged, { encoding: "utf8" }).stdout).toBe("ok\n");
});

test("a mount source must be a plain folder of the checkout", () => {
  fs.mkdirSync(path.join(root, "dist"));
  expect(checkMountSource(root, "dist")).toBe(path.join(root, "dist"));
  expect(() => checkMountSource(root, "node_modules")).toThrow("missing");
  fs.symlinkSync(outside, path.join(root, "node_modules"));
  expect(() => checkMountSource(root, "node_modules")).toThrow("not a symlink");
  // A checkout reached through a symlink: Docker would mount the real target.
  const linked = `${root}-link`;
  fs.symlinkSync(root, linked);
  try {
    expect(() => checkMountSource(linked, "dist")).toThrow("not a canonical path");
  } finally {
    fs.rmSync(linked);
  }
});

test("the container env passes only allowlisted names, and never a credential", () => {
  const host = { BUGBASH_AI: "mock", HOME: "/home/u", ANTHROPIC_API_KEY: "sk", GH_TOKEN: "t" };
  expect(containerEnv(host, jobEnv(".e2e/r"))).toEqual({
    HOME: "/home/bugbash",
    TMPDIR: "/tmp",
    BUGBASH_AI: "mock",
    BUGBASH_APP_LOG: ".e2e/r/app.log",
    E2E_TELEMETRY_DISABLED: "1",
    BUGBASH_CONTAINER: "1",
  });
  // prettier-ignore
  for (const name of ["OPENAI_BASE_URL", "API_KEY", "token", "GH_AUTH_TOKEN", "SECRET",
    "AWS_SECRET_ACCESS_KEY", "GITHUB_PAT", "PRIVATE_KEY", "GOOGLE_APPLICATION_CREDENTIALS"])
    expect(() => containerEnv({}, { [name]: "x" })).toThrow("no credential");
  expect(containerEnv({}, { BUGBASH_CONTAINER: "0" }).BUGBASH_CONTAINER).toBe("1");
});

test("the app log stays in the output folder, also when the caller set another path", () => {
  const saved = process.env.BUGBASH_APP_LOG;
  process.env.BUGBASH_APP_LOG = "../../outside.app.log";
  try {
    expect(containerEnv(process.env, jobEnv(".e2e/r1")).BUGBASH_APP_LOG).toBe(".e2e/r1/app.log");
  } finally {
    if (saved == null) delete process.env.BUGBASH_APP_LOG;
    else process.env.BUGBASH_APP_LOG = saved;
  }
});

test("only an exact-step `e2e run` with the repro config passes", () => {
  const dir = path.join(root, "tests/bugbash");
  write("tests/bugbash/e2e.config.ts", "export default {}");
  const ok = [
    "run",
    "--config",
    "e2e.config.ts",
    "--output",
    ".e2e/r",
    "--tag=mock-only",
    "--pass-with-no-tests",
  ];
  expect(exactStepRefusal(ok, dir, dir)).toBeNull();
  for (const args of [
    ["explore", "--config", "e2e.config.ts"],
    ["run", "--config", "e2e.mcpapps.config.ts"],
    ["run", "--config", "e2e.config.ts", "--config", "e2e.config.ts"],
    ["run", "--config", "e2e.config.ts", "repros/x.e2e.ts"],
    ["run", "--config", "e2e.config.ts", "--agent", "x"],
    ["run", "--config", "e2e.config.ts", "--tag"],
    ["run", "--config", "e2e.config.ts", "--workers", "4"],
    ["run", "--config", "e2e.config.ts", "--retries=2"],
  ])
    expect(exactStepRefusal(args, dir, dir)).not.toBeNull();
  expect(exactStepRefusal(ok, root, dir)).toContain("the cwd must be");
  fs.rmSync(path.join(dir, "e2e.config.ts"));
  fs.symlinkSync(path.join(outside, "secret"), path.join(dir, "e2e.config.ts"));
  expect(exactStepRefusal(ok, dir, dir)).toContain("not a regular file");
});

test("the output folder is one plain .e2e/<folder>", () => {
  expect(outputDir(["run", "--output", ".e2e/repros-mock"])).toBe(".e2e/repros-mock");
  expect(outputDir(["run", "--output=.e2e/a/b"])).toBe(".e2e/a/b");
  for (const args of [
    [],
    ["--output", "out"],
    ["--output", ".e2e/../x"],
    ["--output", ".e2e/a", "--output", ".e2e/b"],
  ])
    expect(() => outputDir(args)).toThrow(Refusal);
});
