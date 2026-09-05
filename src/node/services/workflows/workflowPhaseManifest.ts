/**
 * Derives the phase manifest hydrated onto outbound workflow payloads.
 *
 * Two sources, in precedence order:
 *  1. `meta.phases` (declared) — validated strictly at run creation
 *     (WorkflowService) and leniently here on read paths.
 *  2. Best-effort static inference from `phase("literal")` callsites for legacy
 *     scripts without a declaration. Inference is all-or-nothing: any dynamic
 *     name, aliasing, shadowing, or nested-scope use of the `phase` binding
 *     bails to no manifest, because a wrong inferred rail is worse than none.
 *
 * The manifest is derived data: it is NEVER persisted (see
 * WorkflowRunStore.writeRunFile) and read-path failures never throw — they
 * memoize a negative result so old/hand-edited runs keep loading.
 */
import type ts from "typescript";
import { LRUCache } from "lru-cache";

import type {
  WorkflowDeclaredPhase,
  WorkflowPhaseManifest,
  WorkflowRunRecord,
} from "@/common/types/workflow";
import {
  WorkflowPhaseManifestSchema,
  WORKFLOW_DECLARED_PHASES_MAX,
  WORKFLOW_PHASE_NAME_MAX_LENGTH,
} from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { parseDeclaredPhasesFromSource } from "./workflowMetadata";

type TypeScriptModule = typeof ts;
let tsModule: TypeScriptModule | undefined;

/**
 * Lazy-load the TypeScript compiler (~9 MB) the way sharp/QuickJS are: this
 * module sits on the oRPC router's import graph, which the `xum api` CLI bundle
 * carries only to generate commands — it never runs inference. A static import
 * both broke that ESM bundle (typescript.js is CJS-only) and added ~280 ms to
 * every CLI start; the Makefile marks `typescript` external for that bundle.
 */
function loadTypeScript(): TypeScriptModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  tsModule ??= require("typescript") as TypeScriptModule;
  return tsModule;
}

export type WorkflowPhaseManifestOutcome =
  | { kind: "manifest"; manifest: WorkflowPhaseManifest }
  // meta.phases present but invalid; `warning` carries the enumerated issues.
  | { kind: "invalid"; warning: string }
  // No declaration and inference bailed: today's observed-only behavior.
  | { kind: "none" };

// The subscribe stream re-hydrates on every run-changed event, so parses are
// memoized per distinct source. Keyed by sourceHash (content-addressed).
const outcomeBySourceHash = new LRUCache<string, WorkflowPhaseManifestOutcome>({ max: 128 });

/**
 * Resolve the phase manifest for a workflow source. Never throws: invalid
 * declarations are reported as `kind: "invalid"`, everything else degrades to
 * `kind: "none"`. Results (including negative ones) are memoized by sourceHash.
 */
export function resolveWorkflowPhaseManifest(
  source: string,
  sourceHash: string
): WorkflowPhaseManifestOutcome {
  assert(sourceHash.length > 0, "resolveWorkflowPhaseManifest: sourceHash is required");
  const cached = outcomeBySourceHash.get(sourceHash);
  if (cached != null) {
    return cached;
  }
  const outcome = computePhaseManifestOutcome(source);
  outcomeBySourceHash.set(sourceHash, outcome);
  return outcome;
}

function computePhaseManifestOutcome(source: string): WorkflowPhaseManifestOutcome {
  let declared: WorkflowDeclaredPhase[] | undefined;
  try {
    declared = parseDeclaredPhasesFromSource(source);
  } catch (error) {
    // Read-path strictness would brick old runs; run creation is the strict gate.
    log.debug(
      `workflowPhaseManifest: invalid meta.phases ignored on read: ${getErrorMessage(error)}`
    );
    return { kind: "invalid", warning: getErrorMessage(error) };
  }
  if (declared != null) {
    return {
      kind: "manifest",
      manifest: WorkflowPhaseManifestSchema.parse({ provenance: "declared", phases: declared }),
    };
  }
  try {
    const inferred = inferPhaseManifest(source);
    if (inferred != null) {
      return {
        kind: "manifest",
        manifest: WorkflowPhaseManifestSchema.parse({ provenance: "inferred", phases: inferred }),
      };
    }
  } catch (error) {
    // Inference is purely additive; a scanner failure must never break reads.
    log.debug(`workflowPhaseManifest: inference failed: ${getErrorMessage(error)}`);
  }
  return { kind: "none" };
}

/**
 * Return an outbound copy of the run whose `workflow.phaseManifest` is derived
 * from the snapshotted source — set when a manifest resolves, otherwise absent.
 * The source is the only authority: a `phaseManifest` already present on the
 * incoming record (hand-edited or otherwise corrupted run.json — the record
 * schema tolerates the field so the store can strip it) is never passed through,
 * so persisted corruption self-heals at the read boundary. Callers must not feed
 * the hydrated copy back into WorkflowRunStore writes.
 */
export function hydrateWorkflowRunPhaseManifest(run: WorkflowRunRecord): WorkflowRunRecord {
  const outcome = resolveWorkflowPhaseManifest(run.source, run.sourceHash);
  const { phaseManifest: _stale, ...workflow } = run.workflow;
  if (outcome.kind !== "manifest") {
    return _stale === undefined ? run : { ...run, workflow };
  }
  return { ...run, workflow: { ...workflow, phaseManifest: outcome.manifest } };
}

/**
 * Best-effort static inference of the phase alphabet for scripts without
 * meta.phases. Returns the phases in first-occurrence source order, or
 * `undefined` when the scanner bails (see module doc for the bail gate).
 */
export function inferPhaseManifest(source: string): WorkflowDeclaredPhase[] | undefined {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile(
    "workflow.js",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS
  );
  // Direct `eval` can read or reassign the lexical `phase` binding from a string
  // the scanner cannot see, so any direct eval call in the file voids inference.
  if (containsDirectEval(ts, sourceFile)) {
    return undefined;
  }
  const workflowFn = findDefaultExportedFunction(ts, sourceFile);
  if (workflowFn?.body == null) {
    return undefined;
  }
  if (!hasCanonicalPhaseBinding(ts, workflowFn)) {
    return undefined;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  // Walk the workflow function's own body. Nested function/class scopes are not
  // walked for collection: any `phase` reference inside them bails (source
  // order there does not imply runtime order), and any shadowing declaration
  // of `phase` anywhere bails.
  const visit = (node: ts.Node, insideNestedScope: boolean): boolean => {
    if (ts.isIdentifier(node) && node.text === "phase") {
      const classification = classifyPhaseIdentifier(ts, node);
      if (classification === "ignore") {
        return true;
      }
      if (classification === "shadowing-declaration" || insideNestedScope) {
        return false;
      }
      if (classification !== "direct-call") {
        return false;
      }
      const call = node.parent;
      assert(ts.isCallExpression(call), "inferPhaseManifest: direct-call must be a CallExpression");
      const firstArg = call.arguments[0];
      const name = staticStringArgument(ts, firstArg);
      if (name == null) {
        return false;
      }
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      return true;
    }
    const nested = insideNestedScope || introducesFunctionOrClassScope(ts, node);
    for (const child of node.getChildren(sourceFile)) {
      if (!visit(child, nested)) {
        return false;
      }
    }
    return true;
  };
  if (!visit(workflowFn.body, false)) {
    return undefined;
  }

  if (names.length === 0 || names.length > WORKFLOW_DECLARED_PHASES_MAX) {
    return undefined;
  }
  if (names.some((name) => name.length === 0 || name.length > WORKFLOW_PHASE_NAME_MAX_LENGTH)) {
    return undefined;
  }
  return names.map((name) => ({ name }));
}

type WorkflowFunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function findDefaultExportedFunction(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile
): WorkflowFunctionNode | undefined {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      // `export default function run` is a live binding: any later mention of
      // `run` could rebind what the default export executes.
      if (
        statement.name != null &&
        hasOtherReferences(ts, sourceFile, statement.name.text, new Set([statement.name]))
      ) {
        return undefined;
      }
      return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return resolveFunctionExpression(ts, sourceFile, statement.expression);
    }
  }
  return undefined;
}

function resolveFunctionExpression(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile,
  expression: ts.Expression
): WorkflowFunctionNode | undefined {
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return expression;
  }
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  // `export default run;` referencing a top-level function or const initializer.
  // The binding must be immutable AND mentioned nowhere else: `let run = a; run = b;`
  // would make the initializer describe a function the runtime never executes.
  const resolved = findImmutableFunctionBinding(ts, sourceFile, expression.text);
  if (resolved == null) {
    return undefined;
  }
  if (hasOtherReferences(ts, sourceFile, expression.text, new Set([resolved.name, expression]))) {
    return undefined;
  }
  return resolved.fn;
}

function findImmutableFunctionBinding(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile,
  name: string
): { name: ts.Identifier; fn: WorkflowFunctionNode } | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return { name: statement.name, fn: statement };
    }
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer != null &&
          (ts.isFunctionExpression(declaration.initializer) ||
            ts.isArrowFunction(declaration.initializer))
        ) {
          return { name: declaration.name, fn: declaration.initializer };
        }
      }
    }
  }
  return undefined;
}

function containsDirectEval(ts: TypeScriptModule, sourceFile: ts.SourceFile): boolean {
  // `(eval)(x)` is still a direct eval — parentheses preserve the Reference —
  // whereas `(0, eval)(x)` and `obj.eval(x)` are indirect and out of scope.
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const check = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        return true;
      }
    }
    return ts.forEachChild(node, check) === true;
  };
  return check(sourceFile);
}

/**
 * True when the identifier `name` is referenced anywhere other than the nodes in
 * `allowed` (its declaration and the `export default name` expression). Any other
 * mention — `name = f`, `({ name } = o)`, `for (name of xs)`, `helper(name)` — could
 * rebind or observe the live export, so inference gives up rather than enumerate
 * assignment forms. Property names (`obj.name`, `{ name: 1 }`) also bail: harmless
 * over-caution for the all-or-nothing gate.
 */
function hasOtherReferences(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile,
  name: string,
  allowed: ReadonlySet<ts.Node>
): boolean {
  const check = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === name && !allowed.has(node)) ||
    ts.forEachChild(node, check) === true;
  return check(sourceFile);
}

function hasModifier(node: ts.FunctionDeclaration, kind: ts.SyntaxKind): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/**
 * The only accepted binding is the canonical `{ phase }` shorthand (or the
 * equivalent explicit `{ phase: phase }`) at the top level of the first
 * parameter. Renames (`{ phase: p }`), bindings of the NAME `phase` from other
 * properties, or `phase` bindings anywhere else in the parameter list bail.
 */
function hasCanonicalPhaseBinding(ts: TypeScriptModule, fn: WorkflowFunctionNode): boolean {
  const firstParam = fn.parameters[0];
  if (firstParam == null || !ts.isObjectBindingPattern(firstParam.name)) {
    return false;
  }
  let canonical = false;
  for (const element of firstParam.name.elements) {
    const propertyName = bindingPropertyNameText(ts, element);
    if (propertyName === COMPUTED_BINDING_KEY) {
      return false; // { [key]: phase } — the bound capability cannot be proven statically
    }
    const boundName = ts.isIdentifier(element.name) ? element.name.text : null;
    if (propertyName === "phase" || (propertyName == null && boundName === "phase")) {
      if (boundName !== "phase") {
        return false; // rename: { phase: p }
      }
      canonical = true;
    } else if (boundName === "phase") {
      return false; // { other: phase } binds a misleading local named phase
    } else if (containsPhaseBinding(ts, element.name)) {
      return false; // nested pattern binding a `phase` local
    }
  }
  if (!canonical) {
    return false;
  }
  // Any OTHER parameter binding a `phase` local would shadow ambiguously.
  return fn.parameters.slice(1).every((parameter) => !containsPhaseBinding(ts, parameter.name));
}

/** Sentinel for `{ [computed]: local }` keys, which have no static identity. */
const COMPUTED_BINDING_KEY = Symbol("computed-binding-key");

function bindingPropertyNameText(
  ts: TypeScriptModule,
  element: ts.BindingElement
): string | typeof COMPUTED_BINDING_KEY | null {
  const propertyName = element.propertyName;
  if (propertyName == null) {
    return null;
  }
  return ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)
    ? propertyName.text
    : COMPUTED_BINDING_KEY;
}

function containsPhaseBinding(ts: TypeScriptModule, name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === "phase";
  }
  return name.elements.some((element) => {
    if (ts.isOmittedExpression(element)) {
      return false;
    }
    return containsPhaseBinding(ts, element.name);
  });
}

function introducesFunctionOrClassScope(ts: TypeScriptModule, node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

type PhaseIdentifierClassification =
  // Not a reference to the binding (member name, object key, label, …).
  | "ignore"
  // A declaration introducing a different `phase` binding → bail.
  | "shadowing-declaration"
  // `phase("...")` with the identifier as the callee and no optional chaining.
  | "direct-call"
  // Any other reference (argument, return, alias, member base, `phase?.()`) → bail.
  | "other-reference";

function classifyPhaseIdentifier(
  ts: TypeScriptModule,
  node: ts.Identifier
): PhaseIdentifierClassification {
  const parent = node.parent;
  // Non-reference name positions.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return "ignore"; // ctx.phase — member of another object
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return "ignore"; // { phase: x } — object literal key
  }
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return "ignore"; // method/property named phase on a class or object
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) {
    return "ignore";
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return "ignore"; // destructuring key ({ phase: p }); the rename itself is caught as a declaration below
  }

  // Declarations introducing a new `phase` binding (shadowing).
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  ) {
    return "shadowing-declaration";
  }

  if (ts.isCallExpression(parent) && parent.expression === node) {
    // `phase?.(...)` is a non-direct use per the bail gate.
    return parent.questionDotToken == null ? "direct-call" : "other-reference";
  }
  return "other-reference";
}

function staticStringArgument(
  ts: TypeScriptModule,
  argument: ts.Expression | undefined
): string | null {
  if (argument == null) {
    return null;
  }
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return null;
}
