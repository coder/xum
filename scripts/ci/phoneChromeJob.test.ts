// Guards the CI wiring of `make check-phone-chrome`. #7993 changed a class in src/browser, and
// its PR run skipped Test / E2E (the job that ran the check as a step, and that a PR runs only
// when it changes e2e_tests). A skipped job counts as passing in Required, so main broke. The
// check now has a job of its own, which a PR's path filter must reach and Required must wait for.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally: bun test ./scripts/ci/phoneChromeJob.test.ts
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";

const REPO = path.resolve(import.meta.dir, "../..");
const GENERATOR = "scripts/perf/generatePhoneChrome.ts";

interface Step {
  id?: string;
  run?: string;
  with?: { filters?: string };
}
interface Job {
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  steps?: Step[];
}

async function jobs(): Promise<Record<string, Job>> {
  const workflow = parse(await readFile(path.join(REPO, ".github/workflows/pr.yml"), "utf8")) as {
    jobs: Record<string, Job>;
  };
  return workflow.jobs;
}

interface Scenario {
  event: "pull_request" | "merge_group" | "push" | "workflow_dispatch";
  actor?: string;
  testFilter?: string;
  tests: boolean;
  phoneChrome: boolean;
}

// Runs the job's `if:` for one scenario. The expression uses only names, strings, ==, !=, && and
// ||, which mean the same in JavaScript, so it is rewritten to read a context object.
function gateRuns(gate: string, scenario: Scenario): boolean {
  const js = gate
    .replace(/github\.event\.inputs\.test_filter/g, "ctx.testFilter")
    .replace(/github\.event_name/g, "ctx.event")
    .replace(/github\.actor/g, "ctx.actor")
    .replace(/needs\.changes\.outputs\.tests/g, "ctx.tests")
    .replace(/needs\.changes\.outputs\.phone_chrome/g, "ctx.phoneChrome");
  if (/\b(?:github|needs|inputs)\./.test(js)) throw new Error(`the gate reads a new name: ${gate}`);
  const ctx = {
    event: scenario.event,
    actor: scenario.actor ?? "ThomasK33",
    testFilter: scenario.testFilter ?? "",
    tests: String(scenario.tests),
    phoneChrome: String(scenario.phoneChrome),
  };
  return Boolean(new Function("ctx", `return ${js};`)(ctx));
}

async function phoneChromePatterns(): Promise<string[]> {
  const filter = (await jobs()).changes?.steps?.find((step) => step.id === "filter");
  const filters = parse(filter?.with?.filters ?? "") as Record<string, string[] | undefined>;
  const patterns = filters.phone_chrome;
  if (patterns === undefined) throw new Error("the changes job has no phone_chrome path filter");
  return patterns;
}

async function pathsThatMissTheJob(files: string[]): Promise<string[]> {
  const globs = (await phoneChromePatterns()).map((pattern) => new Bun.Glob(pattern));
  return files.filter((file) => !globs.some((glob) => glob.match(file)));
}

describe("the phone chrome check in pr.yml", () => {
  test("runs in one job that a PR's path filter decides, not in a job the e2e filter decides", async () => {
    const all = await jobs();
    const runners = Object.entries(all)
      .filter(([, job]) => job.steps?.some((step) => step.run?.includes("check-phone-chrome")))
      .map(([id]) => id);

    expect(runners).toEqual(["test-phone-chrome"]);
    expect(all["test-phone-chrome"]?.if ?? "").not.toContain("e2e_tests");
    expect(all.changes?.outputs?.phone_chrome).toBe("${{ steps.filter.outputs.phone_chrome }}");
  });

  test.each<[name: string, scenario: Scenario, runs: boolean]>([
    [
      "a PR that changes a phone page file",
      { event: "pull_request", tests: true, phoneChrome: true },
      true,
    ],
    // index.html, public/ and patches/ are in no `tests` filter.
    [
      "a PR that changes only a file that tests ignores",
      { event: "pull_request", tests: false, phoneChrome: true },
      true,
    ],
    [
      "a PR that changes no phone page file",
      { event: "pull_request", tests: true, phoneChrome: false },
      false,
    ],
    [
      "a merge queue group with code changes",
      { event: "merge_group", tests: true, phoneChrome: false },
      true,
    ],
    [
      "a merge queue group that changes only a file that tests ignores",
      { event: "merge_group", tests: false, phoneChrome: true },
      true,
    ],
    [
      "a merge queue group with docs changes only",
      { event: "merge_group", tests: false, phoneChrome: false },
      false,
    ],
    ["a push to main by a person", { event: "push", tests: true, phoneChrome: false }, true],
    [
      "the push that the merge queue makes to main",
      { event: "push", actor: "github-merge-queue[bot]", tests: false, phoneChrome: true },
      false,
    ],
    [
      "a manual run on a branch",
      { event: "workflow_dispatch", tests: true, phoneChrome: false },
      true,
    ],
    [
      "a manual run with a test filter",
      { event: "workflow_dispatch", testFilter: "-t x", tests: true, phoneChrome: true },
      false,
    ],
  ])("decides the job for %s", async (_name, scenario, runs) => {
    const gate = (await jobs())["test-phone-chrome"]?.if ?? "";

    expect(gateRuns(gate, scenario)).toBe(runs);
  });

  test("is a job that Required waits for", async () => {
    expect((await jobs()).required?.needs).toContain("test-phone-chrome");
  });

  test("starts when a PR changes a file that the neutral seed copies into the captured workspace", async () => {
    const dir = "scripts/perf/fixtures/neutralSeed";
    const fixtures = (await readdir(path.join(REPO, dir))).map((name) => `${dir}/${name}`);
    expect(fixtures).toContain(`${dir}/chat.jsonl`);

    expect(await pathsThatMissTheJob(fixtures)).toEqual([]);
  });

  test("starts when a PR changes a renderer file, the skeleton, or a helper of the generator", async () => {
    const source = await readFile(path.join(REPO, GENERATOR), "utf8");
    const helpers = [...source.matchAll(/from "\.\/(\w+)"/g)].map(
      (match) => `scripts/perf/${match[1]}.ts`
    );
    expect(helpers.length).toBeGreaterThan(0);

    const missed = await pathsThatMissTheJob([
      GENERATOR,
      ...helpers,
      "src/common/staticWorkspaceView/phoneChrome.generated.ts",
      // The file whose new class broke main in #7993.
      "src/browser/components/ChatPane/ChatActivityLine.tsx",
      // What builds the renderer and runs the generator.
      "src/browser/styles/globals.css",
      "src/constants/layout.ts",
      "src/vite/reactCompilerConfig.ts",
      "index.html",
      "vite.config.ts",
      "tsconfig.json",
      "patches/react-remove-scroll@2.7.2.patch",
      "package.json",
      "bun.lock",
      "Makefile",
      ".github/workflows/pr.yml",
      ".github/actions/setup-xum/action.yml",
      ".github/actions/setup-playwright/action.yml",
    ]);

    expect(missed).toEqual([]);
  });
});
