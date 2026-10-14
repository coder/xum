import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The runner's input checks, end to end. Every case also passes a missing --chrome, so a mutation that
// drops one check still exits 2 before any server or browser starts: the message is what fails.
const repo = path.resolve(import.meta.dir, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-timing-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const tree = (name: string, html: string) => {
  fs.mkdirSync(path.join(tmp, name, "dist/cli"), { recursive: true });
  fs.writeFileSync(path.join(tmp, name, "dist/cli/index.js"), "");
  fs.writeFileSync(path.join(tmp, name, "dist/index.html"), html);
  return path.join(tmp, name);
};
const runner = (args: string[]) => {
  const chrome = path.join(tmp, "no-chrome");
  const cmd = ["--import", "tsx", "scripts/perf/pageTiming.ts", "--chrome", chrome, ...args];
  const r = spawnSync("node", cmd, {
    cwd: repo,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PAGE_TIMING_LOCK: "" },
  });
  expect(r.stderr).toContain(`--chrome ${chrome} does not exist`);
  return r;
};

test("refuses inherited page names, a reused --out folder and --aa trees of two commits", () => {
  const out = path.join(tmp, "used-out");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "qualification.json"), "{}"); // an old result
  const [a, b] = [tree("a", "<p>1</p>"), tree("b", "<p>2</p>")];
  const r = runner(["--base", a, "--head", b, "--aa", "--pages", "p1,constructor", "--out", out]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("unknown page in --pages p1,constructor");
  expect(r.stderr).toContain(`--out ${out} is not a new or empty folder`);
  expect(r.stderr).toContain("--aa needs two builds of one commit");
}, 60_000);

test("refuses a --predict key given twice, and a file as --out", () => {
  const a = tree("c", "<p>1</p>");
  const q = path.join(tmp, "q.json");
  fs.writeFileSync(
    q,
    JSON.stringify({ p1: { qualification: "qualified", mdi: { ucs: 0.1, ir: 0.1 } } })
  );
  const predict = ["--predict", "p1.ucs=0.1,p1.ucs=5", "--out", q]; // q: a file, not a folder
  const r = runner(["--base", a, "--head", a, "--qualification", q, "--pages", "p1", ...predict]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("duplicate --predict key p1.ucs");
  expect(r.stderr).toContain(`--out ${q} is not a new or empty folder`);
  expect(r.stderr).not.toContain("bad --predict keys");
}, 60_000);

// #6204 item 4: a signal ends the run in progress through its finally blocks (server, folder, lock).
// The fake server exits at once, so the signal finds the runner in its host wait or its health wait.
test("SIGTERM during a run exits 143", async () => {
  const [t, out] = [tree("d", "<p>1</p>"), path.join(tmp, "signal-out")];
  const args = [
    "--chrome",
    "/bin/true",
    "--base",
    t,
    "--head",
    t,
    "--aa",
    "--pages",
    "p1",
    "--out",
    out,
  ];
  const env = { ...process.env, PAGE_TIMING_LOCK: path.join(tmp, "private.lock") };
  const runner = spawn("node", ["--import", "tsx", "scripts/perf/pageTiming.ts", ...args], {
    cwd: repo,
    env,
  });
  const exit = once(runner, "exit");
  while (!fs.existsSync(out)) await new Promise((resolve) => setTimeout(resolve, 100)); // main() runs
  runner.kill("SIGTERM");
  expect(await exit).toEqual([143, null]);
}, 60_000);
