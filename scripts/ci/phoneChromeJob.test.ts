// Guards the CI wiring of `make check-phone-chrome`. #7993 changed a class in src/browser, and
// its PR run skipped Test / E2E (the job that ran the check as a step, and that a PR runs only
// when it changes e2e_tests). A skipped job counts as passing in Required, so main broke. The
// check now has a job of its own, which a PR's path filter must reach and Required must wait for.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally: bun test ./scripts/ci/phoneChromeJob.test.ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
    const gate = all["test-phone-chrome"]?.if ?? "";
    expect(gate).toContain("needs.changes.outputs.phone_chrome == 'true'");
    expect(gate).not.toContain("e2e_tests");
    expect(all.changes?.outputs?.phone_chrome).toBe("${{ steps.filter.outputs.phone_chrome }}");
  });

  test("is a job that Required waits for", async () => {
    expect((await jobs()).required?.needs).toContain("test-phone-chrome");
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
    ]);

    expect(missed).toEqual([]);
  });
});
