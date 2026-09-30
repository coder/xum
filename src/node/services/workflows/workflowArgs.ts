import { isPlainObject } from "@/common/utils/isPlainObject";
import { parseStaticWorkflowMetadataLiteral } from "./staticWorkflowMetadata";

export interface WorkflowArgsNormalizationResult {
  args: unknown;
  metadata: WorkflowMetadata | null;
}

export class WorkflowArgsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowArgsValidationError";
  }
}

export interface WorkflowArgsNormalizationOptions {
  defaultArgs?: Record<string, unknown>;
}

interface WorkflowMetadata {
  argsSchema?: Record<string, unknown>;
}

interface ArgsPropertySchema {
  name: string;
  types: string[];
  defaultValue: unknown;
  minimum: number | null;
  maximum: number | null;
  enumValues: unknown[];
}

// Shared by assertObjectSchema and propertySchemas so the two `properties`
// validators can't drift to differing messages for the same failure.
const ARGS_SCHEMA_PROPERTIES_ERROR_MESSAGE =
  "Workflow meta.argsSchema.properties must be an object";

export function normalizeWorkflowArgsForSource(
  source: string,
  rawArgs: unknown,
  options: WorkflowArgsNormalizationOptions = {}
): WorkflowArgsNormalizationResult {
  const meta = parseWorkflowMetadata(source);
  if (meta?.argsSchema == null) {
    return { args: rawArgs, metadata: meta };
  }

  return {
    args: normalizeWorkflowArgs(meta.argsSchema, rawArgs, options.defaultArgs ?? {}),
    metadata: meta,
  };
}

function parseWorkflowMetadata(source: string): WorkflowMetadata | null {
  let rawMetadata: unknown;
  try {
    rawMetadata = parseStaticWorkflowMetadataLiteral(source);
  } catch {
    return null;
  }
  if (!isPlainObject(rawMetadata)) {
    throw validationError("Workflow meta must be a static object literal");
  }
  const meta: WorkflowMetadata = {};
  if (rawMetadata.argsSchema !== undefined) {
    if (!isPlainObject(rawMetadata.argsSchema)) {
      throw validationError("Workflow meta.argsSchema must be an object schema");
    }
    meta.argsSchema = rawMetadata.argsSchema;
  }
  return meta;
}

function validationError(message: string): WorkflowArgsValidationError {
  return new WorkflowArgsValidationError(message);
}

function normalizeWorkflowArgs(
  schema: Record<string, unknown>,
  rawArgs: unknown,
  defaultArgs: Record<string, unknown>
): Record<string, unknown> {
  assertObjectSchema(schema);
  const properties = propertySchemas(schema);
  const normalized: Record<string, unknown> = {};

  for (const property of properties) {
    if (property.defaultValue !== undefined) {
      normalized[property.name] = property.defaultValue;
    } else if (property.name in defaultArgs) {
      // Invocation context should help only workflows that explicitly declare the field.
      normalized[property.name] = defaultArgs[property.name];
    }
  }

  if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
    throw validationError("Workflow args must be an object for object argsSchema");
  }

  if (isPlainObject(rawArgs)) {
    for (const property of properties) {
      if (property.name in rawArgs) {
        normalized[property.name] = rawArgs[property.name];
      }
    }
  }

  const coerced: Record<string, unknown> = {};
  for (const property of properties) {
    if (!(property.name in normalized)) {
      continue;
    }
    coerced[property.name] = coerceProperty(property, normalized[property.name]);
  }

  validateRequired(schema, coerced);
  return coerced;
}

function assertObjectSchema(schema: Record<string, unknown>): void {
  if (schema.type !== "object") {
    throw validationError('Workflow meta.argsSchema must have type "object"');
  }
  if (!isPlainObject(schema.properties)) {
    throw validationError(ARGS_SCHEMA_PROPERTIES_ERROR_MESSAGE);
  }
}

function propertySchemas(schema: Record<string, unknown>): ArgsPropertySchema[] {
  const rawProperties = schema.properties;
  if (!isPlainObject(rawProperties)) {
    throw validationError(ARGS_SCHEMA_PROPERTIES_ERROR_MESSAGE);
  }

  return Object.entries(rawProperties).map(([name, rawProperty]) => {
    if (!isPlainObject(rawProperty)) {
      throw validationError(`Workflow args property ${name} must be an object schema`);
    }
    return {
      name,
      types: schemaTypes(rawProperty.type),
      defaultValue: rawProperty.default,
      minimum: optionalNumber(rawProperty.minimum),
      maximum: optionalNumber(rawProperty.maximum),
      enumValues: Array.isArray(rawProperty.enum) ? rawProperty.enum : [],
    };
  });
}

function schemaTypes(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) {
    const types = type.filter((candidate): candidate is string => typeof candidate === "string");
    return types.length > 0 ? Array.from(new Set(types)) : ["string"];
  }
  return ["string"];
}

function propertyAllowsType(property: ArgsPropertySchema, type: string): boolean {
  return property.types.includes(type);
}

function coerceProperty(property: ArgsPropertySchema, value: unknown): unknown {
  if (value === null) {
    if (propertyAllowsType(property, "null")) return null;
    throw validationError(`Workflow argument ${property.name} must not be null`);
  }

  let lastError: Error | null = null;
  for (const type of property.types) {
    if (type === "null") continue;
    try {
      const coerced = coercePropertyType(property, value, type);
      validateBounds(property, coerced);
      validateEnum(property, coerced);
      return coerced;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw (
    lastError ??
    validationError(
      `Unsupported workflow args type for ${property.name}: ${property.types.join(", ")}`
    )
  );
}

function coercePropertyType(property: ArgsPropertySchema, value: unknown, type: string): unknown {
  switch (type) {
    case "string":
      return coerceString(value, property.name);
    case "boolean":
      return coerceBoolean(value, property.name);
    case "integer":
      return coerceInteger(value, property.name);
    case "number":
      return coerceNumber(value, property.name);
    case "array":
      return coerceArray(value, property.name);
    default:
      throw validationError(`Unsupported workflow args type for ${property.name}: ${type}`);
  }
}

function coerceString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw validationError(`Workflow argument ${name} must be a string`);
  }
  return value.trim();
}

function coerceBoolean(value: unknown, name: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw validationError(`Workflow argument ${name} must be a boolean`);
}

function coerceInteger(value: unknown, name: string): number {
  const number = coerceNumber(value, name);
  if (!Number.isInteger(number)) {
    throw validationError(`Workflow argument ${name} must be an integer`);
  }
  return number;
}

function coerceNumber(value: unknown, name: string): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    throw validationError(`Workflow argument ${name} must be a number`);
  }
  return number;
}

function coerceArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw validationError(`Workflow argument ${name} must be an array`);
  }
  return value;
}

function validateBounds(property: ArgsPropertySchema, value: unknown): void {
  if (typeof value !== "number") {
    return;
  }
  if (property.minimum != null && value < property.minimum) {
    throw validationError(`Workflow argument ${property.name} must be >= ${property.minimum}`);
  }
  if (property.maximum != null && value > property.maximum) {
    throw validationError(`Workflow argument ${property.name} must be <= ${property.maximum}`);
  }
}

function validateEnum(property: ArgsPropertySchema, value: unknown): void {
  if (property.enumValues.length === 0) {
    return;
  }
  if (!property.enumValues.some((candidate) => Object.is(candidate, value))) {
    throw validationError(
      `Workflow argument ${property.name} must be one of: ${property.enumValues.join(", ")}`
    );
  }
}

function validateRequired(schema: Record<string, unknown>, value: Record<string, unknown>): void {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const property of required) {
    if (typeof property !== "string") {
      throw validationError("Workflow meta.argsSchema.required entries must be strings");
    }
    if (!(property in value)) {
      throw validationError(`Workflow argument ${property} is required`);
    }
  }
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
