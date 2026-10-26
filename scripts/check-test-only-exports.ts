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
  /** `module.exports = { a, b }`: a default import is the whole object, so it uses a and b. */
  defaultIsWholeModule: boolean;
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

/** Names a block-like statement list declares for its own scope. */
function statementBindings(statements: readonly ts.Statement[]): string[] {
  return statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        bindingNames(declaration.name).map((id) => id.text)
      );
    }
    const name = (statement as { name?: ts.Node }).name;
    return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
  });
}

/**
 * `var` names declared anywhere in a function body outside nested functions. JavaScript hoists
 * them to the whole function, so they shadow a module export of the same name there.
 */
function hoistedVarNames(body: ts.Node): string[] {
  const names: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.None
    ) {
      for (const declaration of node.declarations) {
        names.push(...bindingNames(declaration.name).map((id) => id.text));
      }
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return names;
}

/**
 * Names `node` binds for its own subtree (parameters, type parameters, catch variables, block
 * declarations, a named function or class expression's own name). Inside that subtree they
 * shadow a module-level export of the same name, so they are not uses of it.
 */
function scopeBindings(node: ts.Node): string[] {
  if (ts.isSourceFile(node)) return [];
  const names: string[] = [];
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) {
      names.push(...bindingNames(parameter.name).map((id) => id.text));
    }
    if (ts.isFunctionExpression(node) && node.name) names.push(node.name.text);
    const body = (node as { body?: ts.Node }).body;
    if (body !== undefined) names.push(...hoistedVarNames(body));
  }
  if (ts.isClassExpression(node) && node.name) names.push(node.name.text);
  const typeParameters = (node as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> })
    .typeParameters;
  for (const typeParameter of typeParameters ?? []) names.push(typeParameter.name.text);
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    names.push(...bindingNames(node.variableDeclaration.name).map((id) => id.text));
  }
  if (ts.isBlock(node) || ts.isModuleBlock(node)) names.push(...statementBindings(node.statements));
  if (ts.isCaseBlock(node)) {
    names.push(...statementBindings(node.clauses.flatMap((clause) => [...clause.statements])));
  }
  if (
    (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer)
  ) {
    for (const declaration of node.initializer.declarations) {
      names.push(...bindingNames(declaration.name).map((id) => id.text));
    }
  }
  return names;
}

/**
 * The module-level names a top-level declaration declares. Uses inside the declaration itself
 * (a recursive call, a class naming itself) are not uses from elsewhere in the file.
 */
function ownDeclarationNames(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    node.parent.parent.parent === sourceFile
  ) {
    return bindingNames(node.name).map((id) => id.text);
  }
  if (node.parent !== sourceFile || ts.isVariableStatement(node)) return [];
  const name = (node as { name?: ts.Node }).name;
  return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
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

/** `exports.a` / `module.exports.a` / `exports["a"]`: the exported name, else undefined. */
function commonJsMemberName(target: ts.Expression): string | undefined {
  const isExportsObject = (object: ts.Expression) =>
    (ts.isIdentifier(object) && object.text === "exports") || isModuleExports(object);
  if (ts.isPropertyAccessExpression(target) && isExportsObject(target.expression)) {
    return target.name.text;
  }
  if (
    ts.isElementAccessExpression(target) &&
    isExportsObject(target.expression) &&
    ts.isStringLiteralLike(target.argumentExpression)
  ) {
    return target.argumentExpression.text;
  }
  return undefined;
}

const isModuleExports = (node: ts.Expression) =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "module" &&
  node.name.text === "exports";

/**
 * CommonJS exports a statement declares: `exports.a = ...` / `module.exports.a = ...` /
 * `exports["a"] = ...` declare `a`; `module.exports = { a, b }` declares `a` and `b` (and its
 * default import is the whole object, see `ModuleFacts.defaultIsWholeModule`); any other `module.exports = x` declares
 * `default`. Undefined for statements that are not such an assignment.
 */
function commonJsExportNames(statement: ts.Statement): string[] | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const expression = statement.expression;
  if (!ts.isBinaryExpression(expression)) return undefined;
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  const target = expression.left;
  if (isModuleExports(target)) {
    const value = expression.right;
    if (!ts.isObjectLiteralExpression(value)) return ["default"];
    return value.properties.flatMap((property) => {
      const name = property.name;
      return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
        ? [name.text]
        : [];
    });
  }
  const member = commonJsMemberName(target);
  return member === undefined ? undefined : [member];
}

/** `module.exports = { ... }`. */
function assignsModuleExportsObject(statement: ts.Statement): boolean {
  return (
    ts.isExpressionStatement(statement) &&
    ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isModuleExports(statement.expression.left) &&
    ts.isObjectLiteralExpression(statement.expression.right)
  );
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
  let defaultIsWholeModule = false;
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
    const commonJs = commonJsExportNames(statement);
    if (assignsModuleExportsObject(statement)) defaultIsWholeModule = true;
    if (commonJs !== undefined) {
      for (const name of commonJs) addExport(name, undefined, statement);
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
  const visit = (node: ts.Node, hidden: ReadonlySet<string>) => {
    const hiding = [...scopeBindings(node), ...ownDeclarationNames(node, sourceFile)].filter(
      (name) => exportedLocals.has(name) && !hidden.has(name)
    );
    const inner = hiding.length > 0 ? new Set([...hidden, ...hiding]) : hidden;
    if (ts.isIdentifier(node)) {
      const exported = inner.has(node.text) ? undefined : exportedLocals.get(node.text);
      if (exported && !isPropertyName(node)) {
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
      // The qualifier names the other module's exports, not this file's.
      for (const typeArgument of node.typeArguments ?? []) visit(typeArgument, inner);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sourceFile, new Set());
  return { exports, usedLocally, imports, reExports, defaultIsWholeModule };
}

function leftmost(name: ts.QualifiedName): ts.Identifier {
  return ts.isIdentifier(name.left) ? name.left : leftmost(name.left);
}

/** Suffixes an extensionless specifier can stand for. */
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.d.ts",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
];

/** Sources an emitted-extension specifier (`./a.js`, NodeNext `./a.mjs`) can stand for. */
const EMITTED_SOURCES: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"],
};

/** Resolves a specifier to a known repo-relative file, or undefined for packages and assets. */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  knownFiles: ReadonlySet<string>
): string | undefined {
  let base: string;
  const alias = /^(?:@|@shared)\//.exec(specifier);
  if (alias) base = `src/${specifier.slice(alias[0].length)}`;
  else if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(fromFile), specifier);
  } else return undefined;
  for (const suffix of RESOLVE_SUFFIXES) {
    if (knownFiles.has(base + suffix)) return base + suffix;
  }
  const extension = /\.[cm]?jsx?$/.exec(base)?.[0];
  if (extension === undefined) return undefined;
  for (const source of EMITTED_SOURCES[extension]) {
    const candidate = base.slice(0, -extension.length) + source;
    if (knownFiles.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Built-in workflow scripts (the .js files under src/node/builtinSkills/) are run by the workflow
 * runtime, which reads their `meta` and `default` exports by contract; no module imports them.
 * Their other exports are checked like any other.
 */
export function isRuntimeContractExport(file: string, symbol: string): boolean {
  return (
    file.startsWith("src/node/builtinSkills/") &&
    file.endsWith(".js") &&
    (symbol === "meta" || symbol === "default")
  );
}

function explicitlyExports(module: ModuleFacts, name: string): boolean {
  return (
    module.exports.some((fact) => fact.name === name) ||
    module.reExports.some((reExport) => reExport.names.some((n) => n.exported === name))
  );
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
  /**
   * The names `file`'s namespace holds: its own exports (named re-exports included) plus, through
   * each `export *`, the target's names except `default` and the names `file` shadows.
   */
  const namespaceNames = (file: string, seen: Set<string> = new Set()): string[] => {
    const module = facts.get(file);
    if (module === undefined || seen.has(file)) return [];
    seen.add(file);
    const names = module.exports.map((fact) => fact.name);
    for (const reExport of module.reExports) {
      // `export { a } from "./b"` puts `a` in this namespace too.
      names.push(...reExport.names.map((forwarded) => forwarded.exported));
      const target = reExport.star
        ? resolveSpecifier(reExport.specifier, file, knownFiles)
        : undefined;
      if (target === undefined) continue;
      for (const name of namespaceNames(target, seen)) {
        if (name !== "default" && !explicitlyExports(module, name)) names.push(name);
      }
    }
    return names;
  };
  const markUse = (file: string, name: string) => {
    const key = `${file}#${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    const module = facts.get(file);
    if (module === undefined) return;
    // The default import of `module.exports = { a, b }` is the whole object.
    if (name === "default" && module.defaultIsWholeModule) {
      markUse(file, "*");
      return;
    }
    if (name === "*") {
      for (const fact of module.exports) used.add(`${file}#${fact.name}`);
    } else {
      used.add(key);
    }
    for (const reExport of module.reExports) {
      const target = resolveSpecifier(reExport.specifier, file, knownFiles);
      if (target === undefined) continue;
      if (reExport.star) {
        // `export * from` never forwards `default`, nor a name the barrel exports explicitly, so
        // a namespace use of the barrel reaches only the target's other names.
        const names = name === "*" ? namespaceNames(target) : [name];
        for (const forwarded of names) {
          if (forwarded !== "default" && !explicitlyExports(module, forwarded)) {
            markUse(target, forwarded);
          }
        }
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
  const findings = findUnreferencedExports(facts, files, files).filter(
    (finding) => !isRuntimeContractExport(finding.file, finding.symbol)
  );
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
