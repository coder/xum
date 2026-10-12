// Tests scripts/crap/agent-gate.sh (the .xum/tool_pre and tool_post CRAP gate)
// in throwaway git repos, in both modes. Like check.test.ts it needs uv, so
// `make test-crap-scripts` runs it and Test / Unit skips it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TOOL_PRE = join(import.meta.dir, "../../.xum/tool_pre");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const SHIPPED_MODE = "CRAP_GATE_MODE=warn\n";

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

  expect(runGate(gate, "pre", "git commit -am 'grow' -m 'Crap-Debt: hotfix'").status).toBe(0);
  // The post phase belongs to warn mode.
  expect(runGate(gate, "post", "git commit -am 'grow route'")).toEqual({ status: 0, out: "" });
});

test("warn mode lets the commit run and reports after it", () => {
  const gate = gateIn("warn");

  expect(runGate(gate, "pre", "git commit -am 'grow route'")).toEqual({ status: 0, out: "" });
  const reported = runGate(gate, "post", "git commit -am 'grow route'");
  expect(reported.status).toBe(0);
  expect(reported.out).toContain("VIOLATION floor-cc     src/route.ts:1-5 route: CC 2 -> 5");
});

test("other commands skip the check, and a broken gate never blocks", () => {
  const gate = gateIn("block");
  expect(runGate(gate, "pre", "git log --oneline")).toEqual({ status: 0, out: "" });

  git("update-ref", "-d", "refs/remotes/origin/main");
  const noBase = runGate(gate, "pre", "git push");
  expect(noBase.status).toBe(0);
  expect(noBase.out).toContain("crap-gate: skipped (no merge-base with origin/main)");

  git("update-ref", "refs/remotes/origin/main", "HEAD");
  // git and coreutils, but no uv: the scorer fails to start (exit 2).
  const noUv = { ...GIT_ENV, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  expect(Bun.which("uv", { PATH: noUv.PATH })).toBeNull();
  const broken = runGate(gate, "pre", "git commit -am x", noUv);
  expect(broken.status).toBe(0);
  expect(broken.out).toContain("crap-gate: skipped (tool error");
});

test("non-commit calls and the shipped warn-mode tool_pre start no process", () => {
  // tool_pre runs before every tool call. A PATH with only bash makes any
  // git, bun, uv (or grep, cat, dirname) call fail loudly.
  const onlyBash = join(dir, "only-bash");
  mkdirSync(onlyBash);
  symlinkSync(Bun.which("bash") ?? "/bin/bash", join(onlyBash, "bash"));
  const env = { PATH: onlyBash };
  const shippedGate = join(import.meta.dir, "agent-gate.sh");
  for (const [hook, phase, tool, script] of [
    [shippedGate, "post", "bash", "ls -la && make test"],
    [shippedGate, "post", "file_read", "git commit -am x"],
    [TOOL_PRE, "", "bash", "git commit -am x"],
    [TOOL_PRE, "", "file_edit_insert", ""],
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
