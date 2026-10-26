#!/usr/bin/env bun
/**
 * Fails when a production source file carries a comment that declares a test seam
 * ("Exported for tests", "Test seam", "test-only: ...") or declares a symbol named
 * `...ForTests`/`...ForTesting`, when that symbol is not in
 * scripts/check-test-seam-comments.allowlist.json.
 *
 * Why: the 2026-09 test audit found production exports and options that existed only
 * so tests could reach private state. Such seams couple tests to internals and ship
 * dead surface. New seams must either get a production caller (then allowlist them
 * with that caller as the reason), be a deliberate injection point (allowlist them
 * with the contract the test witnesses through it), or move into test support code.
 *
 * Entries are keyed by file + symbol, not line numbers, so unrelated edits don't
 * break them. An entry that no longer matches any comment fails too, so the list
 * only shrinks when seams go away.
 *
 * Usage: bun scripts/check-test-seam-comments.ts   (or `make check-test-seam-comments`)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Case-insensitive phrases that declare a comment's subject exists for tests.
 * Deliberately excluded after surveying src/: bare "for testing" / "useful for
 * testing" (mostly debug features such as "trigger an artificial stream error for
 * testing recovery", or design notes like "pure for easy testing"), and "test-only"
 * used as an adjective about test code elsewhere ("builds a narrow test-only context").
 */
export const SEAM_COMMENT_PATTERNS: readonly RegExp[] = [
  // "Exported for tests", "exported for unit testing", "exposed only for tests",
  // "Exported for tests only", "visible for testing".
  /\b(?:exported|exposed|visible)\s+(?:only\s+)?for\s+(?:unit\s+|integration\s+)?(?:tests?|testing)\b/i,
  // "Used for testing.", "(used by tests)", "Used in tests to reset ...", "used only by unit tests".
  // A negated claim ("must never be used in tests") says the opposite, so it stays quiet.
  /(?<!\b(?:not|never)\s+(?:be\s+|been\s+)?)\bused\s+(?:only\s+)?(?:in|by|for)\s+(?:unit\s+|integration\s+)?(?:tests?|testing)\b/i,
  // "Test seam", "test seams", "@VisibleForTesting".
  /\btest[- ]?seams?\b/i,
  /\bvisibleForTesting\b/i,
  // "Test/debug visibility only.", "Test visibility only".
  /\btests?(?:\/debug)?\s+visibility\s+only\b/i,
  // "Test-only: reset ...", "(test-only, not for production use)", "Test-only seams".
  /\btest[- ]only(?:\s*[:,)]|\s+seams?\b)/i,
  // Honest phrasings that say the same thing without "test": "No production caller: ...",
  // "Has no non-test consumers." The claim must be a whole sentence (start of the comment or
  // after a full stop, ending at . or : or the comment end), so invariants such as "No
  // production callers pass null" or "Skip delivery (no production consumers)" stay quiet.
  /(?:^|[.!?]\s)\s*(?:has\s+)?no\s+(?:production|non-test)\s+(?:callers?|consumers?)(?=\s*(?:[.:]|$))/i,
  // "overridable for tests only", "set by tests only". The seam verb is required so behavior
  // notes such as "runs in tests only when isolation is enabled" stay quiet.
  /\b(?:overridable|overridden|settable|set|passed|injected|kept)\s+(?:for|by|in)\s+tests\s+only\b/i,
  // "Override for tests; production reads ...", "Overrides for tests only".
  /\boverrides?\s+(?:only\s+)?for\s+(?:unit\s+|integration\s+)?tests\b/i,
  // "Shorten the idle window in tests". Bare "in tests" is common prose ("a TestClock in tests",
  // "spied/overridden in tests", "a no-op in tests/CI"), so the claim must open its sentence with
  // a seam verb, and "tests/" or "tests-" (a list or a compound) does not count.
  /(?:^|[.!?]\s)\s*(?:shorten|lengthen|override|replace|stub|inject|reset|force)s?\b[^.!?]{0,80}?\bin\s+(?:unit\s+|integration\s+)?tests\b(?![/-])/i,
  // "Useful in tests for checking ...", "needed only in tests".
  // "This callback must never be called in tests" is negated, so it stays quiet.
  /(?<!\b(?:not|never)\s+(?:be\s+|been\s+)?)\b(?:useful|needed|called|invoked)\s+(?:only\s+)?in\s+(?:unit\s+|integration\s+)?tests\b(?![/-])/i,
  // The test-double claims must open a sentence: the double is the subject of the claim, so prose
  // such as "defaults for fields absent from test doubles", "not absent from test doubles",
  // "test doubles never pass it" or "test doubles record each render pass" stays quiet.
  // "Absent on test doubles", "Absent from a test double": the member is optional only so doubles
  // can leave it out.
  /(?:^|[.!?]\s)\s*absent\s+(?:on|from|in)\s+(?:a\s+)?test\s+doubles?\b/i,
  // "Test doubles of AIService pass one too", "A test double passes runtimeFactory": the member
  // exists so doubles can supply it. "Test doubles pass the contract tests" is about tests.
  /(?:^|[.!?]\s)\s*(?:a\s+)?test\s+doubles?(?:\s+of\s+[\w.]+)?\s+(?:also\s+)?pass(?:es)?\s+(?!(?:the\s+|their\s+|all\s+)?[\w-]*\s*tests?\b)[\w.]+/i,
];

/**
 * Unanchored twins of the sentence-anchored patterns, used only by the whole-file prefilter
 * (collapsing the whole file loses comment and sentence starts).
 */
const ANCHORED_PATTERN_PREFILTERS: readonly RegExp[] = [
  /\bno\s+(?:production|non-test)\s+(?:callers?|consumers?)\b/i,
  /\bin\s+(?:unit\s+|integration\s+)?tests\b/i,
  /\btest\s+doubles?\b/i,
];

/**
 * Declarations named like a test hook (`resetForTests`, `setIdleTimeoutMsForTests`,
 * `visibleForTesting`) are seams by name, comment or not, so each needs an allowlist entry too.
 */
export const TEST_HOOK_NAME = /For(?:Tests|Testing)$/;

export const ALLOWLIST_PATH = "scripts/check-test-seam-comments.allowlist.json";

/**
 * The `knownDebt` keys (file#symbol) as of this guard landing. `knownDebt` must list exactly
 * these keys, so the baseline can only shrink: fixing a seam removes its entry here and in the
 * JSON file. Never add a key here; give a new seam a production caller or remove it instead.
 */
export const FROZEN_KNOWN_DEBT: readonly string[] = [];

/** .ts, .tsx, .mts, .cts, .js, .jsx, .mjs and .cjs. */
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
export const SOURCE_GLOB = "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * Production source = SOURCE_GLOB minus tests, test support, stories and
 * generated files. Paths are repo-relative with forward slashes.
 */
export function isProductionSource(relPath: string): boolean {
  // Shipped JavaScript counts too (builtin skill workflows, the workflow runtime stdlib).
  if (!relPath.startsWith("src/") || !SOURCE_EXTENSION.test(relPath)) return false;
  const segments = relPath.split("/");
  const base = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  // Test and support directories, including Storybook mocks under src/browser/stories/.
  const supportDirs = ["__tests__", "__mocks__", "test", "tests", "testing", "mocks", "stories"];
  if (dirs.some((dir) => supportDirs.includes(dir))) return false;
  // foo.test.ts, foo.spec.ts, foo.testHarness.ts, foo.testUtils.ts, foo.testChild.ts,
  // foo.test-fixture.ts, foo.stories.tsx, foo.generated.ts.
  if (/\.(?:test|spec)[\w-]*\.[cm]?[jt]sx?$/.test(base)) return false;
  if (/\.(?:stories|generated)\.[cm]?[jt]sx?$/.test(base)) return false;
  // testUtils.ts, testHelpers.ts, testRemoteRuntime.ts, test-isolation.d.ts.
  if (/^test(?:[A-Z_.-])/.test(base)) return false;
  // refinementTestHelpers.ts, fileLockTestHelpers.ts, workspaceStoreTestOverlay.ts,
  // GoogleSearchToolCall.fixtures.ts, DesktopBridgeServer.nodeFixture.ts.
  if (/Test(?:Helpers?|Harness|Utils|Fixtures?|Overlay|Child)\b/.test(base)) return false;
  if (/\.(?:\w*[fF]ixtures?)\.[cm]?[jt]sx?$/.test(base)) return false;
  // Generated at build time (see Makefile's version target).
  if (relPath === "src/version.ts") return false;
  return true;
}

export interface SeamComment {
  file: string;
  /** 1-based line where the comment starts. */
  line: number;
  /** Dotted chain of the named declarations that own the comment, or "(file)". */
  symbol: string;
  /** The phrase that matched. */
  phrase: string;
}

/** Collapses comment markers and line breaks so phrases split across lines still match. */
function commentBody(raw: string): string {
  return raw
    .replace(/^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+)?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

function firstMatch(body: string): string | undefined {
  for (const pattern of SEAM_COMMENT_PATTERNS) {
    const match = pattern.exec(body);
    if (match) return match[0];
  }
  return undefined;
}

/** Names bound by `{ a, b: c }` / `[d, [e]]` patterns, in source order. */
function boundNames(pattern: ts.BindingPattern): string[] {
  return pattern.elements.flatMap((element) => {
    if (ts.isOmittedExpression(element)) return [];
    return ts.isIdentifier(element.name) ? [element.name.text] : boundNames(element.name);
  });
}

function declarationName(node: ts.Node): string | undefined {
  // `const { a, b: c } = x` / `const [d, e] = y` bind several names; key by all of them.
  if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
    const names = boundNames(node.name);
    return names.length > 0 ? names.join(",") : undefined;
  }
  if (ts.isVariableStatement(node)) return declarationName(node.declarationList);
  // `export { a, b as c }` has no declaration name; key it by the exported names.
  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
    const names = node.exportClause.elements.map((element) => element.name.text);
    return names.length > 0 ? names.join(",") : undefined;
  }
  // `export * from "./a"` re-exports a module; `export * as ns from "./a"` names it.
  if (ts.isExportDeclaration(node) && node.exportClause === undefined && node.moduleSpecifier) {
    return ts.isStringLiteral(node.moduleSpecifier)
      ? `* from ${node.moduleSpecifier.text}`
      : undefined;
  }
  if (
    ts.isExportDeclaration(node) &&
    node.exportClause &&
    ts.isNamespaceExport(node.exportClause)
  ) {
    return node.exportClause.name.text;
  }
  if (ts.isExportAssignment(node)) return "default";
  if (ts.isVariableDeclarationList(node)) {
    const first = node.declarations[0];
    return first === undefined ? undefined : declarationName(first);
  }
  const name = (node as { name?: ts.Node }).name;
  if (name === undefined) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function symbolChain(owner: ts.Node): string {
  const names: string[] = [];
  let seenDeclarationList = false;
  for (let node: ts.Node | undefined = owner; node && !ts.isSourceFile(node); node = node.parent) {
    // A VariableStatement and its list name the same declaration; count it once.
    if (ts.isVariableStatement(node) && seenDeclarationList) continue;
    if (ts.isVariableDeclarationList(node)) seenDeclarationList = true;
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
      seenDeclarationList = true;
    }
    const name = declarationName(node);
    if (name !== undefined && names[0] !== name) names.unshift(name);
  }
  return names.length > 0 ? names.join(".") : "(file)";
}

interface OwnedComment {
  range: ts.CommentRange;
  owner: ts.Node;
}

/**
 * Merges runs of `//` comments on consecutive lines into one range so a phrase split
 * across them ("// Exported for" + "// tests.") still matches. A run starts only at a
 * comment that begins its line; a trailing `code; // ...` comment stays on its own so
 * the next line's block isn't attributed to that code. The run keeps its first owner.
 */
function coalesceLineComments(text: string, comments: OwnedComment[]): OwnedComment[] {
  const sorted = [...comments].sort((a, b) => a.range.pos - b.range.pos);
  const merged: OwnedComment[] = [];
  const startsLine = (pos: number) =>
    text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos).trim() === "";
  for (const comment of sorted) {
    const previous = merged[merged.length - 1];
    const isLine = comment.range.kind === ts.SyntaxKind.SingleLineCommentTrivia;
    if (
      previous !== undefined &&
      isLine &&
      previous.range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      startsLine(previous.range.pos) &&
      /^[ \t]*\r?\n[ \t]*$/.test(text.slice(previous.range.end, comment.range.pos))
    ) {
      previous.range = { ...previous.range, end: comment.range.end };
      continue;
    }
    merged.push({ range: { ...comment.range }, owner: comment.owner });
  }
  return merged;
}

function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

/**
 * Returns why `tsModule` cannot parse sources, or undefined when it can. Without an install,
 * Bun resolves `typescript` to a built-in stub that has only `version`, and the scan would
 * crash on `ts.ScriptTarget`.
 */
export function typescriptProblem(tsModule: unknown): string | undefined {
  const candidate = tsModule as Partial<typeof ts> | undefined;
  if (typeof candidate?.createSourceFile === "function") return undefined;
  return "the typescript package is not installed (Bun loaded a stub without its parser); run `bun install --frozen-lockfile` first";
}

/** Declarations that put a name on a module, class, object or type surface. */
function isSurfaceDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isExportSpecifier(node) ||
    // `constructor(public resetForTests: () => void)` declares a class property.
    (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent))
  );
}

/**
 * For a name bound by `export const { aForTests } = api`, the variable declaration that binds
 * it. Exporting puts the name on the module surface, so it is a declaration, while the same
 * destructuring without `export` only uses `api.aForTests`.
 */
function exportedBindingDeclaration(node: ts.Node): ts.VariableDeclaration | undefined {
  if (!ts.isBindingElement(node)) return undefined;
  let parent: ts.Node = node.parent;
  while (
    ts.isBindingElement(parent) ||
    ts.isObjectBindingPattern(parent) ||
    ts.isArrayBindingPattern(parent)
  ) {
    parent = parent.parent;
  }
  if (!ts.isVariableDeclaration(parent)) return undefined;
  const statement = parent.parent.parent;
  const exported =
    ts.isVariableStatement(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return exported ? parent : undefined;
}

/** The nearest ancestor of a declaration that is not its own variable list or statement. */
function enclosingDeclaration(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (
    ts.isVariableDeclarationList(parent) ||
    ts.isVariableStatement(parent) ||
    ts.isNamedExports(parent) ||
    ts.isExportDeclaration(parent)
  ) {
    parent = parent.parent;
  }
  return parent;
}

/** The static text of a declaration name: `a`, `#a`, `"a"` or `["a"]`. */
function staticName(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * Finds declarations whose name ends in ForTests/ForTesting. The phrase is the name, so the
 * report says why the symbol matched. Call sites (`pool.resetForTests()`), imports and
 * destructured bindings are uses, not declarations, so they do not count.
 */
export function findTestHookNames(file: string, text: string): SeamComment[] {
  if (!/For(?:Tests|Testing)\b/.test(text)) return [];
  const sourceFile = parseSource(file, text);
  const found: SeamComment[] = [];
  const visit = (node: ts.Node) => {
    const binding = exportedBindingDeclaration(node);
    const name =
      isSurfaceDeclaration(node) || binding !== undefined
        ? staticName((node as ts.NamedDeclaration).name)
        : undefined;
    if (name !== undefined && TEST_HOOK_NAME.test(name)) {
      // Key by the enclosing declarations plus this name: symbolChain would name a variable by
      // its list's first declarator (`const first = 1, aForTests = ...`) and drops computed
      // names (`["aForTests"]()`).
      const owner = symbolChain(enclosingDeclaration(binding ?? node));
      found.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        symbol: owner === "(file)" ? name : `${owner}.${name}`,
        phrase: name,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Finds seam comments in one file. `file` is only used for reporting and TSX detection. */
export function findSeamComments(file: string, text: string): SeamComment[] {
  // Cheap prefilter: most files never mention a seam phrase anywhere.
  const fileBody = commentBody(text);
  if (
    firstMatch(fileBody) === undefined &&
    !ANCHORED_PATTERN_PREFILTERS.some((pattern) => pattern.test(fileBody))
  ) {
    return [];
  }
  const sourceFile = parseSource(file, text);
  // Every comment is leading trivia of some token (or trailing trivia on its line), so
  // visiting all tokens finds all comments. The deepest node wins as the owner.
  const owners = new Map<number, { range: ts.CommentRange; owner: ts.Node }>();
  const record = (ranges: ts.CommentRange[] | undefined, owner: ts.Node) => {
    for (const range of ranges ?? []) owners.set(range.pos, { range, owner });
  };
  // Trivia scans can wander into token text that looks like a comment (JSX text such as
  // `<p>// note</p>`), so keep only ranges that start outside every token.
  const tokenSpans: Array<[start: number, end: number]> = [];
  const visit = (node: ts.Node) => {
    // JSDoc nodes are parsed comment contents, not tokens; their owner records the comment.
    if (ts.isJSDoc(node)) return;
    record(ts.getLeadingCommentRanges(text, node.pos), node);
    record(ts.getTrailingCommentRanges(text, node.end), node);
    const children = node.getChildren(sourceFile);
    if (children.length === 0 && node.end > node.pos) {
      tokenSpans.push([node.getStart(sourceFile), node.end]);
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  const insideToken = (pos: number) => {
    // Leaves are visited in source order, so spans are sorted by start.
    let low = 0;
    let high = tokenSpans.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const [start, end] = tokenSpans[mid];
      if (pos < start) high = mid - 1;
      else if (pos >= end) low = mid + 1;
      else return true;
    }
    return false;
  };
  for (const pos of [...owners.keys()]) {
    if (insideToken(pos)) owners.delete(pos);
  }

  const found: SeamComment[] = [];
  for (const { range, owner } of coalesceLineComments(text, [...owners.values()])) {
    const phrase = firstMatch(commentBody(text.slice(range.pos, range.end)));
    if (phrase === undefined) continue;
    found.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
      symbol: symbolChain(owner),
      phrase,
    });
  }
  return found.sort((a, b) => a.line - b.line);
}

export interface AllowlistEntry {
  file: string;
  symbol: string;
  reason: string;
}

/**
 * `allowed`: seams with a production caller (named in the reason), ...ForTests reset hooks, or
 * deliberate injection points: a clock/timer/transport injection that keeps a test fast and
 * deterministic, an interleaving hook that is the only way to witness an ordering contract, or a
 * read-only observation getter that is the only way to witness a retention contract.
 * The reason names the test and the contract it witnesses.
 * `knownDebt`: seams that existed without a production caller when this guard landed. It may
 * only shrink; do not add to it.
 */
export interface Allowlist {
  allowed: AllowlistEntry[];
  knownDebt: AllowlistEntry[];
}

function parseEntries(json: unknown, list: string): AllowlistEntry[] {
  assert(Array.isArray(json), `${ALLOWLIST_PATH}: "${list}" must be an array`);
  return json.map((entry: unknown, index) => {
    const { file, symbol, reason } = (entry ?? {}) as Record<string, unknown>;
    const where = `${ALLOWLIST_PATH}: ${list}[${index}]`;
    assert(typeof file === "string" && file.length > 0, `${where}.file must be a string`);
    assert(typeof symbol === "string" && symbol.length > 0, `${where}.symbol must be a string`);
    assert(typeof reason === "string" && reason.trim().length > 0, `${where}.reason is required`);
    return { file, symbol, reason };
  });
}

export function parseAllowlist(json: unknown): Allowlist {
  assert(typeof json === "object" && json !== null, `${ALLOWLIST_PATH} must be a JSON object`);
  const { allowed, knownDebt } = json as Record<string, unknown>;
  return {
    allowed: parseEntries(allowed, "allowed"),
    knownDebt: parseEntries(knownDebt, "knownDebt"),
  };
}

const entryKey = (entry: { file: string; symbol: string }) => `${entry.file}#${entry.symbol}`;

export interface CheckResult {
  unlisted: SeamComment[];
  stale: AllowlistEntry[];
  duplicates: AllowlistEntry[];
  /** `knownDebt` entries missing from the frozen baseline (new debt). */
  unfrozenDebt: AllowlistEntry[];
  /** Frozen keys no longer in `knownDebt`; remove them from FROZEN_KNOWN_DEBT too. */
  thawedDebt: string[];
}

export function checkSeamComments(
  comments: readonly SeamComment[],
  allowlist: Allowlist,
  frozenDebt: readonly string[] = FROZEN_KNOWN_DEBT
): CheckResult {
  const frozen = new Set(frozenDebt);
  const debtKeys = new Set(allowlist.knownDebt.map(entryKey));
  const listed = new Map<string, AllowlistEntry>();
  const duplicates: AllowlistEntry[] = [];
  for (const entry of [...allowlist.allowed, ...allowlist.knownDebt]) {
    if (listed.has(entryKey(entry))) duplicates.push(entry);
    listed.set(entryKey(entry), entry);
  }
  const matchedKeys = new Set(comments.map(entryKey));
  return {
    unlisted: comments.filter((comment) => !listed.has(entryKey(comment))),
    stale: [...listed.values()].filter((entry) => !matchedKeys.has(entryKey(entry))),
    duplicates,
    unfrozenDebt: allowlist.knownDebt.filter((entry) => !frozen.has(entryKey(entry))),
    thawedDebt: [...frozen].filter((key) => !debtKeys.has(key)),
  };
}

function main(): number {
  const tag = "check-test-seam-comments:";
  const problem = typescriptProblem(ts);
  if (problem !== undefined) {
    console.error(`${tag} ${problem}`);
    return 2;
  }
  const root = path.resolve(import.meta.dir, "..");
  const files = [...new Bun.Glob(SOURCE_GLOB).scanSync({ cwd: root })]
    .map((file) => file.split(path.sep).join("/"))
    .filter(isProductionSource)
    .sort();
  assert(files.length > 100, `expected production sources under src/, found ${files.length}`);

  const comments = files.flatMap((file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    return [...findSeamComments(file, text), ...findTestHookNames(file, text)];
  });
  const allowlist = parseAllowlist(
    JSON.parse(readFileSync(path.join(root, ALLOWLIST_PATH), "utf8")) as unknown
  );
  const { unlisted, stale, duplicates, unfrozenDebt, thawedDebt } = checkSeamComments(
    comments,
    allowlist
  );

  for (const comment of unlisted) {
    const what = TEST_HOOK_NAME.test(comment.phrase) ? "test-hook name" : "test-seam comment";
    console.error(
      `${tag} ${comment.file}:${comment.line} ${what} on \`${comment.symbol}\` ("${comment.phrase}")`
    );
  }
  if (unlisted.length > 0) {
    console.error(
      [
        "",
        "Production code should not grow exports or options that only tests use.",
        "Test through a public API, or move the helper into a test support file.",
        `If the symbol has a production caller, is a clearly named ...ForTests reset hook, is a`,
        `deliberate clock/timer/transport or interleaving injection point, or is a read-only getter`,
        `that is the only witness of a retention contract, add it to "allowed" in`,
        `${ALLOWLIST_PATH} and name that caller (or the test and the contract it witnesses) in the reason`,
        `("knownDebt" is a shrink-only baseline; do not add to it):`,
        // A symbol can match by comment and by name; suggest one entry for it.
        ...[...new Set(unlisted.map(entryKey))].map((key) => {
          // Split at the first "#": a symbol can be a #private name.
          const at = key.indexOf("#");
          const file = key.slice(0, at);
          const symbol = key.slice(at + 1);
          return `  { "file": "${file}", "symbol": "${symbol}", "reason": "<production caller, or the test and the contract it witnesses>" }`;
        }),
      ].join("\n")
    );
  }
  for (const entry of stale) {
    console.error(
      `${tag} stale allowlist entry ${entryKey(entry)}: no test-seam comment matches it any more; remove it from ${ALLOWLIST_PATH}`
    );
  }
  for (const entry of duplicates) {
    console.error(`${tag} duplicate allowlist entry ${entryKey(entry)} in ${ALLOWLIST_PATH}`);
  }
  for (const entry of unfrozenDebt) {
    console.error(
      `${tag} new knownDebt entry ${entryKey(entry)}: knownDebt only shrinks; give the seam a production caller and list it under "allowed", or remove the seam`
    );
  }
  for (const key of thawedDebt) {
    console.error(
      `${tag} ${key} left knownDebt; remove it from FROZEN_KNOWN_DEBT in scripts/check-test-seam-comments.ts too`
    );
  }
  const failures =
    unlisted.length + stale.length + duplicates.length + unfrozenDebt.length + thawedDebt.length;
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main());
}
