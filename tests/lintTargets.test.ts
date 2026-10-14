import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Selection = { mode: "full"; reason: string } | { mode: "files"; files: string[] };

// Local shape for the untyped CommonJS helper; only the members these tests exercise.
interface LintTargetsModule {
  selectLintTargets(changedFiles: string[], removedFiles?: string[]): Selection;
  main(cwd: string, env: Record<string, string | undefined>): string;
  oxlintArgs(cwd: string): string[];
  listLintFiles(cwd: string): string[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS script helper with no ESM entry
const lintTargets = require("../scripts/lib/lint_targets.js") as LintTargetsModule;

describe("lint target selection", () => {
  it("keeps only files the full lint covers, sorted and deduplicated", () => {
    expect(
      lintTargets.selectLintTargets([
        "tests/ui/b.test.tsx",
        "src/node/a.ts",
        "src/node/a.ts",
        "src/node/builtinSkills/skill/deep/x.js",
        "src/node/workflowRuntime/runtime.js",
        "src/node/workflowRuntime/nested/skip.js",
        "scripts/lib/helper.js",
        "scripts/other.ts",
        "docs/page.mdx",
        "src/browser/styles/globals.css",
      ])
    ).toEqual({
      mode: "files",
      files: [
        "scripts/lib/helper.js",
        "src/node/a.ts",
        "src/node/builtinSkills/skill/deep/x.js",
        "src/node/workflowRuntime/runtime.js",
        "tests/ui/b.test.tsx",
      ],
    });
  });

  it.each([
    "eslint.config.mjs",
    "eslint-local-rules.mjs",
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "tsconfig.main.json",
    "scripts/lint.sh",
    "scripts/lib/lint_targets.js",
  ])("lints everything when %s changes", (trigger) => {
    expect(lintTargets.selectLintTargets(["src/node/a.ts", trigger])).toEqual({
      mode: "full",
      reason: `${trigger} changed`,
    });
  });

  it("does not treat nested lookalikes as config changes", () => {
    expect(lintTargets.selectLintTargets(["vscode/package.json", "src/tsconfig.json"])).toEqual({
      mode: "files",
      files: [],
    });
  });

  it("lints everything when a config file is removed", () => {
    expect(lintTargets.selectLintTargets(["src/node/a.ts"], ["tsconfig.main.json"])).toEqual({
      mode: "full",
      reason: "tsconfig.main.json changed",
    });
  });
});

describe("lint target git discovery", () => {
  let repo: string;
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
  const write = (file: string, contents = "export {};\n") => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), contents);
  };
  const run = (env: Record<string, string | undefined> = {}) =>
    lintTargets
      .main(repo, { ...env })
      .trimEnd()
      .split("\n");

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-targets-"));
    git("init", "-q", "-b", "main");
    write("src/kept.ts");
    write("src/edited.ts");
    write("src/deleted.ts");
    write("src/renamed.ts", "export const renamed = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("switch", "-q", "-c", "feature");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("lists committed, uncommitted and untracked changes since the merge base with main", () => {
    write("src/committed.ts");
    git("add", ".");
    git("commit", "-q", "-m", "feature work");
    // A commit on main after the branch point is not this branch's change.
    git("switch", "-q", "main");
    write("src/mainOnly.ts");
    git("add", ".");
    git("commit", "-q", "-m", "main moves on");
    git("switch", "-q", "feature");
    write("src/edited.ts", "export const edited = 1;\n");
    fs.rmSync(path.join(repo, "src/deleted.ts"));
    git("mv", "src/renamed.ts", "src/moved.ts");
    write("tests/untracked.test.ts");

    const [header, ...files] = run();

    expect(header).toBe(`files ${git("merge-base", "HEAD", "main")}`);
    expect(files).toEqual([
      "src/committed.ts",
      "src/edited.ts",
      "src/moved.ts",
      "tests/untracked.test.ts",
    ]);
  });

  it("lints everything when the branch deletes or moves a config file", () => {
    write("tsconfig.json", "{}\n");
    write("eslint.config.mjs", "export default [];\n");
    git("add", ".");
    git("commit", "-q", "-m", "configs");
    const base = git("rev-parse", "HEAD");

    fs.rmSync(path.join(repo, "tsconfig.json"));
    expect(run({ XUM_LINT_BASE: base })).toEqual(["full tsconfig.json changed"]);

    git("checkout", "-q", "--", "tsconfig.json");
    git("mv", "eslint.config.mjs", "eslint.config.old.mjs");
    expect(run({ XUM_LINT_BASE: base })).toEqual(["full eslint.config.mjs changed"]);
  });

  it("lints everything when a config file changes type", () => {
    write("tsconfig.base.json", "{}\n");
    fs.symlinkSync("tsconfig.base.json", path.join(repo, "tsconfig.json"));
    git("add", ".");
    git("commit", "-q", "-m", "symlinked config");
    const base = git("rev-parse", "HEAD");

    fs.rmSync(path.join(repo, "tsconfig.json"));
    write("tsconfig.json", "{}\n");

    expect(run({ XUM_LINT_BASE: base })).toEqual(["full tsconfig.json changed"]);
  });

  it("honors XUM_LINT_BASE", () => {
    write("src/committed.ts");
    git("add", ".");
    git("commit", "-q", "-m", "feature work");

    expect(run({ XUM_LINT_BASE: "HEAD" })).toEqual([`files ${git("rev-parse", "HEAD")}`]);
  });

  it("rejects an XUM_LINT_BASE that names no commit", () => {
    expect(() => run({ XUM_LINT_BASE: "no-such-ref" })).toThrow(/XUM_LINT_BASE=no-such-ref/);
  });

  it("lints everything when there is no main to compare against", () => {
    git("branch", "-q", "-m", "main", "trunk");

    expect(run()).toEqual(["full no merge base with origin/main or main"]);
  });

  it("lists every file ESLint lints, including gitignored ones", () => {
    fs.rmSync(path.join(repo, "src/deleted.ts"));
    write("tests/__mocks__/styleMock.js", "module.exports = {};\n");
    write("src/node/workflowRuntime/runtime.js", "export {};\n");
    write("src/node_modules/pkg/index.ts");
    write("src/committed.generated.ts");
    write(".gitignore", "*.generated.ts\nnode_modules/\n");
    git("add", "-f", "src/committed.generated.ts");
    write("src/untracked.generated.ts");
    write("docs/page.md", "# page\n");

    expect(lintTargets.listLintFiles(repo)).toEqual([
      "src/committed.generated.ts",
      "src/edited.ts",
      "src/kept.ts",
      "src/node/workflowRuntime/runtime.js",
      "src/renamed.ts",
      "src/untracked.generated.ts",
    ]);
    // oxlint walks the directories but skips gitignored files, so those are passed explicitly.
    expect(lintTargets.oxlintArgs(repo)).toEqual([
      "src",
      "tests",
      "scripts/lib",
      "src/committed.generated.ts",
      "src/untracked.generated.ts",
    ]);
  });
});
