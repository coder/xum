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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../..");
const HOME = "/home/runner";
const RUNNER_TEMP = "/home/runner/work/_temp";

interface CacheStep {
  file: string;
  /** actions/cache, actions/cache/restore or actions/cache/save. */
  action: string;
  paths: string[];
  /** The key as written. A save step has its restore step's key: it names it by output. */
  key: string;
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
  if (raw.startsWith("${{ runner.temp }}/")) {
    return path.posix.normalize(RUNNER_TEMP + raw.slice("${{ runner.temp }}".length));
  }
  if (raw.includes("${{")) {
    throw new Error(`cannot resolve cache path ${raw}`);
  }
  return path.posix.normalize(raw.startsWith("~") ? HOME + raw.slice(1) : raw);
}

// Every workflow and composite action under `root`: GitHub runs .yml and .yaml alike.
function workflowFiles(root: string = ROOT): string[] {
  const isYaml = (name: string) => /\.ya?ml$/.test(name);
  const workflows = readdirSync(path.join(root, ".github/workflows"))
    .filter(isYaml)
    .map((name) => `.github/workflows/${name}`);
  const actions = readdirSync(path.join(root, ".github/actions")).flatMap((dir) =>
    ["action.yml", "action.yaml"]
      .filter((name) => existsSync(path.join(root, ".github/actions", dir, name)))
      .map((name) => `.github/actions/${dir}/${name}`)
  );
  return [...workflows, ...actions];
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
        key: keyOf(step, steps),
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

// The restore step and the save step of one guarded cache.
const stepsOf = (prefix: string) =>
  guardedSteps.filter((step) => step.keyPrefix.startsWith(prefix));

// The file whose content makes each guarded cache's key: the pins, or the checksums, that the
// cached files are checked against. A key without it keeps an entry after its pins change.
const KEYED_BY: Record<string, string> = {
  "release-assets-shfmt-hadolint-": "scripts/ci/install-release-tools.sh",
  "release-assets-static-curl-": "scripts/ci/install-release-tools.sh",
  "tree-sitter-grammars-v": "scripts/ci/download_tree_sitter_grammars.py",
  "xum-electron-zip-": "node_modules/electron/checksums.json",
};

describe("the isolation check", () => {
  const cache = (over: Partial<CacheStep>): CacheStep => ({
    file: "x.yml",
    action: "actions/cache",
    paths: [`${HOME}/.cache/mine`],
    key: "mine-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('x') }}",
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

describe("the workflow files that the check reads", () => {
  test("are every .yml and .yaml workflow and every action.yml and action.yaml", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cache-paths-"));
    try {
      const files = [
        ".github/workflows/a.yml",
        ".github/workflows/b.yaml",
        ".github/workflows/notes.md",
        ".github/actions/c/action.yml",
        ".github/actions/d/action.yaml",
        ".github/actions/e/README.md",
      ];
      for (const file of files) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "");
      }
      expect(workflowFiles(root).sort()).toEqual([
        ".github/actions/c/action.yml",
        ".github/actions/d/action.yaml",
        ".github/workflows/a.yml",
        ".github/workflows/b.yaml",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("include the real ones", () => {
    expect(workflowFiles()).toContain(".github/workflows/pr.yml");
    expect(workflowFiles()).toContain(".github/actions/setup-xum/action.yml");
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

  test("each saves the path that it restores, under the key that it looked up", () => {
    for (const prefix of GUARDED) {
      const restore = stepsOf(prefix).find((step) => step.action === "actions/cache/restore");
      const save = stepsOf(prefix).find((step) => step.action === "actions/cache/save");
      expect(restore).toBeDefined();
      expect(save?.paths).toEqual(restore?.paths);
      expect(save?.key).toBe(restore?.key);
    }
  });

  test.each(Object.entries(KEYED_BY))("the key of %s hashes %s", (prefix, file) => {
    for (const step of stepsOf(prefix)) {
      expect(step.key).toContain(`hashFiles('${file}')`);
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
      const steps = stepsOf(`release-assets-${set}-`);
      expect(steps).toHaveLength(2);
      for (const step of steps) {
        expect(step.paths).toEqual([`${HOME}/${root}/${set}`]);
      }
    }
  });

  test("the grammar cache is the stage directory that the Download step hands the script, under the runner's temp directory", () => {
    const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/pr.yml"), "utf8")) as {
      jobs: Record<string, { steps: { name?: string; env?: Record<string, unknown> }[] }>;
    };
    const download = workflow.jobs["static-check"].steps.find(
      (step) => step.name === "Download tree-sitter grammars"
    );
    const stage = text(download?.env?.GRAMMAR_STAGE_DIR);
    expect(stage).not.toBe("");
    const steps = stepsOf("tree-sitter-grammars-v");
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.paths).toEqual([resolvePath(stage, "")]);
      expect(step.paths[0].startsWith(`${RUNNER_TEMP}/`)).toBe(true);
    }
  });
});
