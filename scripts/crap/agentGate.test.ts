// Tests scripts/crap/agent-gate.sh (the CRAP gate behind .xum/tool_pre and
// .xum/tool_post) and those hooks in throwaway git repos, in both modes. Like check.test.ts it needs uv, so
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
  // Prefixes and git's global options before the subcommand.
  for (const commit of [
    "GIT_EDITOR=true env git commit -am x",
    "env -u GIT_DIR git commit -am x",
    "env -i PATH=$PATH GIT_AUTHOR_NAME='a b' git commit -am x",
    "git -c core.editor=true --no-pager commit -am x",
    "git -c user.name=a\\ b commit -am x",
    'git -c user.name="a\\"b" commit -am x',
    "git \\\n  commit -am x",
    "git status; git commit -am x",
  ]) {
    expect({ commit, status: runGate(gate, "pre", commit).status }).toEqual({ commit, status: 1 });
  }
  // A message that mentions cd or -C does not hide the commit from the gate.
  expect(runGate(gate, "pre", "git commit -am 'document cd usage'").status).toBe(1);
  expect(runGate(gate, "pre", "git commit -am 'fix git -C handling'").status).toBe(1);

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
  const reported = runGate(gate, "post", "git commit -am 'grow route'");
  expect(reported.status).toBe(0);
  expect(reported.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");

  // A failed command (nothing to commit, a rejected push) gets no report.
  const failed = runGate(gate, "post", "git commit -am 'grow route'", {
    ...GIT_ENV,
    XUM_TOOL_RESULT_SUCCESS: "false",
  });
  expect(failed).toEqual({ status: 0, out: "" });
}, 60_000);

test("other commands skip the check, and a broken gate never blocks", () => {
  const gate = gateIn("block");
  for (const readOnly of [
    "git log --oneline",
    'echo "do not run git commit yet"',
    // Read-only commands that mention a write subcommand.
    "git log --grep commit",
    "git show HEAD -- push",
    "git diff commit",
    "git commit-tree HEAD^{tree}",
  ]) {
    expect({ readOnly, ...runGate(gate, "pre", readOnly) }).toEqual({
      readOnly,
      status: 0,
      out: "",
    });
  }
  for (const elsewhere of [
    "cd ../other && git commit -am x",
    "git -C ../other commit -am x",
    "git -c color.ui=false -C ../other commit -am x",
    'git -C "other dir" commit -am x',
    "git --git-dir=../other/.git commit -am x",
    "env -C ../other git commit -am x",
    "env -C../other git commit -am x",
    "env --chdir=../other git commit -am x",
    "GIT_DIR=../other/.git git push",
    "git commit -am x && git -C ../other push",
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

/**
 * A project with the shipped .xum hooks and a copy of scripts/crap in the
 * given mode, so `${0%/*}/../scripts/crap/agent-gate.sh` resolves in the copy.
 */
function projectIn(mode: "warn" | "block"): string {
  const project = join(dir, `project-${mode}`);
  mkdirSync(join(project, ".xum"), { recursive: true });
  // Switching to block renames tool_pre.block to tool_pre (see its header).
  for (const [from, to] of [
    ["tool_pre.block", "tool_pre"],
    ["tool_post", "tool_post"],
    ["hook_chain.sh", "hook_chain.sh"],
  ]) {
    cpSync(join(REPO, ".xum", from), join(project, ".xum", to));
  }
  const gate = gateIn(mode);
  cpSync(dirname(gate), join(project, "scripts/crap"), { recursive: true });
  return project;
}

/** The user's Xum home with one hook that prints its name and input, then exits `status`. */
function userHook(home: string, name: "tool_pre" | "tool_post", status: number): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, name),
    `#!/usr/bin/env bash\necho "user ${name}: $XUM_TOOL_INPUT_SCRIPT"\nexit ${status}\n`,
    { mode: 0o755 }
  );
}

function runHook(hook: string, script: string, extraEnv: NodeJS.ProcessEnv = {}) {
  // The user's Xum home is dir/home/.xum, through XUM_ROOT. The scorer keeps
  // the real HOME: uv's cache lives there, and a fresh one makes the scorer
  // time out on CI.
  const env: NodeJS.ProcessEnv = { ...GIT_ENV };
  delete env.MUX_ROOT;
  delete env.NODE_ENV;
  const result = spawnSync(hook, [], {
    cwd: repo,
    env: {
      ...env,
      XUM_ROOT: join(dir, "home/.xum"),
      XUM_TOOL: "bash",
      XUM_TOOL_INPUT_SCRIPT: script,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

test("warn mode ships no project tool_pre that would replace the user's own hooks", () => {
  // Any project tool_pre switches Xum to the tool_pre/tool_post model, which
  // skips a user's legacy ~/.xum/tool_hook.
  const mode = /^CRAP_GATE_MODE=(\w+)$/m.exec(
    readFileSync(join(import.meta.dir, "agent-gate.sh"), "utf8")
  )?.[1];
  expect(mode).toBe("warn");
  expect(existsSync(join(REPO, ".xum/tool_pre"))).toBe(false);
  expect(existsSync(join(REPO, ".xum/tool_pre.block"))).toBe(true);
});

test("the project hooks run the user's own hooks and pass their exit codes through", () => {
  // Xum runs the project's .xum/tool_pre instead of ~/.xum/tool_pre, so the
  // shipped hooks must run the user's. Warn mode: no gate before the commit.
  // These two calls run no scorer, so they can move HOME to test the default
  // ~/.xum (an empty XUM_ROOT counts as unset).
  const pre = join(projectIn("warn"), ".xum/tool_pre");
  const home = { HOME: join(dir, "home"), XUM_ROOT: "" };
  expect(runHook(pre, "git commit -am x", home)).toEqual({ status: 0, out: "" });
  userHook(join(dir, "home/.xum"), "tool_pre", 3);
  expect(runHook(pre, "git commit -am x", home)).toEqual({
    status: 3,
    out: "user tool_pre: git commit -am x\n",
  });

  // An SSH workspace's home is ~/.mux, even next to a ~/.xum.
  userHook(join(dir, "home/.mux"), "tool_pre", 7);
  expect(runHook(pre, "ls", { ...home, XUM_RUNTIME: "ssh" }).status).toBe(7);

  // Leftover homes, as Xum's getXumHome() picks them: a leftover ~/.mux, and
  // the home an empty ~/.xum's .legacy-fallback marker names.
  const legacy = join(dir, "legacy");
  userHook(join(legacy, ".mux"), "tool_pre", 5);
  expect(runHook(pre, "ls", { HOME: legacy, XUM_ROOT: "" }).status).toBe(5);
  // A devcontainer takes ~/.xum as is, with no leftover-home fallback.
  expect(runHook(pre, "ls", { HOME: legacy, XUM_ROOT: "", XUM_RUNTIME: "devcontainer" })).toEqual({
    status: 0,
    out: "",
  });
  const marked = join(dir, "marked");
  mkdirSync(join(marked, ".xum"), { recursive: true });
  writeFileSync(join(marked, ".xum.legacy-fallback"), ".cmux\n");
  userHook(join(marked, ".cmux"), "tool_pre", 6);
  expect(runHook(pre, "ls", { HOME: marked, XUM_ROOT: "" }).status).toBe(6);
  // Xum ignores a symlinked marker, so the hook does too.
  rmSync(join(marked, ".xum.legacy-fallback"));
  writeFileSync(join(dir, "marker"), ".cmux\n");
  symlinkSync(join(dir, "marker"), join(marked, ".xum.legacy-fallback"));
  expect(runHook(pre, "ls", { HOME: marked, XUM_ROOT: "" })).toEqual({ status: 0, out: "" });

  // XUM_ROOT moves the user's home, and a home that is the project's own .xum
  // does not run the project hook again.
  userHook(join(dir, "root"), "tool_pre", 4);
  expect(runHook(pre, "ls", { XUM_ROOT: join(dir, "root") }).status).toBe(4);
  expect(runHook(pre, "ls", { XUM_ROOT: join(REPO, ".xum") })).toEqual({ status: 0, out: "" });

  // tool_post: the user's hook runs after the project's report, also after a
  // file tool, whose formatting step returns early without a file path.
  const post = join(dirname(pre), "tool_post");
  userHook(join(dir, "home/.xum"), "tool_post", 2);
  const reported = runHook(post, "git commit -am x");
  expect(reported.status).toBe(2);
  expect(reported.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");
  expect(reported.out).toEndWith("user tool_post: git commit -am x\n");
  expect(runHook(post, "", { XUM_TOOL: "file_edit_replace_string" })).toEqual({
    status: 2,
    out: "user tool_post: \n",
  });
}, 60_000);

test("block mode's tool_pre blocks a regression first, and a user block still blocks", () => {
  const pre = join(projectIn("block"), ".xum/tool_pre");
  userHook(join(dir, "home/.xum"), "tool_pre", 3);

  const blocked = runHook(pre, "git commit -am x");
  expect(blocked.status).toBe(1);
  expect(blocked.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");
  expect(blocked.out).not.toContain("user tool_pre");

  // The gate passes; the user's hook decides.
  expect(runHook(pre, "git commit -am x -m 'Crap-Debt: follow-up'")).toEqual({
    status: 3,
    out: "user tool_pre: git commit -am x -m 'Crap-Debt: follow-up'\n",
  });
  expect(runHook(pre, "ls").status).toBe(3);
}, 60_000);

test("block mode's tool_pre fails open when the gate hangs or breaks", () => {
  const pre = join(projectIn("block"), ".xum/tool_pre");
  userHook(join(dir, "home/.xum"), "tool_pre", 0);
  // A bun that ignores SIGTERM and outlives Xum's 10 s limit.
  const stuck = join(dir, "stuck");
  mkdirSync(stuck);
  writeFileSync(join(stuck, "bun"), "#!/usr/bin/env bash\ntrap '' TERM\nsleep 12\n", {
    mode: 0o755,
  });
  const started = Date.now();
  const hung = runHook(pre, "git commit -am x", { PATH: `${stuck}:${process.env.PATH}` });
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(hung).toEqual({ status: 0, out: "user tool_pre: git commit -am x\n" });

  // A gate that crashes with exit 1 (not its own verdict) does not block.
  const gate = join(dirname(pre), "../scripts/crap/agent-gate.sh");
  writeFileSync(
    gate,
    readFileSync(gate, "utf8").replace("set -uo pipefail\n", "set -uo pipefail\nexit 1\n")
  );
  expect(runHook(pre, "git commit -am x")).toEqual({
    status: 0,
    out: "user tool_pre: git commit -am x\n",
  });
}, 20_000);

test("non-commit calls start no process", () => {
  // The hooks run around every tool call. A PATH with only bash makes any
  // git, bun, uv (or grep, cat, dirname) call fail loudly.
  const onlyBash = join(dir, "only-bash");
  mkdirSync(onlyBash);
  symlinkSync(Bun.which("bash") ?? "/bin/bash", join(onlyBash, "bash"));
  const env = { PATH: onlyBash };
  const shippedGate = join(import.meta.dir, "agent-gate.sh");
  const blockPre = join(projectIn("block"), ".xum/tool_pre");
  for (const [hook, phase, tool, script] of [
    [shippedGate, "post", "bash", "ls -la && make test"],
    [shippedGate, "post", "file_read", "git commit -am x"],
    [shippedGate, "pre", "bash", "git commit -am x"],
    [join(REPO, ".xum/tool_post"), "", "file_read", ""],
    [join(projectIn("warn"), ".xum/tool_pre"), "", "bash", "git commit -am x"],
    [blockPre, "", "file_read", "git commit -am x"],
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
