#!/usr/bin/env bun
/**
 * Fails when a production source file carries a comment that declares a test seam
 * ("Exported for tests", "Test seam", "test-only: ...") on a symbol that is not in
 * scripts/check-test-seam-comments.allowlist.json.
 *
 * Why: the 2026-09 test audit found production exports and options that existed only
 * so tests could reach private state. Such seams couple tests to internals and ship
 * dead surface. New seams must either get a production caller (then allowlist them
 * with that caller as the reason) or move into test support code.
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
  // "Used for testing.", "(used by tests)", "Used in tests to reset ...".
  /\bused\s+(?:only\s+)?(?:in|by|for)\s+(?:tests?|testing)\b/i,
  // "Test seam", "test seams", "@VisibleForTesting".
  /\btest[- ]?seams?\b/i,
  /\bvisibleForTesting\b/i,
  // "Test-only: reset ...", "(test-only, not for production use)", "Test-only seams".
  /\btest[- ]only(?:\s*[:,)]|\s+seams?\b)/i,
];

export const ALLOWLIST_PATH = "scripts/check-test-seam-comments.allowlist.json";

/**
 * Production source = src/**\/*.{ts,tsx} minus tests, test support, stories and
 * generated files. Paths are repo-relative with forward slashes.
 */
export function isProductionSource(relPath: string): boolean {
  if (!relPath.startsWith("src/") || !/\.tsx?$/.test(relPath)) return false;
  const segments = relPath.split("/");
  const base = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  // Test and support directories, including Storybook mocks under src/browser/stories/.
  const supportDirs = ["__tests__", "__mocks__", "test", "tests", "testing", "mocks", "stories"];
  if (dirs.some((dir) => supportDirs.includes(dir))) return false;
  // foo.test.ts, foo.spec.ts, foo.testHarness.ts, foo.testUtils.ts, foo.testChild.ts,
  // foo.test-fixture.ts, foo.stories.tsx, foo.generated.ts.
  if (/\.(?:test|spec)[\w-]*\.tsx?$/.test(base)) return false;
  if (/\.(?:stories|generated)\.tsx?$/.test(base)) return false;
  // testUtils.ts, testHelpers.ts, testRemoteRuntime.ts, test-isolation.d.ts.
  if (/^test(?:[A-Z_.-])/.test(base)) return false;
  // refinementTestHelpers.ts, fileLockTestHelpers.ts, workspaceStoreTestOverlay.ts,
  // GoogleSearchToolCall.fixtures.ts, DesktopBridgeServer.nodeFixture.ts.
  if (/Test(?:Helpers?|Harness|Utils|Fixtures?|Overlay|Child)\b/.test(base)) return false;
  if (/\.(?:\w*[fF]ixtures?)\.tsx?$/.test(base)) return false;
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

function declarationName(node: ts.Node): string | undefined {
  if (ts.isVariableStatement(node)) return declarationName(node.declarationList);
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

/** Finds seam comments in one file. `file` is only used for reporting and TSX detection. */
export function findSeamComments(file: string, text: string): SeamComment[] {
  // Cheap prefilter: most files never mention a seam phrase anywhere.
  if (firstMatch(commentBody(text)) === undefined) return [];
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  // Every comment is leading trivia of some token (or trailing trivia on its line), so
  // visiting all tokens finds all comments. The deepest node wins as the owner.
  const owners = new Map<number, { range: ts.CommentRange; owner: ts.Node }>();
  const record = (ranges: ts.CommentRange[] | undefined, owner: ts.Node) => {
    for (const range of ranges ?? []) owners.set(range.pos, { range, owner });
  };
  const visit = (node: ts.Node) => {
    record(ts.getLeadingCommentRanges(text, node.pos), node);
    record(ts.getTrailingCommentRanges(text, node.end), node);
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);

  const found: SeamComment[] = [];
  for (const { range, owner } of owners.values()) {
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
 * `allowed`: seams with a production caller (named in the reason) or ...ForTests reset hooks.
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
}

export function checkSeamComments(
  comments: readonly SeamComment[],
  allowlist: Allowlist
): CheckResult {
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
  };
}

function main(): number {
  const root = path.resolve(import.meta.dir, "..");
  const files = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })]
    .map((file) => file.split(path.sep).join("/"))
    .filter(isProductionSource)
    .sort();
  assert(files.length > 100, `expected production sources under src/, found ${files.length}`);

  const comments = files.flatMap((file) =>
    findSeamComments(file, readFileSync(path.join(root, file), "utf8"))
  );
  const allowlist = parseAllowlist(
    JSON.parse(readFileSync(path.join(root, ALLOWLIST_PATH), "utf8")) as unknown
  );
  const { unlisted, stale, duplicates } = checkSeamComments(comments, allowlist);

  const tag = "check-test-seam-comments:";
  for (const comment of unlisted) {
    console.error(
      `${tag} ${comment.file}:${comment.line} test-seam comment on \`${comment.symbol}\` ("${comment.phrase}")`
    );
  }
  if (unlisted.length > 0) {
    console.error(
      [
        "",
        "Production code should not grow exports or options that only tests use.",
        "Test through a public API, or move the helper into a test support file.",
        `If the symbol has a production caller (or is a clearly named ...ForTests reset hook),`,
        `add it to "allowed" in ${ALLOWLIST_PATH} and name that caller in the reason`,
        `("knownDebt" is a shrink-only baseline; do not add to it):`,
        ...unlisted.map(
          (comment) =>
            `  { "file": "${comment.file}", "symbol": "${comment.symbol}", "reason": "<production caller>" }`
        ),
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
  return unlisted.length + stale.length + duplicates.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main());
}
