import { describe, expect, test } from "bun:test";
import { FIXTURES, fixtureProblems, type JestReport } from "./check-paint-check-fixtures";

type Outcome = JestReport["testResults"][number]["assertionResults"][number];

function outcomeFor(story: string, failsWith: string | null): Outcome {
  return {
    ancestorTitles: ["Tests/PaintCheckFixtures", story],
    status: failsWith === null ? "passed" : "failed",
    // Jest colours its messages.
    failureMessages: failsWith === null ? [] : [`\u001b[31mAssertionError\u001b[39m: ${failsWith}`],
  };
}

function reportOf(outcomes: Outcome[]): JestReport {
  return { testResults: [{ assertionResults: outcomes }] };
}

const asExpected = () => [...FIXTURES].map(([story, failsWith]) => outcomeFor(story, failsWith));

describe("fixtureProblems", () => {
  test("is empty when every fixture fails with its message or passes", () => {
    expect(fixtureProblems(reportOf(asExpected()))).toEqual([]);
  });

  test("names a fixture that must fail but passed, as when the runner drops its guard", () => {
    const outcomes = asExpected().map((outcome) =>
      outcome.ancestorTitles[1] === "DiagramOutsideTheViewport"
        ? { ...outcome, status: "passed", failureMessages: [] }
        : outcome
    );
    const problems = fixtureProblems(reportOf(outcomes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("DiagramOutsideTheViewport");
    expect(problems[0]).toContain("but passed");
  });

  test("rejects a fixture that fails for another reason", () => {
    const outcomes = asExpected().map((outcome) =>
      outcome.ancestorTitles[1] === "BrokenChartNextToGoodChart"
        ? { ...outcome, failureMessages: ["Failed to fetch dynamically imported module"] }
        : outcome
    );
    const problems = fixtureProblems(reportOf(outcomes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Failed to fetch dynamically imported module");
  });

  test("names the fixture that must pass but failed", () => {
    const outcomes = asExpected().map((outcome) =>
      outcome.ancestorTitles[1] === "DiagramMountsThreeSecondsLate"
        ? outcomeFor("DiagramMountsThreeSecondsLate", "A story tagged paint-check must show")
        : outcome
    );
    const problems = fixtureProblems(reportOf(outcomes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must pass, but failed");
  });

  test("reports a fixture the runner did not run, and a story the script does not list", () => {
    const [, ...withoutFirst] = asExpected();
    const missing = fixtureProblems(reportOf(withoutFirst));
    expect(missing.some((problem) => problem.startsWith("BrokenChartNextToGoodChart"))).toBe(true);

    const extra = fixtureProblems(reportOf([...asExpected(), outcomeFor("Unlisted", null)]));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain("lists 3 fixtures");
  });
});
