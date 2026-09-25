// Tests for scripts/check-test-seam-comments.ts. `make check-test-seam-comments`
// runs this file before the real check (scripts/ tests are not part of the
// `bun test src` lane).
import { expect, test } from "bun:test";
import {
  checkSeamComments,
  findSeamComments,
  isProductionSource,
} from "./check-test-seam-comments";

const seams = (text: string, file = "src/x.ts") =>
  findSeamComments(file, text).map((comment) => `${comment.line}:${comment.symbol}`);

test("attributes seam comments to the declaration they document", () => {
  const text = [
    "/** Pure helper. Exported for tests. */",
    "export function helper() {}",
    "export interface Options {",
    "  /**",
    "   * Test seam.",
    "   */",
    "  sleep?: () => void;",
    "  other?: number; // exposed only for testing",
    "}",
    "class Pool {",
    "  // Used in tests to reset state.",
    "  clear() {}",
    "}",
    "// test-only: reset",
    "export const resetForTests = () => {};",
  ].join("\n");
  expect(seams(text)).toEqual([
    "1:helper",
    "4:Options.sleep",
    "8:Options.other",
    "11:Pool.clear",
    "14:resetForTests",
  ]);
});

test("matches a phrase split across comment lines", () => {
  expect(
    seams("/**\n * Something. Exported for\n * unit testing.\n */\nexport const a = 1;")
  ).toEqual(["1:a"]);
});

test("ignores non-comment text and descriptive uses of the words", () => {
  const text = [
    'const label = "Exported for tests";',
    "// Trigger an artificial stream error for testing recovery.",
    "// Builds a narrow test-only context for the suite.",
    "export const b = label;",
  ].join("\n");
  expect(seams(text)).toEqual([]);
});

test("separates production sources from tests, support code, stories and generated files", () => {
  const production = [
    "src/node/services/aiService.ts",
    "src/browser/hooks/useMCPTestCache.ts",
    "src/node/services/replay/replayFixtureNotes.ts",
  ];
  const nonProduction = [
    "src/node/services/aiService.test.ts",
    "src/node/services/taskService.testHarness.ts",
    "src/node/services/taskWorkspaceSeam.testUtils.ts",
    "src/browser/features/desktop/desktopRfb.test-fixture.ts",
    "src/node/runtime/testRemoteRuntime.ts",
    "src/node/utils/concurrency/fileLockTestHelpers.ts",
    "src/browser/features/Tools/GoogleSearchToolCall.fixtures.ts",
    "src/node/services/__tests__/foo.ts",
    "src/common/utils/testing/fuzzHelpers.ts",
    "src/browser/stories/mocks/orpc.ts",
    "src/browser/App.stories.tsx",
    "src/node/services/agentSkills/builtInSkillContent.generated.ts",
    "src/version.ts",
    "scripts/check-test-seam-comments.ts",
  ];
  expect(production.filter(isProductionSource)).toEqual(production);
  expect(nonProduction.filter(isProductionSource)).toEqual([]);
});

test("reports unlisted comments, stale entries and duplicates", () => {
  const comments = [
    { file: "src/a.ts", line: 1, symbol: "listed", phrase: "Test seam" },
    { file: "src/a.ts", line: 9, symbol: "fresh", phrase: "Test seam" },
  ];
  const entry = (symbol: string) => ({ file: "src/a.ts", symbol, reason: "r" });
  const result = checkSeamComments(comments, {
    allowed: [entry("listed"), entry("gone")],
    knownDebt: [entry("listed")],
  });
  expect(result.unlisted.map((comment) => comment.symbol)).toEqual(["fresh"]);
  expect(result.stale.map((stale) => stale.symbol)).toEqual(["gone"]);
  expect(result.duplicates.map((duplicate) => duplicate.symbol)).toEqual(["listed"]);
});
