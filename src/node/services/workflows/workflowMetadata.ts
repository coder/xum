import type {
  WorkflowArgSummary,
  WorkflowDeclaredPhase,
  WorkflowMetadata,
} from "@/common/types/workflow";
import {
  WorkflowArgSummarySchema,
  WorkflowDeclaredPhaseSchema,
  WORKFLOW_DECLARED_PHASES_MAX,
  WORKFLOW_PHASE_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_PHASE_NAME_MAX_LENGTH,
} from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";
import { isPlainObject } from "@/common/utils/isPlainObject";
import {
  STATIC_METADATA_ERROR,
  isStaticMetadataBindingImmutable,
  parseStaticWorkflowMetadataLiteral,
  staticMetadataLiteralMayDeclareKey,
} from "./staticWorkflowMetadata";

export function parseWorkflowMetadata(source: string): WorkflowMetadata | null {
  let rawMetadata: unknown;
  try {
    rawMetadata = parseStaticWorkflowMetadataLiteral(source);
  } catch {
    return null;
  }
  if (!isPlainObject(rawMetadata)) {
    return null;
  }
  return rawMetadata;
}

export class WorkflowDeclaredPhasesValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    assert(issues.length > 0, "WorkflowDeclaredPhasesValidationError: issues are required");
    super(`Workflow meta.phases is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowDeclaredPhasesValidationError";
    this.issues = issues;
  }
}

const DECLARED_PHASE_KNOWN_KEYS = new Set(["name", "label", "description", "parallel"]);

/**
 * Read and validate `meta.phases` straight from workflow source. This is the
 * entry point for run creation and read-path hydration.
 *
 * Unlike {@link parseWorkflowMetadata}, a `meta` literal the static parser cannot
 * read is reported as INVALID when it may declare `phases` (a top-level `phases`
 * key, a dynamic computed key, or a spread): `const phases = [...]; export const
 * meta = { phases };` would otherwise start undeclared (and the read path could
 * even hydrate an inferred rail for it) instead of surfacing the static-literal
 * requirement to the author. Unreadable meta that cannot declare phases keeps
 * its legacy behavior — ignored — so existing workflows stay startable.
 *
 * A declaration that DOES parse must also be immutable: `export let meta` or a
 * later mention of `meta` (reassignment, mutation, aliasing) could change the
 * exported phases after the static read, so those are rejected too.
 */
export function parseDeclaredPhasesFromSource(source: string): WorkflowDeclaredPhase[] | undefined {
  let rawMetadata: unknown;
  try {
    rawMetadata = parseStaticWorkflowMetadataLiteral(source);
  } catch {
    if (!staticMetadataLiteralMayDeclareKey(source, "phases")) {
      return undefined;
    }
    throw new WorkflowDeclaredPhasesValidationError([
      `${STATIC_METADATA_ERROR}; meta.phases cannot be read from this meta declaration`,
    ]);
  }
  const phases = parseDeclaredPhases(isPlainObject(rawMetadata) ? rawMetadata : null);
  if (phases != null && !isStaticMetadataBindingImmutable(source)) {
    throw new WorkflowDeclaredPhasesValidationError([
      "meta.phases requires an immutable declaration: use `export const meta` and do not reference `meta` elsewhere in the script",
    ]);
  }
  return phases;
}

/**
 * Parse and validate `meta.phases` from already-parsed workflow metadata.
 *
 * Returns `undefined` when the metadata declares no phases (zero behavior
 * change for legacy scripts). Throws {@link WorkflowDeclaredPhasesValidationError}
 * enumerating EVERY issue at once (callscript-style fail-fast) when the
 * declaration is present but invalid — callers on the run-creation path reject
 * the run; read-path callers treat the throw as "no manifest".
 */
export function parseDeclaredPhases(
  metadata: WorkflowMetadata | null
): WorkflowDeclaredPhase[] | undefined {
  const rawPhases = metadata?.phases;
  if (rawPhases === undefined) {
    return undefined;
  }

  const issues: string[] = [];
  if (!Array.isArray(rawPhases)) {
    throw new WorkflowDeclaredPhasesValidationError(["meta.phases must be an array"]);
  }
  if (rawPhases.length === 0) {
    issues.push("meta.phases must declare at least one phase");
  }
  if (rawPhases.length > WORKFLOW_DECLARED_PHASES_MAX) {
    issues.push(`meta.phases must declare at most ${WORKFLOW_DECLARED_PHASES_MAX} phases`);
  }

  const phases: WorkflowDeclaredPhase[] = [];
  const seenNames = new Set<string>();
  rawPhases.forEach((rawPhase, index) => {
    const where = `meta.phases[${index}]`;
    if (!isPlainObject(rawPhase)) {
      issues.push(`${where} must be an object`);
      return;
    }
    for (const key of Object.keys(rawPhase)) {
      if (!DECLARED_PHASE_KNOWN_KEYS.has(key)) {
        issues.push(`${where} has unknown key "${key}"`);
      }
    }
    const name = validateBoundedString(
      rawPhase.name,
      `${where}.name`,
      WORKFLOW_PHASE_NAME_MAX_LENGTH,
      issues
    );
    if (name != null) {
      if (seenNames.has(name)) {
        issues.push(`${where}.name duplicates phase name "${name}"`);
      }
      seenNames.add(name);
    }
    const label =
      rawPhase.label === undefined
        ? undefined
        : validateBoundedString(
            rawPhase.label,
            `${where}.label`,
            WORKFLOW_PHASE_NAME_MAX_LENGTH,
            issues
          );
    const description =
      rawPhase.description === undefined
        ? undefined
        : validateBoundedString(
            rawPhase.description,
            `${where}.description`,
            WORKFLOW_PHASE_DESCRIPTION_MAX_LENGTH,
            issues
          );
    if (rawPhase.parallel !== undefined && typeof rawPhase.parallel !== "boolean") {
      issues.push(`${where}.parallel must be a boolean`);
    }
    if (name != null) {
      phases.push({
        name,
        ...(label != null ? { label } : {}),
        ...(description != null ? { description } : {}),
        ...(typeof rawPhase.parallel === "boolean" ? { parallel: rawPhase.parallel } : {}),
      });
    }
  });

  if (issues.length > 0) {
    throw new WorkflowDeclaredPhasesValidationError(issues);
  }
  // Second-algorithm check: the wire schema must accept everything the manual
  // validator accepted, so the two cannot drift.
  return phases.map((phase) => WorkflowDeclaredPhaseSchema.parse(phase));
}

function validateBoundedString(
  value: unknown,
  where: string,
  maxLength: number,
  issues: string[]
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${where} must be a non-empty string`);
    return null;
  }
  if (value.length > maxLength) {
    issues.push(`${where} must be at most ${maxLength} characters`);
    return null;
  }
  return value;
}

export function summarizeWorkflowArgs(
  metadata: WorkflowMetadata | null
): WorkflowArgSummary[] | undefined {
  const argsSchema = metadata?.argsSchema;
  if (!isPlainObject(argsSchema) || argsSchema.type !== "object") {
    return undefined;
  }
  const rawProperties = argsSchema.properties;
  if (!isPlainObject(rawProperties)) {
    return undefined;
  }

  const required = new Set(nonEmptyStringArray(argsSchema.required));
  const summaries = Object.entries(rawProperties)
    .map(([name, rawProperty]) => summarizeWorkflowArg(name, rawProperty, required))
    .filter((summary): summary is WorkflowArgSummary => summary != null);
  return summaries.length > 0 ? summaries : undefined;
}

function summarizeWorkflowArg(
  name: string,
  rawProperty: unknown,
  required: ReadonlySet<string>
): WorkflowArgSummary | null {
  if (!isPlainObject(rawProperty)) {
    return null;
  }
  const summary: WorkflowArgSummary = {
    name,
    types: schemaTypes(rawProperty.type),
    required: required.has(name),
  };

  if (Object.prototype.hasOwnProperty.call(rawProperty, "default")) {
    summary.default = rawProperty.default;
  }

  const enumValues = Array.isArray(rawProperty.enum) ? rawProperty.enum : [];
  if (enumValues.length > 0) summary.enum = enumValues;

  if (typeof rawProperty.minimum === "number" && Number.isFinite(rawProperty.minimum)) {
    summary.minimum = rawProperty.minimum;
  }
  if (typeof rawProperty.maximum === "number" && Number.isFinite(rawProperty.maximum)) {
    summary.maximum = rawProperty.maximum;
  }

  return WorkflowArgSummarySchema.parse(summary);
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  if (Array.isArray(value)) {
    const types = nonEmptyStringArray(value);
    return types.length > 0 ? Array.from(new Set(types)) : ["unknown"];
  }
  return ["unknown"];
}

function nonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
