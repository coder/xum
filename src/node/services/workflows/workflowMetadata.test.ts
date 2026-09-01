import { describe, expect, test } from "bun:test";

import {
  parseDeclaredPhases,
  parseWorkflowMetadata,
  WorkflowDeclaredPhasesValidationError,
} from "./workflowMetadata";

function expectIssues(metadata: Record<string, unknown>, expectedFragments: string[]): void {
  try {
    parseDeclaredPhases(metadata);
    expect.unreachable("parseDeclaredPhases must reject invalid meta.phases");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowDeclaredPhasesValidationError);
    const { issues } = error as WorkflowDeclaredPhasesValidationError;
    expect(issues).toHaveLength(expectedFragments.length);
    for (const fragment of expectedFragments) {
      expect(issues.some((issue) => issue.includes(fragment))).toBe(true);
    }
  }
}

describe("parseDeclaredPhases", () => {
  test("returns undefined when meta.phases is absent", () => {
    expect(parseDeclaredPhases(null)).toBeUndefined();
    expect(parseDeclaredPhases({ description: "no phases" })).toBeUndefined();
  });

  test("parses a valid declaration preserving order and optional fields", () => {
    const phases = parseDeclaredPhases({
      phases: [
        { name: "scope", label: "Scope", description: "Pick angles" },
        { name: "verify", parallel: true },
        { name: "synthesize" },
      ],
    });
    expect(phases).toEqual([
      { name: "scope", label: "Scope", description: "Pick angles" },
      { name: "verify", parallel: true },
      { name: "synthesize" },
    ]);
  });

  test("parses meta.phases from real workflow source through parseWorkflowMetadata", () => {
    const source = `export const meta = {
  description: "Demo",
  phases: [{ name: "a" }, { name: "b", parallel: true }],
};
export default function workflow({ phase }) { phase("a"); phase("b"); return {}; }
`;
    expect(parseDeclaredPhases(parseWorkflowMetadata(source))).toEqual([
      { name: "a" },
      { name: "b", parallel: true },
    ]);
  });

  test("rejects a non-array declaration", () => {
    expectIssues({ phases: "scope" }, ["must be an array"]);
  });

  test("rejects an empty declaration", () => {
    expectIssues({ phases: [] }, ["at least one phase"]);
  });

  test("rejects more than the maximum number of phases", () => {
    const phases = Array.from({ length: 65 }, (_, i) => ({ name: `phase-${i}` }));
    expectIssues({ phases }, ["at most 64 phases"]);
  });

  test("enumerates every issue at once instead of stopping at the first", () => {
    expectIssues(
      {
        phases: [
          { name: "" },
          { name: "dup" },
          { name: "dup", bogus: true },
          "not-an-object",
          { name: "x".repeat(121), parallel: "yes" },
        ],
      },
      [
        "meta.phases[0].name must be a non-empty string",
        'meta.phases[2].name duplicates phase name "dup"',
        'meta.phases[2] has unknown key "bogus"',
        "meta.phases[3] must be an object",
        "meta.phases[4].name must be at most 120 characters",
        "meta.phases[4].parallel must be a boolean",
      ]
    );
  });

  test("rejects invalid label and over-length description", () => {
    expectIssues(
      {
        phases: [
          { name: "a", label: 5 },
          { name: "b", description: "d".repeat(501) },
        ],
      },
      [
        "meta.phases[0].label must be a non-empty string",
        "meta.phases[1].description must be at most 500 characters",
      ]
    );
  });
});
