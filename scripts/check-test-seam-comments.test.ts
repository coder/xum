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

test("coalesces a phrase split across consecutive // comments", () => {
  expect(seams("// Pure helper. Exported for\n// tests.\nexport const a = 1;")).toEqual(["1:a"]);
  // A trailing comment on a code line does not merge with the block below it.
  expect(seams("const x = 1; // Exported for\n// tests.\nexport const a = x;")).toEqual([]);
});

test("keys comments on export clauses by the exported names", () => {
  expect(
    seams("function a() {}\nfunction b() {}\n// Exported for tests.\nexport { a, b as c };")
  ).toEqual(["3:a,c"]);
});

test("matches unit/integration qualifiers after used in/by/for", () => {
  expect(seams("// Used only by unit tests.\nexport const a = 1;")).toEqual(["1:a"]);
  expect(seams("// used in integration tests\nexport const b = 1;")).toEqual(["1:b"]);
});

test("matches honest phrasings without the word test in the seam claim", () => {
  expect(
    seams("class Lock {\n  /** No production caller: kept as an observable. */\n  count() {}\n}")
  ).toEqual(["2:Lock.count"]);
  expect(seams("// Has no non-test consumers.\nexport const a = 1;")).toEqual(["1:a"]);
  expect(
    seams("/** `timeoutMs` is overridable for tests only. */\nexport function b() {}")
  ).toEqual(["1:b"]);
  // Descriptive uses stay quiet.
  expect(seams("// No production data leaves this process.\nexport const c = 1;")).toEqual([]);
  expect(seams("// No production callers pass null here.\nexport const e = 1;")).toEqual([]);
  expect(seams("// Some focused tests only need metadata.\nexport const d = 1;")).toEqual([]);
});

test("keys comments on star re-exports by module or namespace", () => {
  expect(seams('// Exported for tests.\nexport * from "./a";')).toEqual(["1:* from ./a"]);
  expect(seams('// Exported for tests.\nexport * as ns from "./a";')).toEqual(["1:ns"]);
});

test("matches slash-qualified test visibility wording", () => {
  expect(
    seams("class A {\n  /** Test/debug visibility only. */\n  get b() { return 1; }\n}")
  ).toEqual(["2:A.b"]);
  expect(seams("// Grants hook visibility only.\nexport const c = 1;")).toEqual([]);
});

test("ignores comment-like text inside regex literals and JSX text", () => {
  expect(seams("const marker = /\\/\\/ Exported for tests/;\nexport const a = marker;")).toEqual(
    []
  );
  expect(seams("export const B = () => <p>// Exported for tests</p>;", "src/x.tsx")).toEqual([]);
});

test("keys comments on destructured declarations by the bound names", () => {
  expect(seams("// Exported for tests.\nexport const { a, b: c, ...rest } = x;")).toEqual([
    "1:a,c,rest",
  ]);
  expect(seams("// Exported for tests.\nexport const [d, , [e]] = y;")).toEqual(["1:d,e"]);
});

test("parses shipped JavaScript with the JS script kind", () => {
  // JS allows JSX, so this is JSX text; parsed as TS it would be a type assertion + comment.
  const text = "export const p = <p>// Exported for tests</p>;";
  expect(seams(text, "src/x.js")).toEqual([]);
  expect(seams(text, "src/x.ts")).toEqual(["1:p"]);
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
    "src/node/builtinSkills/deep-research/workflow.js",
    "src/browser/features/Analytics/sqlExplorerSampleQueryRunner.cjs",
    "src/browser/hooks/useMCPTestCache.ts",
    "src/node/services/replay/replayFixtureNotes.ts",
  ];
  const nonProduction = [
    "src/node/services/aiService.test.ts",
    "src/node/workflowRuntime/runtime.test.mjs",
    "src/browser/stories/mocks/data.js",
    "src/node/services/aiService.md",
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
  const result = checkSeamComments(
    comments,
    { allowed: [entry("listed"), entry("gone")], knownDebt: [entry("listed")] },
    ["src/a.ts#listed"]
  );
  expect(result.unlisted.map((comment) => comment.symbol)).toEqual(["fresh"]);
  expect(result.stale.map((stale) => stale.symbol)).toEqual(["gone"]);
  expect(result.duplicates.map((duplicate) => duplicate.symbol)).toEqual(["listed"]);
});

test("knownDebt must match the frozen baseline exactly", () => {
  const comments = [
    { file: "src/a.ts", line: 1, symbol: "old", phrase: "Test seam" },
    { file: "src/a.ts", line: 5, symbol: "new", phrase: "Test seam" },
  ];
  const entry = (symbol: string) => ({ file: "src/a.ts", symbol, reason: "r" });
  const result = checkSeamComments(
    comments,
    { allowed: [], knownDebt: [entry("old"), entry("new")] },
    ["src/a.ts#old", "src/a.ts#fixed"]
  );
  expect(result.unlisted).toEqual([]);
  expect(result.unfrozenDebt.map((debt) => debt.symbol)).toEqual(["new"]);
  expect(result.thawedDebt).toEqual(["src/a.ts#fixed"]);
});
