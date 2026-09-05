import { describe, expect, test } from "bun:test";

import {
  parseDeclaredPhases,
  parseDeclaredPhasesFromSource,
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

describe("parseDeclaredPhasesFromSource", () => {
  const body = 'export default function workflow({ phase }) { phase("a"); return {}; }\n';

  test("returns undefined when the script declares no meta at all", () => {
    expect(parseDeclaredPhasesFromSource(body)).toBeUndefined();
  });

  test("returns undefined for a static meta without phases", () => {
    expect(
      parseDeclaredPhasesFromSource('export const meta = { description: "x" };\n' + body)
    ).toBeUndefined();
  });

  test("reads phases from a static meta", () => {
    expect(
      parseDeclaredPhasesFromSource('export const meta = { phases: [{ name: "a" }] };\n' + body)
    ).toEqual([{ name: "a" }]);
  });

  test("rejects a declared meta the static parser cannot read instead of treating it as absent", () => {
    // Shorthand property referencing a runtime binding: `meta` exists, so a
    // silently-ignored `phases` would run undeclared without telling the author.
    const source = 'const phases = [{ name: "a" }];\nexport const meta = { phases };\n' + body;
    try {
      parseDeclaredPhasesFromSource(source);
      expect.unreachable("non-static meta must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowDeclaredPhasesValidationError);
      expect((error as WorkflowDeclaredPhasesValidationError).issues).toHaveLength(1);
      expect(String(error)).toContain("static object literal");
    }
    // The lenient reader still degrades to null for the same source, so the two
    // must not be conflated by callers.
    expect(parseWorkflowMetadata(source)).toBeNull();
  });
});

describe("meta declaration detection after a block statement", () => {
  const body = 'export default function workflow({ phase }) { phase("a"); return {}; }\n';

  test("a static meta following a same-line block is still parsed", () => {
    const source =
      'const ready = true; if (ready) {} export const meta = { phases: [{ name: "a" }] };\n' + body;
    expect(parseDeclaredPhasesFromSource(source)).toEqual([{ name: "a" }]);
  });

  test("a non-static meta following a same-line block is rejected, not treated as absent", () => {
    const source =
      'const phases = [{ name: "a" }]; if (phases) {} export const meta = { phases };\n' + body;
    expect(() => parseDeclaredPhasesFromSource(source)).toThrow(
      WorkflowDeclaredPhasesValidationError
    );
  });

  test("a meta declaration nested inside a block is not a top-level declaration", () => {
    const source = "if (true) { const meta = { phases: [] }; }\n" + body;
    expect(parseDeclaredPhasesFromSource(source)).toBeUndefined();
  });
});
