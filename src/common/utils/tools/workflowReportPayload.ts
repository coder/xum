import { validateJsonSchemaSubset } from "@/common/utils/jsonSchemaSubset";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getRequiredProperties(schema: Record<string, unknown>): Set<string> {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []
  );
  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      if (!isRecord(subSchema)) {
        continue;
      }
      for (const key of getRequiredProperties(subSchema)) {
        required.add(key);
      }
    }
  }
  return required;
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return true;
  }
  if (schema.type === "null") {
    return true;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null");
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(null);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const options = schema[keyword];
    if (Array.isArray(options) && options.some((option) => schemaAllowsNull(option))) {
      return true;
    }
  }
  return false;
}

function normalizeProperties(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
  required: Set<string>
): Record<string, unknown> {
  const normalized = { ...value };
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (!(propertyName in normalized)) {
      continue;
    }
    if (
      normalized[propertyName] === null &&
      !required.has(propertyName) &&
      !schemaAllowsNull(propertySchema)
    ) {
      delete normalized[propertyName];
      continue;
    }
    normalized[propertyName] = normalizeWorkflowAgentReportPayloadForHostSchema(
      propertySchema,
      normalized[propertyName]
    );
  }
  return normalized;
}

function normalizeMatchingUnionBranch(
  schema: Record<string, unknown>,
  value: Record<string, unknown>
): Record<string, unknown> | null {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const options = schema[keyword];
    if (!Array.isArray(options)) {
      continue;
    }
    for (const option of options) {
      const normalized = normalizeWorkflowAgentReportPayloadForHostSchema(option, value);
      if (!isRecord(normalized)) {
        continue;
      }
      if (validateJsonSchemaSubset(option, normalized).success) {
        return normalized;
      }
    }
  }
  return null;
}

/**
 * OpenAI strict tool schemas require every object property and represent originally-optional
 * properties as nullable. For host validation/persistence, a `null` value for an optional
 * non-nullable field means "the model omitted it", not an explicit workflow value.
 */
export function normalizeWorkflowAgentReportPayloadForHostSchema(
  schema: unknown,
  value: unknown
): unknown {
  if (!isRecord(schema)) {
    return value;
  }
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (Array.isArray(itemSchema)) {
      return value.map((item, index) =>
        normalizeWorkflowAgentReportPayloadForHostSchema(itemSchema[index], item)
      );
    }
    return value.map((item) => normalizeWorkflowAgentReportPayloadForHostSchema(itemSchema, item));
  }
  if (!isRecord(value)) {
    return value;
  }

  let normalized: Record<string, unknown> = { ...value };
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (properties != null) {
    normalized = normalizeProperties(normalized, properties, getRequiredProperties(schema));
  }

  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      normalized = normalizeWorkflowAgentReportPayloadForHostSchema(
        subSchema,
        normalized
      ) as Record<string, unknown>;
    }
  }

  return normalizeMatchingUnionBranch(schema, normalized) ?? normalized;
}
