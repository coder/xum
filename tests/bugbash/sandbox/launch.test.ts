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
    if [ -n "$DOCKER_HOST" ]; then echo "$DOCKER_HOST"
    elif [ "$DOCKER_CONTEXT" = remote ]; then echo tcp://10.0.0.1:2376
    elif [ "$DOCKER_CONTEXT" = other ]; then echo unix:///run/other.sock
    else echo unix:///var/run/docker.sock; fi ;;
  info) echo '{"OSType":"linux","OperatingSystem":"Ubuntu","SecurityOptions":[]}' ;;
  image) [ "$FAKE_IMAGE" = present ] ;;
  build) cat > /dev/null ;;
  run)
    src=$(printf '%s\n' "$@" | sed -n 's/^type=bind,src=\([^,]*\),dst=\/probe,readonly$/\1/p')
    if [ -z "$src" ]; then printf '{"end":true}\n'; exit 0; fi
    [ "$FAKE_PROBE" = fail ] && exit 1
    cat /proc/sys/kernel/random/boot_id; cat "$src/.nonce"; echo ;;
  ps) [ -e "$FAKE_LOG.rm" ] || echo cid123 ;;
  rm) touch "$FAKE_LOG.rm" ;;
  *) exit 1 ;;
esac
`;

interface Launch {
  sandbox?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  /** The fake's same-host probe fails (default), so a sandbox job falls back to the host. */
  probeFails?: boolean;
  /** The image is missing, so the launcher builds it. */
  build?: boolean;
}

/**
 * Runs the launcher with a fake docker and a fake e2e node, which log each call. `sandbox`
 * (default true): the mock app AI, so the launcher picks the sandbox. Else the real app AI sends
 * the job to the host fallback.
 */
function launch(args: string[], options: Launch = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-launch-test-"));
  const calls = path.join(bin, "calls.log");
  const script = FAKE_DOCKER.replaceAll("$FAKE_LOG", calls)
    .replaceAll("$FAKE_PROBE", options.probeFails === false ? "ok" : "fail")
    .replaceAll("$FAKE_IMAGE", options.build === true ? "missing" : "present");
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh${script}`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "e2e-node"), `#!/bin/sh\necho "CALL e2e-node $*" >> ${calls}\n`, {
    mode: 0o755,
  });
  try {
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dir, "launch.ts"), "--", ...args],
      {
        cwd: options.cwd ?? BUGBASH_DIR,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME,
          E2E_NODE: path.join(bin, "e2e-node"),
          BUGBASH_AI_RESOLVED: options.sandbox === false ? "real" : "mock",
          ...options.env,
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
  const sandboxed = launch(OK);
  expect(sandboxed.log).toContain("CALL run");
  const hosted = launch(OK, { sandbox: false });
  expect(hosted.log).toContain(
    `CALL e2e-node ${path.resolve(BUGBASH_DIR, "../..")}/node_modules/.bin/e2e run`
  );
  for (const sandbox of [true, false])
    for (const args of NOT_EXACT) {
      const r = launch(args, { sandbox });
      expect({ args, status: r.status, ran: r.log.match(/CALL (run|build|e2e-node)/g) }).toEqual({
        args,
        status: 2,
        ran: null,
      });
      expect(r.stderr).toContain("exact-step repros");
    }
  // The same args from another cwd would load another e2e.config.ts.
  const elsewhere = launch(OK, { sandbox: false, cwd: path.resolve(BUGBASH_DIR, "../..") });
  expect([elsewhere.status, elsewhere.log.includes("CALL e2e-node")]).toEqual([2, false]);
});

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
    .filter((call) => !call.command.startsWith("e2e-node"));
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
      probeFails: false,
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
    const required = launch(OK, { env: { ...env, BUGBASH_SANDBOX: "require" } });
    expect([
      required.status,
      dockerCalls(required.log).map((c) => c.command.split(" ")[0]),
    ]).toEqual([2, ["context"]]);
    expect(required.stderr).toContain("not a local socket");
    // auto: the exact-step run goes to the host, with no further docker command.
    const auto = launch(OK, { env });
    expect(dockerCalls(auto.log).length).toBe(1);
    expect(auto.log).toContain("CALL e2e-node");
  }
});
