// The CI caches of the downloaded tools (shfmt, hadolint, static curl, the tree-sitter grammars
// and the Electron zip) must stay isolated from every other cache. Depot's cache does not keep
// branches apart, and actions/cache extracts entries with `tar -P`, so a crafted entry can write
// outside its own path. The scripts check what they use from these four caches against pins
// (scripts/ci/download_tree_sitter_grammars.py, download-verified.sh, @electron/get). This file
// guards what the scripts cannot: that no other cache shares, contains or is looked up by the
// same names as these four.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/cachePaths.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../..");
const HOME = "/home/runner";

interface CacheStep {
  file: string;
  /** actions/cache, actions/cache/restore or actions/cache/save. */
  action: string;
  paths: string[];
  /** The key with runner.os and runner.arch filled in, cut at the first other expression. */
  keyPrefix: string;
  /** The same for each restore-keys line. */
  restoreKeyPrefixes: string[];
}

interface WorkflowStep {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

function literalPrefix(expression: string): string {
  return expression
    .replaceAll("${{ runner.os }}", "Linux")
    .replaceAll("${{ runner.arch }}", "X64")
    .split("${{")[0]
    .trim();
}

// A `with:` input as text. Cache inputs are strings; anything else counts as empty.
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lines(value: unknown): string[] {
  return text(value)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// A path as the runner sees it: `~` is the home directory, and the one expression in use
// (`${{ env.electron_config_cache }}`) is read from the line that sets it in the same file.
function resolvePath(raw: string, fileText: string): string {
  if (raw === "${{ env.electron_config_cache }}") {
    const line = /electron_config_cache=(\S+?)"? >>/.exec(fileText);
    if (line === null) {
      throw new Error("electron_config_cache is not set in the file that uses it");
    }
    return resolvePath(line[1].replace("$HOME", "~"), fileText);
  }
  if (raw.includes("${{")) {
    throw new Error(`cannot resolve cache path ${raw}`);
  }
  return path.posix.normalize(raw.startsWith("~") ? HOME + raw.slice(1) : raw);
}

function workflowFiles(): string[] {
  return [
    ...readdirSync(path.join(ROOT, ".github/workflows"))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => `.github/workflows/${name}`),
    ...readdirSync(path.join(ROOT, ".github/actions")).map(
      (dir) => `.github/actions/${dir}/action.yml`
    ),
  ];
}

// A save step names its key by the restore step's output: `steps.<id>.outputs.cache-primary-key`.
function keyOf(step: WorkflowStep, steps: WorkflowStep[]): string {
  const key = text(step.with?.key);
  const id = /^\$\{\{ steps\.([\w-]+)\.outputs\.cache-primary-key \}\}$/.exec(key)?.[1];
  if (id === undefined) {
    return key;
  }
  const restore = steps.find((candidate) => candidate.id === id);
  if (restore === undefined) {
    throw new Error(`cache key refers to the unknown step ${id}`);
  }
  return text(restore.with?.key);
}

function cacheStepsOf(file: string): CacheStep[] {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const doc = parse(text) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
    runs?: { steps?: WorkflowStep[] };
  };
  const stepLists = [
    ...Object.values(doc.jobs ?? {}).map((job) => job.steps ?? []),
    doc.runs?.steps ?? [],
  ];
  return stepLists.flatMap((steps) =>
    steps
      .filter((step) => step.uses?.startsWith("actions/cache"))
      .map((step) => ({
        file,
        action: String(step.uses).split("@")[0],
        paths: lines(step.with?.path).map((raw) => resolvePath(raw, text)),
        keyPrefix: literalPrefix(keyOf(step, steps)),
        restoreKeyPrefixes: lines(step.with?.["restore-keys"]).map(literalPrefix),
      }))
  );
}

const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** What is wrong with `guarded` caches next to every cache step in `all`, one line each. */
function isolationProblems(guarded: CacheStep[], all: CacheStep[]): string[] {
  const problems: string[] = [];
  for (const step of guarded) {
    for (const other of all) {
      if (other === step) {
        continue;
      }
      const sameCache = other.keyPrefix === step.keyPrefix;
      for (const own of step.paths) {
        for (const theirs of other.paths) {
          if (!sameCache && overlaps(own, theirs)) {
            problems.push(
              `${step.keyPrefix}: path ${own} overlaps ${theirs} of ${other.file} (${other.keyPrefix})`
            );
          } else if (other.restoreKeyPrefixes.length > 0 && overlaps(own, theirs)) {
            problems.push(
              `${step.keyPrefix}: path ${own} overlaps ${theirs} of ${other.file}, which has restore-keys`
            );
          }
        }
      }
      for (const prefix of other.restoreKeyPrefixes) {
        if (step.keyPrefix.startsWith(prefix)) {
          problems.push(
            `${step.keyPrefix}: starts with restore-keys prefix ${prefix} of ${other.file}`
          );
        }
      }
    }
  }
  return [...new Set(problems)];
}

const GUARDED = [
  "release-assets-shfmt-hadolint-",
  "release-assets-static-curl-",
  "tree-sitter-grammars-v",
  "xum-electron-zip-",
];

const allSteps = workflowFiles().flatMap(cacheStepsOf);
const guardedSteps = allSteps.filter((step) =>
  GUARDED.some((prefix) => step.keyPrefix.startsWith(prefix))
);

describe("the isolation check", () => {
  const cache = (over: Partial<CacheStep>): CacheStep => ({
    file: "x.yml",
    action: "actions/cache",
    paths: [`${HOME}/.cache/mine`],
    keyPrefix: "mine-Linux-X64-",
    restoreKeyPrefixes: [],
    ...over,
  });

  test("passes for caches that share nothing", () => {
    expect(
      isolationProblems(
        [cache({})],
        [cache({}), cache({ keyPrefix: "o-", paths: [`${HOME}/.cache/o`] })]
      )
    ).toEqual([]);
  });

  test("reports the same path, a nested path and a parent path of another cache", () => {
    for (const other of [`${HOME}/.cache/mine`, `${HOME}/.cache/mine/sub`, `${HOME}/.cache`]) {
      const problems = isolationProblems(
        [cache({})],
        [cache({}), cache({ keyPrefix: "o-", paths: [other] })]
      );
      expect(problems).toHaveLength(1);
    }
  });

  test("reports a path that a cache with restore-keys shares, even under the same key", () => {
    const sibling = cache({ restoreKeyPrefixes: ["unrelated-"] });
    expect(isolationProblems([cache({})], [cache({}), sibling])).toHaveLength(1);
  });

  test("reports a key that a restore-keys prefix of another cache matches", () => {
    const looker = cache({
      keyPrefix: "o-",
      paths: [`${HOME}/.cache/o`],
      restoreKeyPrefixes: ["mine-"],
    });
    expect(isolationProblems([cache({})], [cache({}), looker])).toHaveLength(1);
  });

  test("does not report a restore-keys prefix that does not match", () => {
    const looker = cache({
      keyPrefix: "o-",
      paths: [`${HOME}/.cache/o`],
      restoreKeyPrefixes: ["o-"],
    });
    expect(isolationProblems([cache({})], [cache({}), looker])).toEqual([]);
  });
});

describe("the download caches of the CI tools", () => {
  test("each of the four has one restore step and one save step", () => {
    for (const prefix of GUARDED) {
      const actions = guardedSteps
        .filter((step) => step.keyPrefix.startsWith(prefix))
        .map((step) => step.action);
      expect(actions.toSorted()).toEqual(["actions/cache/restore", "actions/cache/save"]);
    }
  });

  test("no other cache shares, contains or is nested in their paths, and none looks up their keys", () => {
    expect(isolationProblems(guardedSteps, allSteps)).toEqual([]);
  });

  test("the four caches have four distinct paths, each of one directory", () => {
    const paths = GUARDED.map((prefix) => {
      const own = guardedSteps.find((step) => step.keyPrefix.startsWith(prefix))?.paths ?? [];
      expect(own).toHaveLength(1);
      return own[0];
    });
    expect(new Set(paths).size).toBe(GUARDED.length);
  });

  test("each tool set is cached at <assets>/<tool set>, where install-release-tools.sh writes it", () => {
    const script = readFileSync(path.join(ROOT, "scripts/ci/install-release-tools.sh"), "utf8");
    const root = /assets_root=\$\{RELEASE_ASSETS_DIR:-\$HOME\/([^}]+)\}/.exec(script)?.[1];
    expect(root).toBe(".cache/xum-release-assets");
    for (const set of ["shfmt-hadolint", "static-curl"]) {
      expect(script).toContain(`assets=$assets_root/${set}`);
      const step = guardedSteps.find((s) => s.keyPrefix.startsWith(`release-assets-${set}-`));
      expect(step?.paths).toEqual([`${HOME}/${root}/${set}`]);
    }
  });

  test("the grammar cache is the stage directory that the download script fills", () => {
    const script = readFileSync(
      path.join(ROOT, "scripts/ci/download_tree_sitter_grammars.py"),
      "utf8"
    );
    const stage = /DEFAULT_STAGE_DIR = "([^"]+)"/.exec(script)?.[1];
    expect(stage).toBe("~/.cache/xum-tree-sitter-grammars");
    const step = guardedSteps.find((s) => s.keyPrefix.startsWith("tree-sitter-grammars-v"));
    expect(step?.paths).toEqual([resolvePath(stage ?? "", "")]);
  });
});
