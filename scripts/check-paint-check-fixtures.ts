/**
 * Prove that the guards of the paint-check runner (.storybook/test-runner.ts) still fire.
 *
 * Why this exists: every real paint-check story is valid, so deleting a guard from the runner
 * leaves them all green. The stories in src/browser/stories/PaintCheckFixtures.stories.tsx are
 * built to trip a guard each, or to pass on purpose. This runs them through the real runner (the
 * same test-storybook that `make test-storybook` runs) and requires each one to fail with its
 * message, or to pass.
 *
 * Usage (Storybook must be built and served, like `make test-storybook`; STORYBOOK_URL names a
 * server other than http://127.0.0.1:6006):
 *   bun scripts/check-paint-check-fixtures.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const FIXTURE_TAG = "paint-fixture";
const FIXTURE_FILE = "src/browser/stories/PaintCheckFixtures.stories.tsx";

// The runner's viewport check fails a diagram that is off screen, hidden, covered or clipped.
const VIEWPORT_CHECK_MESSAGE = "must change pixels inside its box";

/**
 * Story export name -> a piece of the runner's failure message, or null for a story that must
 * pass. The pieces are exact on purpose: a story that fails for another reason is not the guard
 * firing.
 */
export const FIXTURES: ReadonlyMap<string, string | null> = new Map([
  ["BrokenChartNextToGoodChart", "must show a rendered Mermaid diagram"],
  ["DiagramOutsideTheViewport", VIEWPORT_CHECK_MESSAGE],
  ["DiagramInHiddenParent", VIEWPORT_CHECK_MESSAGE],
  ["DiagramUnderAnOverlay", VIEWPORT_CHECK_MESSAGE],
  ["DiagramClippedAway", VIEWPORT_CHECK_MESSAGE],
  ["DiagramPaintsOutsideItsBox", "paint only inside its box"],
  ["DiagramMountsWhenTheRunnerWaits", null],
]);

/** The part of Jest's --json report that this reads. */
export interface JestReport {
  testResults: Array<{
    assertionResults: Outcome[];
  }>;
}

interface Outcome {
  ancestorTitles: string[];
  status: string;
  failureMessages: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStrings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOutcome = (value: unknown): value is Outcome =>
  isRecord(value) &&
  isStrings(value.ancestorTitles) &&
  typeof value.status === "string" &&
  isStrings(value.failureMessages);

// A crash in test-storybook or a Jest upgrade can leave a file that parses but is not a report.
const isJestReport = (value: unknown): value is JestReport =>
  isRecord(value) &&
  Array.isArray(value.testResults) &&
  value.testResults.every(
    (file) =>
      isRecord(file) &&
      Array.isArray(file.assertionResults) &&
      file.assertionResults.every(isOutcome)
  );

function mismatch(failsWith: string | null, outcome: Outcome): string | null {
  const message = stripVTControlCharacters(outcome.failureMessages.join("\n"));
  if (failsWith === null) {
    return outcome.status === "passed" ? null : `must pass, but ${outcome.status}:\n${message}`;
  }
  if (outcome.status !== "failed") return `must fail with "${failsWith}", but ${outcome.status}`;
  return message.includes(failsWith)
    ? null
    : `must fail with "${failsWith}", but failed with:\n${message}`;
}

/** What differs from FIXTURES in a report. An empty list means every guard fired. */
export function fixtureProblems(report: unknown): string[] {
  if (!isJestReport(report)) {
    return [
      "The report is not Jest's --json shape (testResults[].assertionResults[] with " +
        `ancestorTitles, status and failureMessages): ${JSON.stringify(report)?.slice(0, 200)}`,
    ];
  }
  const outcomes = report.testResults.flatMap((file) => file.assertionResults);
  const problems: string[] = [];
  for (const [story, failsWith] of FIXTURES) {
    const ran = outcomes.filter((outcome) => outcome.ancestorTitles.at(-1) === story);
    if (ran.length !== 1) {
      problems.push(`${story}: the runner ran ${ran.length} tests for it, not 1`);
      continue;
    }
    const problem = mismatch(failsWith, ran[0]);
    if (problem !== null) problems.push(`${story}: ${problem}`);
  }
  if (outcomes.length !== FIXTURES.size) {
    problems.push(
      `The runner ran ${outcomes.length} tests, but this script lists ${FIXTURES.size} fixtures: ` +
        `add each story tagged ${FIXTURE_TAG} to FIXTURES`
    );
  }
  return problems;
}

function main(): number {
  // From the environment, not a flag: Make passes it on without a shell reading its characters.
  const url = process.env.STORYBOOK_URL || "http://127.0.0.1:6006";
  const dir = mkdtempSync(join(tmpdir(), "paint-check-fixtures-"));
  const reportFile = join(dir, "report.json");
  try {
    // Node, as in `make test-storybook` (bun x runs the package's node bin). The run exits 1,
    // because the fixtures built to fail do fail: only the report says whether each did what it
    // should.
    const run = spawnSync(
      "node",
      [
        "node_modules/.bin/test-storybook",
        // --no-index-json: a non-local URL would switch the runner to a mode that ignores the file
        // below and names each test after the story's display name instead of its export.
        ...[
          "--url",
          url,
          "--no-index-json",
          "--includeTags",
          FIXTURE_TAG,
          "--testTimeout",
          "30000",
        ],
        ...["--json", "--outputFile", reportFile, FIXTURE_FILE],
      ],
      { encoding: "utf8", timeout: 5 * 60_000 }
    );
    const log = `${run.stdout}${run.stderr}`;
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(reportFile, "utf8"));
    } catch {
      console.error(`test-storybook wrote no readable report (exit ${run.status}):\n${log}`);
      return 1;
    }
    const problems = fixtureProblems(report);
    if (problems.length > 0) {
      console.error(`${problems.join("\n\n")}\n\nThe runner's output:\n${log}`);
      return 1;
    }
    console.log(`Paint-check fixtures: all ${FIXTURES.size} failed or passed as expected.`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main());
