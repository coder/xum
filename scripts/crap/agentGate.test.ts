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
  const reported = runGate(gate, "post", "git commit -am 'grow route'");
  expect(reported.status).toBe(0);
  expect(reported.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");
}, 60_000);

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
