"use strict";

// Chooses what `make lint` checks: only the files this branch changed, or everything.
//
// A cold type-aware ESLint run over the whole repo peaks at ~7.6 GiB and takes minutes, and every
// new worktree starts without an ESLint cache. Several agents doing that at once OOM-killed shared
// 64 GiB workspaces. Linting only the changed files still loads the TypeScript program, but peaks
// at ~3 GiB and takes seconds. `make lint-full` (run by CI) still lints everything, because a type
// change in one file can surface type-aware findings in files the branch did not touch.

const { execFileSync } = require("node:child_process");

// Must match ESLINT_PATTERNS in scripts/lint.sh: files outside them have no type-aware parser
// setup, so ESLint fails on them instead of skipping them.
const LINT_FILE_PATTERNS = [
  /^src\/.+\.tsx?$/,
  /^tests\/.+\.tsx?$/,
  /^src\/node\/builtinSkills\/.+\.js$/,
  /^src\/node\/workflowRuntime\/[^/]+\.js$/,
  /^scripts\/lib\/[^/]+\.js$/,
];

// Changes that can alter findings in files the branch did not edit, so only a full run is
// trustworthy: the lint config and its inputs, dependencies, and the compiler settings.
const FULL_LINT_TRIGGERS = [
  /^eslint\.config\.mjs$/,
  /^package\.json$/,
  /^bun\.lock$/,
  /^tsconfig[^/]*\.json$/,
  /^scripts\/lint\.sh$/,
  /^scripts\/lib\/lint_targets\.js$/,
];

const DEFAULT_BASE_REFS = ["origin/main", "main"];

/**
 * @param {string[]} changedFiles repo-relative paths that exist after the change
 * @param {string[]} [removedFiles] repo-relative paths the change deleted or renamed away
 * @returns {{ mode: "full", reason: string } | { mode: "files", files: string[] }}
 */
function selectLintTargets(changedFiles, removedFiles = []) {
  const trigger = [...changedFiles, ...removedFiles].find((file) =>
    FULL_LINT_TRIGGERS.some((re) => re.test(file))
  );
  if (trigger !== undefined) {
    return { mode: "full", reason: `${trigger} changed` };
  }
  const files = changedFiles.filter((file) => LINT_FILE_PATTERNS.some((re) => re.test(file)));
  return { mode: "files", files: [...new Set(files)].sort() };
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * The commit the branch is compared against: XUM_LINT_BASE when set (an error if it does not
 * resolve), otherwise the merge base with origin/main or main, otherwise null.
 */
function resolveBase(cwd, env = process.env) {
  if (env.XUM_LINT_BASE) {
    try {
      return git(["rev-parse", "--verify", `${env.XUM_LINT_BASE}^{commit}`], cwd).trim();
    } catch {
      throw new Error(`XUM_LINT_BASE=${env.XUM_LINT_BASE} does not name a commit`);
    }
  }
  for (const ref of DEFAULT_BASE_REFS) {
    try {
      return git(["merge-base", "HEAD", ref], cwd).trim();
    } catch {
      // Try the next ref; a shallow or fork checkout may lack origin/main.
    }
  }
  return null;
}

/**
 * `changed`: files added, copied, modified, renamed or type-changed (e.g. symlink to file) since
 * `base` (committed or not), plus untracked files. `removed`: files deleted or renamed away since
 * `base`; they cannot be linted, but a deleted or moved config still changes what every other file
 * is checked against.
 */
function listChangedFiles(cwd, base) {
  const split = (output) => output.split("\0").filter((file) => file !== "");
  return {
    changed: [
      ...split(git(["diff", "--name-only", "--diff-filter=ACMRT", "-z", base], cwd)),
      ...split(git(["ls-files", "--others", "--exclude-standard", "-z"], cwd)),
    ],
    // --no-renames reports a rename as a deletion of the old path.
    removed: split(
      git(["diff", "--name-only", "--no-renames", "--diff-filter=D", "-z", base], cwd)
    ),
  };
}

/**
 * Prints the selection for scripts/lint.sh. The first line is `full <reason>` or
 * `files <base>`; for `files`, one path per following line.
 */
function main(cwd = process.cwd(), env = process.env) {
  const base = resolveBase(cwd, env);
  if (base === null) {
    return `full no merge base with ${DEFAULT_BASE_REFS.join(" or ")}\n`;
  }
  const { changed, removed } = listChangedFiles(cwd, base);
  const selection = selectLintTargets(changed, removed);
  if (selection.mode === "full") {
    return `full ${selection.reason}\n`;
  }
  return [`files ${base}`, ...selection.files].join("\n") + "\n";
}

module.exports = { LINT_FILE_PATTERNS, FULL_LINT_TRIGGERS, selectLintTargets, resolveBase, main };

if (require.main === module) {
  try {
    process.stdout.write(main());
  } catch (error) {
    process.stderr.write(
      `lint_targets: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
