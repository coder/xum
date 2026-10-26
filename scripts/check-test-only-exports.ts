#!/usr/bin/env bun
/**
 * Fails when an export of a production file under src/ has no non-test reference: no
 * production file imports it (directly, through a barrel, or as a namespace) and its own file
 * does not use it either. Such an export is either dead or kept alive only by tests, and both
 * ship dead surface. `scripts/check-test-seam-comments.ts` only reads comments, so a feature
 * removal that leaves an uncommented helper behind (the 2026-10 audit found ~8 of them, plus 21
 * exports nothing referenced) passes it; this check sees the references instead.
 *
 * Fix a finding by deleting the export (and the tests that only exercise it), by moving the
 * test to the function production calls, or by dropping `export` when only its own file uses it.
 * If the export must stay, list it under "allowed" in
 * scripts/check-test-only-exports.allowlist.json with a reason: a ...ForTests reset hook, a
 * test-support or story helper, or a consumer outside src/ (scripts/, vscode/, a build config).
 * "pendingDeletion" lists findings that another workstream owns and is deleting. It only
 * shrinks: its keys must equal FROZEN_PENDING_DELETION below.
 *
 * Only production files are parsed (tests never count as references), one at a time, so the
 * check stays fast (about 3 s) and light (under 300 MB).
 *
 * Usage: bun scripts/check-test-only-exports.ts   (or `make check-test-only-exports`)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isProductionSource, SOURCE_GLOB, typescriptProblem } from "./check-test-seam-comments";

export const ALLOWLIST_PATH = "scripts/check-test-only-exports.allowlist.json";

/**
 * The `pendingDeletion` keys (file#symbol). Another workstream owns each one; remove a key here
 * and in the JSON file when its export is gone. Never add a key here.
 */
export const FROZEN_PENDING_DELETION: readonly string[] = [
  "src/browser/features/RightSidebar/ArtifactsTab/artifactDocument.ts#buildSandboxedHtmlDocument",
  "src/browser/features/Settings/Sections/GoalsSection.tsx#GoalsSection",
  "src/browser/hooks/useModelsFromSettings.ts#getSuggestedModels",
  "src/browser/stores/DraftStore.ts#DraftAttachmentMatchesChatAttachment",
  "src/browser/utils/highlighting/highlightDiffChunk.ts#highlightDiffChunk",
  "src/browser/utils/messages/StreamingTPSCalculator.ts#calculateTPS",
  "src/browser/utils/messages/StreamingTPSCalculator.ts#calculateTokenCount",
  "src/browser/utils/messages/StreamingTPSCalculator.ts#DeltaRecord",
  "src/browser/utils/rightSidebarLayout.ts#addToolToFocusedTabset",
  "src/browser/utils/workflowRunMessages.ts#filterWorkflowDisplayOnlyMessages",
  "src/browser/utils/workspaceStorage.ts#migrateWorkspaceStorage",
  "src/cli/serverSecurity.ts#resolveServerAuthToken",
  "src/common/config/schemas/agentPluginInstalls.ts#AgentPluginInstallSource",
  "src/common/config/schemas/providerModelEntry.ts#ProviderModelEntry",
  "src/common/config/schemas/providersConfig.ts#AnthropicSpeed",
  "src/common/config/schemas/providersConfig.ts#FastModePreviousServiceTier",
  "src/common/config/schemas/userPreferences.ts#ThemePreferenceConfig",
  "src/common/constants/storage.ts#WORKSPACE_NAME_STATE_MESSAGE_MAX_CHARS",
  "src/common/constants/storage.ts#WORKSPACE_NAME_STATE_MANUAL_NAME_MAX_CHARS",
  "src/common/constants/storage.ts#PersistedKeyScope",
  "src/common/constants/storage.ts#isCreationDraftStorageGcCandidateKey",
  "src/common/constants/storage.ts#findOrphanedCreationDraftStorageKeys",
  "src/common/orpc/onChatCursorFingerprint.ts#computePriorHistoryFingerprint",
  "src/common/orpc/schemas/analytics.ts#RawQueryColumn",
  "src/common/orpc/schemas/analytics.ts#RawQueryResult",
  "src/common/orpc/schemas/artifacts.ts#ArtifactVersionSource",
  "src/common/orpc/schemas/skillsCli.ts#SkillsCliCommand",
  "src/common/orpc/types.ts#AWSCredentialStatus",
  "src/common/schemas/runtimeEnablement.ts#RuntimeEnablementOverrides",
  "src/common/staticWorkspaceView/phoneChrome.ts#PhoneChrome",
  "src/common/types/evaluation.ts#EvaluationInput",
  "src/common/types/evaluation.ts#EvaluationProviderOptions",
  "src/common/types/keybind.ts#hasModifierKeybind",
  "src/common/types/keybind.ts#normalizeKeybind",
  "src/common/types/review.ts#ReviewState",
  "src/common/types/review.ts#ReviewsState",
  "src/common/types/sessionTape.ts#SessionTapeEventLine",
  "src/common/types/sessionTape.ts#SessionTapeLine",
  "src/common/types/stream.ts#AutoRetryScheduledEvent",
  "src/common/types/stream.ts#AutoRetryStartingEvent",
  "src/common/types/stream.ts#AutoRetryAbandonedEvent",
  "src/common/types/tools.ts#StatusUpdateToolArgs",
  "src/common/utils/drafts.ts#isDraftEmpty",
  "src/common/utils/planReview/planReviewRecord.ts#PlanReviewSnapshotRecord",
  "src/common/utils/planReview/planReviewRecord.ts#PlanReviewFeedbackComment",
  "src/common/utils/planReview/planReviewRecord.ts#PlanReviewFeedbackReply",
  "src/common/utils/planReview/planReviewState.ts#PlanReviewThreadReply",
  "src/common/utils/providerOutputSanitization.ts#sanitizeErrorMessageForDisplay",
  "src/common/utils/providers/customProviders.ts#isValidCustomProviderId",
  "src/common/utils/reviewState.ts#withReviewStateSection",
  "src/common/utils/skills/skillPaths.ts#matchesSkillPaths",
  "src/common/utils/tools/toolCatalog.ts#buildToolCatalogOverview",
  "src/common/utils/tools/toolDefinitions.ts#AskUserQuestionOptionSchema",
  "src/node/runtime/workspaceScratchDir.ts#ensureWorkspaceScratchDir",
  "src/node/services/agentPlugins/codexHooks.ts#MappedCodexHookEvent",
  "src/node/services/artifactRuntimeStore.ts#parseArtifactReadOutput",
  "src/node/services/artifactShelf.ts#replaceShelfEntry",
  "src/node/services/artifactShelf.ts#parseShelfScope",
  "src/node/services/claudeDesignService.ts#CLAUDE_DESIGN_SERVER_NAME",
  "src/node/services/replay/replayFixture.ts#appendReplayFixtureCompactionBoundary",
  "src/node/services/replay/replayFixture.ts#generateReplayFixtureSession",
  "src/node/services/replay/replayVerify.ts#readRecordedRequests",
  "src/node/services/replay/replayVerify.ts#readRecordedSteps",
  "src/node/worktree/codeWorkspaceSync.ts#updateCodeWorkspaceFile",
];

/** What one file imports from one module specifier. `"*"` means every export (namespace use). */
export interface ImportFact {
  specifier: string;
  names: string[];
}

export interface ReExportFact {
  specifier: string;
  /** `export * from` forwards every name; otherwise `exported` forwards `imported`. */
  star: boolean;
  names: Array<{ imported: string; exported: string }>;
}

export interface ExportFact {
  name: string;
  line: number;
}

export interface ModuleFacts {
  /** Exports declared in this file (not re-exports). */
  exports: ExportFact[];
  /** Declared exports that the file itself uses outside the declaration. */
  usedLocally: Set<string>;
  imports: ImportFact[];
  reExports: ReExportFact[];
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

/** The name of a top-level-style declaration (`const x`, `function x`, `class x`, ...). */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === node
  );
}

/** An identifier that names a property or member, not a binding in scope. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isJsxAttribute(parent)) {
    return parent.name === node;
  }
  if (ts.isQualifiedName(parent)) return parent.right === node;
  // `{ a: x } = y`: `a` is the object's property.
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent)
  ) {
    return parent.name === node;
  }
  return false;
}

function stringArgument(node: ts.CallExpression): string | undefined {
  const [first] = node.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
}

/** Parses one file into the facts the reachability check needs. */
export function collectModuleFacts(file: string, text: string): ModuleFacts {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file)
  );
  const exports: ExportFact[] = [];
  const imports: ImportFact[] = [];
  const reExports: ReExportFact[] = [];
  /** Local name -> exported names, and the identifier nodes that declare it. */
  const exportedLocals = new Map<string, string[]>();
  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const addExport = (exported: string, local: string | undefined, at: ts.Node) => {
    // Overloads and declaration merging repeat a name; the first declaration reports it.
    if (!exports.some((fact) => fact.name === exported)) {
      exports.push({ name: exported, line: lineOf(at) });
    }
    if (local !== undefined)
      exportedLocals.set(local, [...(exportedLocals.get(local) ?? []), exported]);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const names: string[] = [];
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
      }
      // A side-effect import (`import "./x"`) uses no export.
      imports.push({ specifier: statement.moduleSpecifier.text, names });
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      const clause = statement.exportClause;
      if (specifier !== undefined) {
        if (clause === undefined) {
          reExports.push({ specifier, star: true, names: [] });
        } else if (ts.isNamespaceExport(clause)) {
          // `export * as ns from "./a"` declares `ns` here and uses all of a.
          addExport(clause.name.text, undefined, clause.name);
          imports.push({ specifier, names: ["*"] });
        } else {
          reExports.push({
            specifier,
            star: false,
            names: clause.elements.map((element) => ({
              imported: (element.propertyName ?? element.name).text,
              exported: element.name.text,
            })),
          });
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          addExport(element.name.text, (element.propertyName ?? element.name).text, element.name);
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      // `export default expr` / `export = expr`: the expression is used by the export itself.
      addExport("default", undefined, statement);
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const id of bindingNames(declaration.name)) {
          addExport(id.text, id.text, id);
        }
      }
      continue;
    }
    const named = statement as ts.Node & { name?: ts.Node };
    if (hasDefaultModifier(statement)) {
      addExport(
        "default",
        named.name && ts.isIdentifier(named.name) ? named.name.text : undefined,
        statement
      );
      continue;
    }
    if (named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))) {
      addExport(named.name.text, named.name.text, named.name);
    }
  }

  const usedLocally = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const exported = exportedLocals.get(node.text);
      if (exported && !isDeclarationName(node) && !isPropertyName(node)) {
        for (const name of exported) usedLocally.add(name);
      }
    } else if (ts.isCallExpression(node)) {
      // `import("./x")`, `require("./x")` and require wrappers such as main.ts's
      // `requireDesktopModule("./x")` use the whole module.
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && /^require(?:[A-Z]\w*)?$/.test(node.expression.text);
      const specifier = isDynamicImport || isRequire ? stringArgument(node) : undefined;
      if (specifier !== undefined) imports.push({ specifier, names: ["*"] });
    } else if (ts.isImportTypeNode(node)) {
      // `typeof import("./x")` / `import("./x").Foo`.
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        const qualifier = node.qualifier;
        const first =
          qualifier === undefined
            ? undefined
            : ts.isIdentifier(qualifier)
              ? qualifier
              : leftmost(qualifier);
        imports.push({ specifier: argument.literal.text, names: [first?.text ?? "*"] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { exports, usedLocally, imports, reExports };
}

function leftmost(name: ts.QualifiedName): ts.Identifier {
  return ts.isIdentifier(name.left) ? name.left : leftmost(name.left);
}

const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/** Resolves a specifier to a known repo-relative file, or undefined for packages and assets. */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  knownFiles: ReadonlySet<string>
): string | undefined {
  let base: string;
  const alias = /^(?:@|@shared)\//.exec(specifier);
  if (alias) base = `src/${specifier.slice(alias[0].length)}`;
  else if (specifier.startsWith("."))
    base = path.posix.join(path.posix.dirname(fromFile), specifier);
  else return undefined;
  const candidates = [base];
  // ESM-style `./a.js` for `./a.ts`.
  if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/\.[cm]?js$/, ""));
  for (const candidate of candidates) {
    for (const suffix of RESOLVE_SUFFIXES) {
      if (knownFiles.has(candidate + suffix)) return candidate + suffix;
    }
  }
  return undefined;
}

/**
 * Built-in workflow scripts (the .js files under src/node/builtinSkills/) are run by the workflow runtime,
 * which reads their `meta` and `default` exports by contract; no module imports them.
 */
export function hasImportedExports(file: string): boolean {
  return !(file.startsWith("src/node/builtinSkills/") && file.endsWith(".js"));
}

export interface UnreferencedExport {
  file: string;
  symbol: string;
  line: number;
}

/**
 * Marks every export some referrer reaches and returns the declared exports of `checkedFiles`
 * that nothing reaches. `facts` must hold every referrer and every barrel a referrer imports.
 */
export function findUnreferencedExports(
  facts: ReadonlyMap<string, ModuleFacts>,
  referrers: readonly string[],
  checkedFiles: readonly string[]
): UnreferencedExport[] {
  const knownFiles = new Set(facts.keys());
  const used = new Set<string>();
  const visited = new Set<string>();
  const markUse = (file: string, name: string) => {
    const key = `${file}#${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    const module = facts.get(file);
    if (module === undefined) return;
    if (name === "*") {
      for (const fact of module.exports) used.add(`${file}#${fact.name}`);
    } else {
      used.add(key);
    }
    for (const reExport of module.reExports) {
      const target = resolveSpecifier(reExport.specifier, file, knownFiles);
      if (target === undefined) continue;
      if (reExport.star) {
        // `export * from` never forwards `default`.
        if (name !== "default") markUse(target, name);
        continue;
      }
      for (const forwarded of reExport.names) {
        if (name === "*" || forwarded.exported === name) markUse(target, forwarded.imported);
      }
    }
  };
  for (const file of referrers) {
    const module = facts.get(file);
    assert(module !== undefined, `no facts for referrer ${file}`);
    for (const name of module.usedLocally) used.add(`${file}#${name}`);
    for (const fact of module.imports) {
      const target = resolveSpecifier(fact.specifier, file, knownFiles);
      if (target === undefined) continue;
      for (const name of fact.names) markUse(target, name);
    }
  }
  return checkedFiles.flatMap((file) =>
    (facts.get(file)?.exports ?? [])
      .filter((fact) => !used.has(`${file}#${fact.name}`))
      .map((fact) => ({ file, symbol: fact.name, line: fact.line }))
  );
}

export interface AllowlistEntry {
  file: string;
  symbol: string;
  reason: string;
}

export interface PendingEntry extends AllowlistEntry {
  /** The workstream or person deleting it. */
  owner: string;
}

export interface Allowlist {
  allowed: AllowlistEntry[];
  pendingDeletion: PendingEntry[];
}

function parseEntries<T extends AllowlistEntry>(json: unknown, list: string, extra: string[]): T[] {
  assert(Array.isArray(json), `${ALLOWLIST_PATH}: "${list}" must be an array`);
  return json.map((entry: unknown, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const where = `${ALLOWLIST_PATH}: ${list}[${index}]`;
    for (const field of ["file", "symbol", "reason", ...extra]) {
      const value = record[field];
      assert(typeof value === "string" && value.trim().length > 0, `${where}.${field} is required`);
    }
    return record as unknown as T;
  });
}

export function parseAllowlist(json: unknown): Allowlist {
  assert(typeof json === "object" && json !== null, `${ALLOWLIST_PATH} must be a JSON object`);
  const { allowed, pendingDeletion } = json as Record<string, unknown>;
  return {
    allowed: parseEntries<AllowlistEntry>(allowed, "allowed", []),
    pendingDeletion: parseEntries<PendingEntry>(pendingDeletion, "pendingDeletion", ["owner"]),
  };
}

const entryKey = (entry: { file: string; symbol: string }) => `${entry.file}#${entry.symbol}`;

export interface CheckResult {
  unlisted: UnreferencedExport[];
  /** Entries whose export now has a production reference or no longer exists. */
  stale: AllowlistEntry[];
  duplicates: AllowlistEntry[];
  /** `pendingDeletion` keys missing from the frozen list (the list only shrinks). */
  unfrozen: PendingEntry[];
  /** Frozen keys no longer pending; remove them from FROZEN_PENDING_DELETION too. */
  thawed: string[];
}

export function checkExports(
  findings: readonly UnreferencedExport[],
  allowlist: Allowlist,
  frozenPending: readonly string[] = FROZEN_PENDING_DELETION
): CheckResult {
  const listed = new Map<string, AllowlistEntry>();
  const duplicates: AllowlistEntry[] = [];
  for (const entry of [...allowlist.allowed, ...allowlist.pendingDeletion]) {
    if (listed.has(entryKey(entry))) duplicates.push(entry);
    listed.set(entryKey(entry), entry);
  }
  const found = new Set(findings.map(entryKey));
  const frozen = new Set(frozenPending);
  const pendingKeys = new Set(allowlist.pendingDeletion.map(entryKey));
  return {
    unlisted: findings.filter((finding) => !listed.has(entryKey(finding))),
    stale: [...listed.values()].filter((entry) => !found.has(entryKey(entry))),
    duplicates,
    unfrozen: allowlist.pendingDeletion.filter((entry) => !frozen.has(entryKey(entry))),
    thawed: [...frozen].filter((key) => !pendingKeys.has(key)),
  };
}

function main(): number {
  const tag = "check-test-only-exports:";
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
  const facts = new Map<string, ModuleFacts>();
  for (const file of files) {
    facts.set(file, collectModuleFacts(file, readFileSync(path.join(root, file), "utf8")));
  }
  const findings = findUnreferencedExports(facts, files, files.filter(hasImportedExports));
  const allowlist = parseAllowlist(
    JSON.parse(readFileSync(path.join(root, ALLOWLIST_PATH), "utf8")) as unknown
  );
  const { unlisted, stale, duplicates, unfrozen, thawed } = checkExports(findings, allowlist);

  for (const finding of unlisted) {
    console.error(
      `${tag} ${finding.file}:${finding.line} export \`${finding.symbol}\` has no non-test reference`
    );
  }
  if (unlisted.length > 0) {
    console.error(
      [
        "",
        "Nothing in production imports these exports, and their own files do not use them.",
        "Delete the export (and tests that only exercise it), move the test to the function",
        "production calls, or drop `export` if only its own file uses it. If it must stay (a",
        "...ForTests reset hook, a test-support or story helper, a consumer outside src/), add it",
        `to "allowed" in ${ALLOWLIST_PATH} with the reason:`,
        ...unlisted.map(
          (finding) =>
            `  { "file": "${finding.file}", "symbol": "${finding.symbol}", "reason": "<who needs it and why>" }`
        ),
      ].join("\n")
    );
  }
  for (const entry of stale) {
    console.error(
      `${tag} stale allowlist entry ${entryKey(entry)}: the export is gone or has a production reference now; remove it from ${ALLOWLIST_PATH}`
    );
  }
  for (const entry of duplicates) {
    console.error(`${tag} duplicate allowlist entry ${entryKey(entry)} in ${ALLOWLIST_PATH}`);
  }
  for (const entry of unfrozen) {
    console.error(
      `${tag} new pendingDeletion entry ${entryKey(entry)}: pendingDeletion only shrinks; delete the export or list it under "allowed" with a reason`
    );
  }
  for (const key of thawed) {
    console.error(
      `${tag} ${key} left pendingDeletion; remove it from FROZEN_PENDING_DELETION in scripts/check-test-only-exports.ts too`
    );
  }
  const failures =
    unlisted.length + stale.length + duplicates.length + unfrozen.length + thawed.length;
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main());
}
