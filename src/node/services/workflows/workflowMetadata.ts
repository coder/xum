import type { WorkflowArgSummary, WorkflowMetadata } from "@/common/types/workflow";
import { WorkflowArgSummarySchema } from "@/common/orpc/schemas";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { parseStaticWorkflowMetadataLiteral } from "./staticWorkflowMetadata";

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
