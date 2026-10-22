// End-to-end tests of `scripts/mutate/check.ts` in throwaway git repos, with
// real `bun test` processes. They need uv (the runner goes through `uv run`),
// which the Test / Unit runners do not install, so `make test-mutate-scripts`
// (static-check-full) runs this file and scripts/test-unit-ci.sh skips it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MutateReport } from "./check";

const CHECK = join(import.meta.dir, "check.ts");
// Hermetic git: CI has no identity, and host config (hooks, signing) must not leak in.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let repo: string;

function git(...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: GIT_ENV,
  });
  expect(result.status).toBe(0);
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function check(): { status: number | null; report: MutateReport | null } {
  const result = spawnSync(process.execPath, [CHECK, "--base", "HEAD", "--json"], {
    cwd: repo,
    env: GIT_ENV,
    encoding: "utf8",
  });
  return { status: result.status, report: result.status === 2 ? null : JSON.parse(result.stdout) };
}

function outcomes(report: MutateReport | null): string[] {
  return (report?.mutants ?? []).map((m) => `${m.original}>${m.mutant}:${m.outcome}`).sort();
}

// Each test starts real bun processes (baseline plus mutants), so allow more
// than bun's 5 s default on a loaded host.
const SLOW = 60_000;

const AGE = "export const isAdult = (age: number) => age >= 18;\n";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mutate-check-test-"));
  git("init", "-q", "-b", "main");
  // The real script lists the Bun unit lane; this one lists the fixture's tests,
  // all with coverage.
  write(
    "scripts/test-unit-ci.sh",
    "[ \"$1\" = --list-no-coverage ] && exit 0\ngit ls-files -- '*.test.ts' | sed 's#^#./#'\n"
  );
  write("src/age.ts", AGE);
  write(
    "src/age.test.ts",
    'import { expect, test } from "bun:test";\nimport { isAdult } from "./age";\ntest("adult", () => expect(isAdult(30)).toBe(true));\n'
  );
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test(
  "a mutant at an untested boundary survives",
  () => {
    write("src/age.ts", AGE.replace("age >= 18", "age >= 18 /* touched */"));

    const { status, report } = check();

    expect(status).toBe(1);
    expect(outcomes(report)).toEqual([">=>>:survived"]);
    expect(report?.tests["src/age.ts"]).toEqual(["src/age.test.ts"]);
  },
  SLOW
);

test(
  "a test at the boundary kills it, also through an @/ import",
  () => {
    write("src/age.ts", AGE.replace("age >= 18", "age >= 18 /* touched */"));
    write(
      "src/edge.test.ts",
      'import { expect, test } from "bun:test";\nimport { isAdult } from "@/age";\ntest("18", () => expect(isAdult(18)).toBe(true));\n'
    );
    write("tsconfig.json", '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n');
    git("add", ".");
    git("commit", "-q", "-m", "edge test");
    write("src/age.ts", AGE.replace("age >= 18", "age >= 18 /* again */"));

    const { status, report } = check();

    expect(status).toBe(0);
    expect(outcomes(report)).toEqual([">=>>:killed"]);
    expect(report?.tests["src/age.ts"]).toEqual(["src/age.test.ts", "src/edge.test.ts"]);
  },
  SLOW
);

test(
  "a test that fails without a mutant is a baseline failure, not a pass",
  () => {
    write("src/age.ts", AGE.replace("age >= 18", "age >= 18 /* touched */"));
    write(
      "src/age.test.ts",
      'import { expect, test } from "bun:test";\ntest("broken", () => expect(1).toBe(2));\nimport "./age";\n'
    );

    const { status, report } = check();

    expect(status).toBe(3);
    expect(report?.droppedTests.map((d) => d.path)).toEqual(["src/age.test.ts"]);
    expect(outcomes(report)).toEqual([">=>>:no-test"]);
  },
  SLOW
);

test(
  "a mutation-equivalent marker accepts a survivor",
  () => {
    write(
      "src/age.ts",
      AGE.replace("export", "// mutation-equivalent: no caller passes 18\nexport").replace(
        "age >= 18",
        "age >= 18 /* touched */"
      )
    );

    const { status, report } = check();

    expect(status).toBe(0);
    expect(outcomes(report)).toEqual([">=>>:equivalent"]);
    expect(report?.mutants[0].reason).toBe("no caller passes 18");
  },
  SLOW
);
