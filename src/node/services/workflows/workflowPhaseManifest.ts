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
import ts from "typescript";
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
import { parseWorkflowMetadata, parseDeclaredPhases } from "./workflowMetadata";

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
    declared = parseDeclaredPhases(parseWorkflowMetadata(source));
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
 * Return an outbound copy of the run with `workflow.phaseManifest` hydrated,
 * or the run unchanged when no manifest resolves. Callers must not feed the
 * hydrated copy back into WorkflowRunStore writes.
 */
export function hydrateWorkflowRunPhaseManifest(run: WorkflowRunRecord): WorkflowRunRecord {
  const outcome = resolveWorkflowPhaseManifest(run.source, run.sourceHash);
  if (outcome.kind !== "manifest") {
    return run;
  }
  return { ...run, workflow: { ...run.workflow, phaseManifest: outcome.manifest } };
}

/**
 * Best-effort static inference of the phase alphabet for scripts without
 * meta.phases. Returns the phases in first-occurrence source order, or
 * `undefined` when the scanner bails (see module doc for the bail gate).
 */
export function inferPhaseManifest(source: string): WorkflowDeclaredPhase[] | undefined {
  const sourceFile = ts.createSourceFile(
    "workflow.js",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS
  );
  const workflowFn = findDefaultExportedFunction(sourceFile);
  if (workflowFn?.body == null) {
    return undefined;
  }
  if (!hasCanonicalPhaseBinding(workflowFn)) {
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
      const classification = classifyPhaseIdentifier(node);
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
      const name = staticStringArgument(firstArg);
      if (name == null) {
        return false;
      }
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      return true;
    }
    const nested = insideNestedScope || introducesFunctionOrClassScope(node);
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

function findDefaultExportedFunction(sourceFile: ts.SourceFile): WorkflowFunctionNode | undefined {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return resolveFunctionExpression(sourceFile, statement.expression);
    }
  }
  return undefined;
}

function resolveFunctionExpression(
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
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === expression.text) {
      return statement;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === expression.text &&
          declaration.initializer != null &&
          (ts.isFunctionExpression(declaration.initializer) ||
            ts.isArrowFunction(declaration.initializer))
        ) {
          return declaration.initializer;
        }
      }
    }
  }
  return undefined;
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
function hasCanonicalPhaseBinding(fn: WorkflowFunctionNode): boolean {
  const firstParam = fn.parameters[0];
  if (firstParam == null || !ts.isObjectBindingPattern(firstParam.name)) {
    return false;
  }
  let canonical = false;
  for (const element of firstParam.name.elements) {
    const propertyName = bindingPropertyNameText(element);
    const boundName = ts.isIdentifier(element.name) ? element.name.text : null;
    if (propertyName === "phase" || (propertyName == null && boundName === "phase")) {
      if (boundName !== "phase") {
        return false; // rename: { phase: p }
      }
      canonical = true;
    } else if (boundName === "phase") {
      return false; // { other: phase } binds a misleading local named phase
    } else if (containsPhaseBinding(element.name)) {
      return false; // nested pattern binding a `phase` local
    }
  }
  if (!canonical) {
    return false;
  }
  // Any OTHER parameter binding a `phase` local would shadow ambiguously.
  return fn.parameters.slice(1).every((parameter) => !containsPhaseBinding(parameter.name));
}

function bindingPropertyNameText(element: ts.BindingElement): string | null {
  const propertyName = element.propertyName;
  if (propertyName == null) {
    return null;
  }
  return ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)
    ? propertyName.text
    : // Computed property key: cannot statically prove it is not "phase".
      "phase";
}

function containsPhaseBinding(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === "phase";
  }
  return name.elements.some((element) => {
    if (ts.isOmittedExpression(element)) {
      return false;
    }
    return containsPhaseBinding(element.name);
  });
}

function introducesFunctionOrClassScope(node: ts.Node): boolean {
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

function classifyPhaseIdentifier(node: ts.Identifier): PhaseIdentifierClassification {
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

function staticStringArgument(argument: ts.Expression | undefined): string | null {
  if (argument == null) {
    return null;
  }
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return null;
}
