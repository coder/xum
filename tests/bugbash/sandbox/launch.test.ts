import { expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import * as crypto from "crypto";
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

// The fake docker CLI. It logs each call: its args, its env names, DOCKER_HOST, DOCKER_CONFIG,
// the files in that folder, and whether the env or that folder holds the synthetic MARKER.
// It answers like a local Linux engine. `context` answers from DOCKER_HOST, else DOCKER_CONTEXT.
// The launcher passes the fake no FAKE_* env (that is the rule under test), so launch() writes
// the log path and the modes into the script.
const FAKE_DOCKER = String.raw`
{
  echo "CALL $*"
  echo "ENV $(env | sed 's/=.*//' | grep -vxE 'PWD|OLDPWD|SHLVL|_' | sort | tr '\n' ' ')"
  echo "HOST $DOCKER_HOST CONFIG $DOCKER_CONFIG"
  echo "FILES $(ls -A "$DOCKER_CONFIG" 2>&1 | tr '\n' ' ')"
  echo "MARKER $(env | grep -c MARKER) $(grep -rl MARKER "$DOCKER_CONFIG" 2>/dev/null | wc -l)"
} >> "$FAKE_LOG"
case "$1" in
  context)
    if [ "$DOCKER_CONTEXT" = missing ]; then echo 'context "missing": not found' >&2; exit 1; fi
    if [ -n "$DOCKER_HOST" ]; then echo "$DOCKER_HOST"
    elif [ "$DOCKER_CONTEXT" = remote ]; then echo tcp://10.0.0.1:2376
    elif [ "$DOCKER_CONTEXT" = other ]; then echo unix:///run/other.sock
    else echo unix:///var/run/docker.sock; fi ;;
  info) echo '{"OSType":"linux","OperatingSystem":"Ubuntu","SecurityOptions":[]}' ;;
  image) [ "$FAKE_IMAGE" = present ] ;;
  build) cat > "$FAKE_LOG.dockerfile" ;;
  run)
    src=$(printf '%s\n' "$@" | sed -n 's/^type=bind,src=\([^,]*\),dst=\/probe,readonly$/\1/p')
    if [ -z "$src" ]; then printf '{"end":true}\n'; exit 0; fi
    if [ "$FAKE_SLOW" = probe ]; then touch "$FAKE_LOG.ready"; sleep 3; fi
    [ "$FAKE_PROBE" = fail ] && exit 1
    cat /proc/sys/kernel/random/boot_id; cat "$src/.nonce"; echo ;;
  ps) [ -e "$FAKE_LOG.rm" ] || echo cid123 ;;
  rm) touch "$FAKE_LOG.rm" ;;
  *) exit 1 ;;
esac
`;

interface Launch {
  /** The real app AI: the launcher refuses before any docker call. */
  realAi?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  /** The fake's same-host probe fails. */
  probeFails?: boolean;
  /** The image is missing, so the launcher builds it. */
  build?: boolean;
  /** This step waits 3 s and touches `<calls>.ready` first (git ls-files for the staging). */
  slow?: "stage" | "probe";
}

const REAL_GIT = Bun.which("git") ?? "git";

/** A bin folder with the fake docker (and, for a slow staging, a git that waits first). */
function fakeBin(options: Launch) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
  const calls = path.join(bin, "calls.log");
  const script = FAKE_DOCKER.replaceAll("$FAKE_LOG", calls)
    .replaceAll("$FAKE_PROBE", options.probeFails === true ? "fail" : "ok")
    .replaceAll("$FAKE_IMAGE", options.build === true ? "missing" : "present")
    .replaceAll("$FAKE_SLOW", options.slow ?? "");
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh${script}`, { mode: 0o755 });
  if (options.slow === "stage")
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *ls-files*) touch ${calls}.ready; sleep 3 ;; esac\nexec ${REAL_GIT} "$@"\n`,
      { mode: 0o755 }
    );
  return { bin, calls };
}

function launchEnv(bin: string, options: Launch): Record<string, string> {
  return {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "",
    BUGBASH_AI_RESOLVED: options.realAi === true ? "real" : "mock",
    ...options.env,
  };
}

/** Runs the launcher with the fake docker, which logs each call. */
function launch(args: string[], options: Launch = {}) {
  const { bin, calls } = fakeBin(options);
  try {
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dir, "launch.ts"), "--", ...args],
      { cwd: options.cwd ?? BUGBASH_DIR, encoding: "utf8", env: launchEnv(bin, options) }
    );
    const log = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
    const dockerfile = fs.existsSync(`${calls}.dockerfile`)
      ? fs.readFileSync(`${calls}.dockerfile`, "utf8")
      : null;
    return { status: r.status, stderr: r.stderr, log, dockerfile };
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(path.join(BUGBASH_DIR, ".e2e/launch-test"), { recursive: true, force: true });
  }
}

test("the launcher runs exact-step repros in the sandbox, and nothing else anywhere", () => {
  // Control: the exact-step run reaches the probe and the job container.
  const sandboxed = launch(OK);
  expect([sandboxed.status, sandboxed.log.match(/CALL run/g)?.length]).toEqual([0, 2]);
  for (const args of NOT_EXACT) {
    const r = launch(args);
    expect({ args, status: r.status, ran: r.log.match(/CALL (run|build)/g) }).toEqual({
      args,
      status: 2,
      ran: null,
    });
    expect(r.stderr).toContain("exact-step repros");
  }
  // The same args from another cwd would load another e2e.config.ts.
  const elsewhere = launch(OK, { cwd: path.resolve(BUGBASH_DIR, "../..") });
  expect([elsewhere.status, elsewhere.log.includes("CALL run")]).toEqual([2, false]);
});

test("without the sandbox the launcher refuses: no host fallback", () => {
  // The real app AI needs the provider proxy: refused before any docker call.
  const real = launch(OK, { realAi: true });
  expect([real.status, real.log]).toEqual([2, ""]);
  expect(real.stderr).toContain("sandbox only");
  // No usable Docker, or a failed same-host probe: refused, and no job runs.
  for (const options of [{ env: { DOCKER_CONTEXT: "missing" } }, { probeFails: true }]) {
    const r = launch(OK, options);
    expect([r.status, r.log.match(/CALL run/g)?.length ?? 0]).toEqual([
      2,
      options.probeFails === true ? 1 : 0,
    ]);
    expect(r.stderr).toContain("refused:");
  }
});

test("the image builds from the committed Dockerfile on stdin, with no context and one build arg", () => {
  const r = launch(OK, { build: true });
  expect(r.status).toBe(0);
  const build = r.log.split("\n").find((line) => line.startsWith("CALL build"));
  expect(build).toMatch(
    /^CALL build --build-arg PLAYWRIGHT_CORE_VERSION=\d+\.\d+\.\d+\S* -t xum-bugbash-sandbox:[0-9a-f]{12} -$/
  );
  const committed = spawnSync("git", ["show", "HEAD:tests/bugbash/sandbox/Dockerfile"], {
    cwd: BUGBASH_DIR,
    encoding: "utf8",
  });
  expect(committed.status).toBe(0);
  expect(r.dockerfile).toBe(committed.stdout);
});

const CHECKOUT_ID = crypto
  .createHash("sha256")
  .update(path.resolve(BUGBASH_DIR, "../.."))
  .digest("hex")
  .slice(0, 12);

test.each([
  ["stage", "SIGINT", 130],
  ["stage", "SIGTERM", 143],
  ["probe", "SIGINT", 130],
  ["probe", "SIGTERM", 143],
] as const)(
  "a %s step stopped by %s removes this job's folder only",
  async (slow, signal, code) => {
    const options: Launch = { slow };
    const { bin, calls } = fakeBin(options);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
    // Another job of this checkout, and a job of another checkout: both must stay.
    const jobs = path.join(tmp, "xum-bugbash-sandbox");
    for (const other of [`${CHECKOUT_ID}/xbb-other-job`, "0123456789ab/xbb-another-checkout"]) {
      fs.mkdirSync(path.join(jobs, other), { recursive: true });
      fs.writeFileSync(path.join(jobs, other, "keep"), "");
    }
    const listJobs = () =>
      fs
        .readdirSync(jobs, { recursive: true })
        .map(String)
        .filter((entry) => entry.split("/").length === 2)
        .sort();
    try {
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "launch.ts"), "--", ...OK],
        {
          cwd: BUGBASH_DIR,
          env: { ...launchEnv(bin, options), TMPDIR: tmp },
          stderr: "pipe",
        }
      );
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(`${calls}.ready`) && Date.now() < deadline) await Bun.sleep(50);
      expect(fs.existsSync(`${calls}.ready`)).toBe(true);
      // The launcher's own folder exists while the step runs.
      expect(listJobs().length).toBe(3);
      child.kill(signal);
      expect(await child.exited).toBe(code);
      expect(await new Response(child.stderr).text()).toContain(`stopped by ${signal}`);
      expect(listJobs()).toEqual(
        [`${CHECKOUT_ID}/xbb-other-job`, "0123456789ab/xbb-another-checkout"].sort()
      );
      expect(fs.readdirSync(tmp).sort()).toEqual(["xum-bugbash-sandbox"]); // no docker client folder
      // The job container never started.
      expect(fs.readFileSync(calls, "utf8").match(/CALL run/g)?.length ?? 0).toBe(
        slow === "probe" ? 1 : 0
      );
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(path.join(BUGBASH_DIR, ".e2e/launch-test"), { recursive: true, force: true });
    }
  },
  30_000
);

/** The calls in a fake docker log, one record per call. */
function dockerCalls(log: string) {
  return log
    .split("CALL ")
    .slice(1)
    .map((block) => {
      const line = (key: string) =>
        block
          .split("\n")
          .find((l) => l.startsWith(`${key} `))
          ?.slice(key.length + 1) ?? "";
      const [host, , config] = line("HOST").split(" ");
      return {
        command: block.split("\n")[0],
        env: line("ENV").trim(),
        host,
        config,
        files: line("FILES").trim(),
        marker: line("MARKER"),
      };
    })
    .filter((call) => call.command !== "");
}

/** A client config with an authenticated proxy: the CLI would copy it into builds and containers. */
function syntheticDockerConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
  const proxy = "http://user:MARKER-secret@127.0.0.1:9";
  const config = { proxies: { default: { httpProxy: proxy, httpsProxy: proxy } }, auths: {} };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

test("docker commands never see the user's client config, HOME or other DOCKER_* values", () => {
  const userConfig = syntheticDockerConfig();
  try {
    const r = launch(OK, {
      build: true,
      env: {
        DOCKER_CONFIG: userConfig,
        DOCKER_CERT_PATH: userConfig,
        DOCKER_TLS_VERIFY: "1",
      },
    });
    expect(r.status).toBe(0);
    const calls = dockerCalls(r.log);
    expect(calls.map((call) => call.command.split(" ")[0])).toEqual([
      "context", // the only call that reads the user's config: the context selection
      "info",
      "image",
      "build",
      "run", // the same-host probe
      "run", // the job
      "ps", // cleanup: found, removed, gone
      "rm",
      "ps",
    ]);
    expect(calls[0].config).toBe(userConfig);
    const privateDirs = new Set(calls.slice(1).map((call) => call.config));
    expect(privateDirs.size).toBe(1);
    const [privateDir] = privateDirs;
    for (const call of calls.slice(1))
      expect({ ...call, command: "" }).toEqual({
        command: "",
        env: "DOCKER_CONFIG DOCKER_HOST PATH",
        host: "unix:///var/run/docker.sock",
        config: privateDir,
        files: "",
        marker: "0 0",
      });
    expect(privateDir.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(privateDir)).toBe(false); // removed when the launcher exited
    expect(r.stderr).not.toContain("MARKER");
  } finally {
    fs.rmSync(userConfig, { recursive: true, force: true });
  }
});

test("the selected context is resolved once; a remote one is refused, not swapped for the default", () => {
  const other = dockerCalls(launch(OK, { env: { DOCKER_CONTEXT: "other" } }).log);
  expect(other.slice(1).map((call) => [call.host, call.env])).toEqual(
    other.slice(1).map(() => ["unix:///run/other.sock", "DOCKER_CONFIG DOCKER_HOST PATH"])
  );
  for (const env of [
    { DOCKER_CONTEXT: "remote" } as Record<string, string>,
    { DOCKER_HOST: "tcp://10.0.0.1:2376" },
    { DOCKER_HOST: "ssh://user@host" },
    { DOCKER_HOST: "unix://run/relative.sock" },
  ]) {
    const refused = launch(OK, { env });
    expect([refused.status, dockerCalls(refused.log).map((c) => c.command.split(" ")[0])]).toEqual([
      2,
      ["context"],
    ]);
    expect(refused.stderr).toContain("not a local socket");
  }
});
