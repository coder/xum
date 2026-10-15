// Tests scripts/crap/agent-gate.sh (the CRAP gate behind .xum/tool_post)
// in throwaway git repos, in both modes. Like check.test.ts it needs uv, so
// `make test-crap-scripts` runs it and Test / Unit skips it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const SHIPPED_MODE = "CRAP_GATE_MODE=warn\n";

// Tests that run the real scorer get a 60 s budget: each run takes about a
// second, more on a loaded runner, and bun's default is 5 s per test.
let dir: string;
let repo: string;

function git(...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: GIT_ENV,
  });
  expect(result.status).toBe(0);
}

/** A copy of scripts/crap with the mode constant set, so tests never edit the real one. */
function gateIn(mode: "warn" | "block"): string {
  const copy = join(dir, `crap-${mode}`);
  cpSync(import.meta.dir, copy, { recursive: true });
  const gate = join(copy, "agent-gate.sh");
  const source = readFileSync(gate, "utf8");
  expect(source).toContain(SHIPPED_MODE);
  writeFileSync(gate, source.replace(SHIPPED_MODE, `CRAP_GATE_MODE=${mode}\n`), { mode: 0o755 });
  return gate;
}

function runGate(
  gate: string,
  phase: "pre" | "post",
  script: string,
  env: NodeJS.ProcessEnv = GIT_ENV
) {
  const result = spawnSync(gate, [phase], {
    cwd: repo,
    env: { ...env, XUM_TOOL: "bash", XUM_TOOL_INPUT_SCRIPT: script },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

const ROUTE = `export function route(a: number) {
  if (a > 1) return 1;
  return 0;
}
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crap-gate-test-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/route.ts"), ROUTE);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  // The regression under test: three nested ifs in an existing function.
  writeFileSync(
    join(repo, "src/route.ts"),
    ROUTE.replace("  return 0;", "  if (a) { if (a < 0) { if (a < -1) return 2; } }\n  return 0;")
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("block mode stops a regressing commit before it runs, unless it carries Crap-Debt", () => {
  const gate = gateIn("block");

  const blocked = runGate(gate, "pre", "git commit -am 'grow route'");
  expect(blocked.status).toBe(1);
  expect(blocked.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");

  // A reason with the letter n (a past parser stopped there and lost the reason).
  expect(runGate(gate, "pre", "git commit -am 'grow' -m 'Crap-Debt: needs follow-up'").status).toBe(
    0
  );
  expect(runGate(gate, "pre", "GIT_EDITOR=true env git commit -am x").status).toBe(1);
  // A message that mentions cd does not hide the commit from the gate.
  expect(runGate(gate, "pre", "git commit -am 'document cd usage'").status).toBe(1);

  // Over 8 KB, Xum drops XUM_TOOL_INPUT_SCRIPT and the gate reads the JSON input file.
  const input = join(dir, "input.json");
  writeFileSync(input, JSON.stringify({ script: `${"# pad\n".repeat(2000)}git commit -am x` }));
  const big = runGate(gate, "pre", "", { ...GIT_ENV, XUM_TOOL_INPUT_PATH: input });
  expect(big.status).toBe(1);

  // After a commit that carries Crap-Debt, block mode's post phase shows the
  // downgraded findings: the passing pre phase could not.
  git("commit", "-q", "-am", "grow", "-m", "Crap-Debt: needs follow-up");
  const after = runGate(gate, "post", "git commit -am grow -m 'Crap-Debt: needs follow-up'");
  expect(after.status).toBe(0);
  expect(after.out).toContain("warning   floor-cc     src/route.ts:1-5 route: CC 2 -> 5");
}, 60_000);

test("warn mode lets the commit run and reports after it", () => {
  const gate = gateIn("warn");

  expect(runGate(gate, "pre", "git commit -am 'grow route'")).toEqual({ status: 0, out: "" });
  const succeeded = { ...GIT_ENV, XUM_TOOL_RESULT_SUCCESS: "true" };
  const reported = runGate(gate, "post", "git commit -am 'grow route'", succeeded);
  expect(reported.status).toBe(0);
  expect(reported.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");
}, 60_000);

test("warn mode reports nothing for read-only git commands or a failed command", () => {
  const gate = gateIn("warn");
  // The scorer would report the regression above for any matched command.
  for (const script of ["git log --grep commit", "git log --oneline --grep=push -- src"]) {
    expect(runGate(gate, "post", script)).toEqual({ status: 0, out: "" });
  }
  // A nonzero exit anywhere in the chain: the commit may not have happened.
  const failed = { ...GIT_ENV, XUM_TOOL_RESULT_SUCCESS: "false" };
  expect(runGate(gate, "post", "git commit -am x", failed)).toEqual({ status: 0, out: "" });
  expect(runGate(gate, "post", "git commit -am x && make test", failed)).toEqual({
    status: 0,
    out: "",
  });
});

test("other commands skip the check, and a broken gate never blocks", () => {
  const gate = gateIn("block");
  expect(runGate(gate, "pre", "git log --oneline")).toEqual({ status: 0, out: "" });
  expect(runGate(gate, "pre", 'echo "do not run git commit yet"')).toEqual({ status: 0, out: "" });
  for (const elsewhere of [
    "cd ../other && git commit -am x",
    "git -C ../other commit -am x",
    "git -c color.ui=false -C ../other commit -am x",
  ]) {
    const skipped = runGate(gate, "pre", elsewhere);
    expect(skipped.status).toBe(0);
    expect(skipped.out).toContain("may target another checkout");
  }

  git("update-ref", "-d", "refs/remotes/origin/main");
  const noBase = runGate(gate, "pre", "git push");
  expect(noBase.status).toBe(0);
  expect(noBase.out).toContain("crap-gate: skipped (no merge-base with origin/main)");

  // origin/main at a clean HEAD, as after `git commit && git push origin main`.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("stash", "-q");
  const pushed = runGate(gate, "pre", "git push origin main");
  expect(pushed.status).toBe(0);
  expect(pushed.out).toContain("origin/main already contains HEAD");

  git("stash", "pop", "-q");
  // git and coreutils, but no uv: the scorer fails to start (exit 2).
  const noUv = { ...GIT_ENV, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  expect(Bun.which("uv", { PATH: noUv.PATH })).toBeNull();
  const broken = runGate(gate, "pre", "git commit -am x", noUv);
  expect(broken.status).toBe(0);
  expect(broken.out).toContain("crap-gate: skipped (tool error");

  // git and bun but no timeout (stock macOS).
  const noTimeout = join(dir, "no-timeout");
  mkdirSync(noTimeout);
  for (const tool of ["bash", "git", "bun", "dirname", "grep", "sed"]) {
    symlinkSync(Bun.which(tool) ?? `/usr/bin/${tool}`, join(noTimeout, tool));
  }
  const unbounded = runGate(gate, "pre", "git commit -am x", { ...GIT_ENV, PATH: noTimeout });
  expect(unbounded).toEqual({
    status: 0,
    out: "crap-gate: skipped (no timeout or gtimeout command). The gate never blocks on its own failure.\n",
  });
}, 60_000);

test("a scorer that ignores SIGTERM is killed before Xum's hook limit", () => {
  const gate = gateIn("block");
  // A bun that traps TERM and hangs, in front of the real tools.
  const stuck = join(dir, "stuck");
  mkdirSync(stuck);
  writeFileSync(join(stuck, "bun"), "#!/usr/bin/env bash\ntrap '' TERM\nsleep 12\n", {
    mode: 0o755,
  });
  const started = Date.now();
  const result = runGate(gate, "pre", "git commit -am x", {
    ...GIT_ENV,
    PATH: `${stuck}:${process.env.PATH}`,
  });
  expect(result).toEqual({
    status: 0,
    out: "crap-gate: skipped (timed out after 8s). The gate never blocks on its own failure.\n",
  });
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

test("warn mode ships no project tool_pre that would replace the user's own", () => {
  // Xum runs the project's .xum/tool_pre instead of ~/.xum/tool_pre.
  const mode = /^CRAP_GATE_MODE=(\w+)$/m.exec(
    readFileSync(join(import.meta.dir, "agent-gate.sh"), "utf8")
  )?.[1];
  expect(mode).toBe("warn");
  expect(existsSync(join(REPO, ".xum/tool_pre"))).toBe(false);
});

test("non-commit calls start no process", () => {
  // The hooks run around every tool call. A PATH with only bash makes any
  // git, bun, uv (or grep, cat, dirname) call fail loudly.
  const onlyBash = join(dir, "only-bash");
  mkdirSync(onlyBash);
  symlinkSync(Bun.which("bash") ?? "/bin/bash", join(onlyBash, "bash"));
  const env = { PATH: onlyBash };
  const shippedGate = join(import.meta.dir, "agent-gate.sh");
  for (const [hook, phase, tool, script] of [
    [shippedGate, "post", "bash", "ls -la && make test"],
    [shippedGate, "post", "file_read", "git commit -am x"],
    [shippedGate, "pre", "bash", "git commit -am x"],
    [join(REPO, ".xum/tool_post"), "", "file_read", ""],
  ]) {
    const result = spawnSync(hook, phase ? [phase] : [], {
      cwd: repo,
      env: { ...env, XUM_TOOL: tool, XUM_TOOL_INPUT_SCRIPT: script },
      encoding: "utf8",
    });
    expect({ hook, tool, status: result.status, out: result.stdout + result.stderr }).toEqual({
      hook,
      tool,
      status: 0,
      out: "",
    });
  }
});

/**
 * A project with the shipped .xum/tool_post and a copy of scripts/crap, so
 * `${0%/*}/../scripts/crap/agent-gate.sh` resolves in the copy.
 */
function projectToolPost(): string {
  const project = join(dir, "project");
  mkdirSync(join(project, ".xum"), { recursive: true });
  cpSync(join(REPO, ".xum/tool_post"), join(project, ".xum/tool_post"));
  cpSync(dirname(gateIn("warn")), join(project, "scripts/crap"), { recursive: true });
  return join(project, ".xum/tool_post");
}

/** A user tool_post in `home` that prints its args, stdin and input, then exits `status`. */
function userToolPost(home: string, status: number, mode = 0o755): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "tool_post"),
    `#!/usr/bin/env bash\necho "user tool_post [$*] [$(cat)] [$XUM_TOOL_INPUT_SCRIPT]"\nexit ${status}\n`,
    { mode }
  );
}

function runToolPost(
  hook: string,
  env: NodeJS.ProcessEnv,
  opts: { script?: string; args?: string[]; input?: string } = {}
) {
  const base: NodeJS.ProcessEnv = { ...GIT_ENV };
  for (const key of ["HOME", "XUM_ROOT", "MUX_ROOT", "NODE_ENV", "XUM_RUNTIME"]) delete base[key];
  const result = spawnSync(hook, opts.args ?? [], {
    cwd: repo,
    env: { ...base, XUM_TOOL: "file_read", XUM_TOOL_INPUT_SCRIPT: opts.script ?? "", ...env },
    input: opts.input ?? "",
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

test("the project tool_post runs the user's tool_post once, last, and passes its exit through", () => {
  const post = projectToolPost();
  const home = join(dir, "home");
  userToolPost(join(home, ".xum"), 3);
  userToolPost(join(home, ".xum-dev"), 4);
  userToolPost(join(dir, "root"), 5);
  userToolPost(join(dir, "mux-root"), 6);

  // Default home: ~/.xum, with Xum's args and stdin.
  expect(runToolPost(post, { HOME: home }, { args: ["a b"], input: "result" })).toEqual({
    status: 3,
    out: "user tool_post [a b] [result] []\n",
  });
  // The same paths as Xum's getXumHome(): -dev suffix, XUM_ROOT, then MUX_ROOT.
  expect(runToolPost(post, { HOME: home, NODE_ENV: "development" }).status).toBe(4);
  expect(runToolPost(post, { HOME: home, XUM_ROOT: join(dir, "root") }).status).toBe(5);
  expect(runToolPost(post, { HOME: home, MUX_ROOT: join(dir, "mux-root") }).status).toBe(6);
  expect(runToolPost(post, { HOME: home, XUM_ROOT: "", MUX_ROOT: join(dir, "root") }).status).toBe(
    3
  );
  expect(runToolPost(post, { HOME: home, XUM_RUNTIME: "worktree" }).status).toBe(3);

  // A real commit: the CRAP report comes first, then the user's hook.
  const reported = runToolPost(
    post,
    { XUM_ROOT: join(dir, "root"), XUM_TOOL: "bash" },
    { script: "git commit -am x" }
  );
  expect(reported.status).toBe(5);
  expect(reported.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");
  expect(reported.out).toEndWith("user tool_post [] [] [git commit -am x]\n");
}, 60_000);

test("the project tool_post skips the user's tool_post when the lookup is unusual", () => {
  const post = projectToolPost();
  const home = join(dir, "home");
  userToolPost(join(home, ".xum"), 3);
  userToolPost(join(repo, "relative-root"), 4);
  userToolPost(join(dir, "plain"), 5, 0o644);
  mkdirSync(join(dir, "linked"));
  symlinkSync(post, join(dir, "linked/tool_post"));
  userToolPost(join(dir, "slash/.xum"), 6);

  for (const env of [
    { HOME: home, XUM_ROOT: "relative-root" },
    { HOME: home, XUM_ROOT: "C:\\Users\\me\\.xum" },
    {},
    { HOME: "/" },
    { HOME: home, XUM_RUNTIME: "ssh" },
    { HOME: home, XUM_RUNTIME: "docker" },
    { HOME: home, XUM_RUNTIME: "devcontainer" },
    { HOME: home, XUM_ROOT: join(dir, "plain") },
    { HOME: home, XUM_ROOT: join(dir, "linked") },
    { HOME: home, XUM_ROOT: dirname(post) },
  ]) {
    expect({ env, ...runToolPost(post, env) }).toEqual({ env, status: 0, out: "" });
  }
});

test("a user tool_post that calls the project tool_post again does not loop", () => {
  const post = projectToolPost();
  const root = join(dir, "root");
  mkdirSync(root);
  writeFileSync(join(root, "tool_post"), `#!/usr/bin/env bash\necho user\n"${post}"\nexit 7\n`, {
    mode: 0o755,
  });
  expect(runToolPost(post, { XUM_ROOT: root })).toEqual({ status: 7, out: "user\n" });
});
