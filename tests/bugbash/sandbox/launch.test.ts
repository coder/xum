import { expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { appAi, containerEnv, exactStepRefusal, exitCode, outputDir, plainFolders } from "./launch";

test("the container env holds the allowlisted names, the fixed values and no host secret", () => {
  const host = {
    BUGBASH_AI_RESOLVED: "mock",
    BUGBASH_AI_REASON: "https://user:pass@proxy.example/v1 unreachable",
    BUGBASH_MODEL: "anthropic:claude-sonnet-5-5",
    ANTHROPIC_API_KEY: "sk-ant-real",
    OPENAI_API_KEY: "sk-real",
    GH_TOKEN: "ghp_real",
    XUM_SERVER_AUTH_TOKEN: "real",
    HOME: "/home/alice",
    PATH: "/usr/bin",
    TMPDIR: "/home/alice/tmp",
  };
  expect(containerEnv(host, { BUGBASH_APP_LOG: ".e2e/run/app.log" })).toEqual({
    HOME: "/home/bugbash",
    TMPDIR: "/tmp",
    BUGBASH_CONTAINER: "1",
    BUGBASH_AI_RESOLVED: "mock",
    BUGBASH_MODEL: "anthropic:claude-sonnet-5-5",
    BUGBASH_APP_LOG: ".e2e/run/app.log",
  });
});

test("a credential from a caller is refused, not passed", () => {
  // prettier-ignore
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "GH_TOKEN", "openai_api_key"]) {
    expect(() => containerEnv({}, { [name]: "x" })).toThrow("no credential enters the sandbox");
  }
});

test("the export comes back only to one folder under .e2e", () => {
  expect(outputDir(["run", "--output", ".e2e/repros", "--grep", "x"])).toBe(".e2e/repros");
  expect(outputDir(["run", "--output=.e2e/runs/one"])).toBe(".e2e/runs/one");
  for (const args of [
    ["run"],
    ["run", "--output"],
    ["run", "--output", ".e2e/a", "--output", ".e2e/b"],
    ["run", "--output", ".e2e"],
    ["run", "--output", ".e2e/../escape"],
    ["run", "--output", ".e2e/./a"],
    ["run", "--output", "/tmp/escape"],
    ["run", "--output", "../.e2e/escape"],
    ["run", "--output", ".e2e/a b"],
  ]) {
    expect(() => outputDir(args)).toThrow("exactly one --output");
  }
});

test("the launcher reads the app AI mode the way e2e.config.ts does", () => {
  expect(appAi({ BUGBASH_AI: "mock" })).toBe("mock");
  expect(appAi({ BUGBASH_AI: "mock", BUGBASH_AI_RESOLVED: "real" })).toBe("real");
  expect(appAi({ BUGBASH_AI: "auto" })).toBeUndefined();
});

test("a symlinked folder cannot lead a copy or an export out of the checkout", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
  try {
    fs.symlinkSync(outside, path.join(base, ".e2e"));
    fs.mkdirSync(path.join(base, "src"));
    fs.writeFileSync(path.join(base, "src/file"), "");
    expect(() => plainFolders(base, ".e2e/run", true)).toThrow("not a plain folder");
    expect(() => plainFolders(base, ".e2e", false)).toThrow("not a plain folder");
    expect(() => plainFolders(base, "src/file", true)).toThrow("not a plain folder");
    expect(fs.readdirSync(outside)).toEqual([]);
    plainFolders(base, "src/new/run", true);
    expect(fs.lstatSync(path.join(base, "src/new/run")).isDirectory()).toBe(true);
    expect(() => plainFolders(base, "src/missing", false)).toThrow("not a plain folder");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a job that a signal ended exits 128 + the signal number", () => {
  expect(exitCode(3, null)).toBe(3);
  expect(exitCode(null, "SIGKILL")).toBe(137);
  expect(exitCode(null, "SIGTERM")).toBe(143);
});

const BUGBASH_DIR = path.resolve(import.meta.dir, "..");
const OUT = ["--output", ".e2e/launch-test"];
const OK = ["run", "--config", "e2e.config.ts", ...OUT];
// Each one would let e2e load another config or tests, or let a model pick actions.
const NOT_EXACT: string[][] = [
  ["run", "--config", "e2e.config.ts", "--config", "e2e.mcpapps.config.ts", ...OUT],
  ["run", "--config=e2e.mcpapps.config.ts", ...OUT],
  ["run", "--config", "./e2e.config.ts", ...OUT],
  ["run", "--config", "../bugbash/e2e.config.ts", ...OUT],
  ["run", "--config", "./tests/../e2e.config.ts", ...OUT],
  ["run", "--config", "mcpapps/../e2e.config.ts", ...OUT],
  [...OK, "--", "mcpapps/mcp-apps.e2e.ts"],
  [...OK, "mcpapps/mcp-apps.e2e.ts"],
  ["explore", "--config", "e2e.config.ts", ...OUT],
  ["run", "explore", "--config", "e2e.config.ts", ...OUT],
  [...OK, "explore"],
  [...OK, "--agent", "explorer"],
  [...OK, "--no-cache"],
  ["run", "--tag", "--config", "e2e.mcpapps.config.ts", ...OUT],
  ["run", ...OUT],
  // Each of these is refused by one rule only (the mutation check showed that the cases above
  // also trip a second rule): two positionals, a dash-led option value, `explore` as a value.
  [...OK, "mcpapps/mcp-apps.e2e.ts", "mcpapps/seed.ts"],
  ["run", "--grep", "--config=e2e.mcpapps.config.ts", "--config", "e2e.config.ts", ...OUT],
  [...OK, "--grep", "explore"],
];

test("only `e2e run --config e2e.config.ts` with selection options is an exact-step run", () => {
  expect(exactStepRefusal(OK, BUGBASH_DIR)).toBeNull();
  // prettier-ignore
  expect(exactStepRefusal(["run", "--config=e2e.config.ts", "--tag", "a", "--grep=b", "--pass-with-no-tests", ...OUT], BUGBASH_DIR)).toBeNull();
  for (const args of NOT_EXACT) expect(exactStepRefusal(args, BUGBASH_DIR)).toBeString();
  // e2e resolves --config from its cwd: another folder, or a symlinked config, is refused.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
  try {
    expect(exactStepRefusal(OK, other)).toContain("the cwd must be");
    fs.symlinkSync(path.join(BUGBASH_DIR, "e2e.config.ts"), path.join(other, "e2e.config.ts"));
    expect(exactStepRefusal(OK, other, other)).toContain("not a regular file");
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

/**
 * Runs the launcher with a fake docker and a fake e2e node, which log each call. `sandbox`: the
 * fake docker reports a local Linux engine, so the launcher picks the sandbox. Else the real
 * app AI sends the job to the host fallback.
 */
function launch(args: string[], sandbox: boolean, cwd = BUGBASH_DIR) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
  const calls = path.join(bin, "calls.log");
  const fake = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`, {
      mode: 0o755,
    });
  fake(
    "docker",
    [
      'case "$1" in',
      "  context) echo unix:///var/run/docker.sock ;;",
      '  info) echo \'{"OSType":"linux","OperatingSystem":"Ubuntu","SecurityOptions":[]}\' ;;',
      "  image) exit 0 ;;",
      "  *) exit 1 ;;", // the same-host probe fails: the job falls back to the host fake below
      "esac",
    ].join("\n")
  );
  fake("e2e-node", "exit 0");
  try {
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dir, "launch.ts"), "--", ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME,
          E2E_NODE: path.join(bin, "e2e-node"),
          BUGBASH_AI_RESOLVED: sandbox ? "mock" : "real",
        },
      }
    );
    const log = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
    return { status: r.status, stderr: r.stderr, log };
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(path.join(BUGBASH_DIR, ".e2e/launch-test"), { recursive: true, force: true });
  }
}

test("the launcher runs nothing else, in the sandbox and on the host fallback", () => {
  // Controls: the exact-step run reaches the docker run (sandbox) or the e2e node (host).
  const sandboxed = launch(OK, true);
  expect(sandboxed.log).toContain("docker run");
  const hosted = launch(OK, false);
  expect(hosted.log).toContain(
    `e2e-node ${path.resolve(BUGBASH_DIR, "../..")}/node_modules/.bin/e2e run`
  );
  for (const sandbox of [true, false])
    for (const args of NOT_EXACT) {
      const r = launch(args, sandbox);
      expect({ args, status: r.status, ran: r.log.match(/docker (run|build)|e2e-node/g) }).toEqual({
        args,
        status: 2,
        ran: null,
      });
      expect(r.stderr).toContain("exact-step repros");
    }
  // The same args from another cwd would load another e2e.config.ts.
  const elsewhere = launch(OK, false, path.resolve(BUGBASH_DIR, "../.."));
  expect([elsewhere.status, elsewhere.log.includes("e2e-node")]).toEqual([2, false]);
});
