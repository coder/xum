import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import { z } from "zod";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { requiredPropertyNames } from "@/common/utils/tools/schemaSanitizer";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

// Recurse only into subschemas: const, enum, default and examples hold data. Draft-07
// `dependencies` is a map whose values are schemas or property-name lists; a list holds only
// strings, which a rewrite leaves alone.
const TOOL_SUBSCHEMA_KEY =
  /^(items|prefixItems|additionalItems|contains|additionalProperties|propertyNames|not|if|then|else|anyOf|allOf|oneOf|unevaluatedItems|unevaluatedProperties)$/;
const TOOL_SCHEMA_MAP_KEY =
  /^(properties|patternProperties|\$defs|definitions|dependentSchemas|dependencies)$/;

/** Rewrite every subschema of a JSON Schema bottom-up: children first, then the schema itself. */
export function mapToolSubschemas(
  node: unknown,
  rewrite: (schema: Record<string, unknown>) => Record<string, unknown>,
  depth: "schema" | "map" = "schema"
): unknown {
  if (Array.isArray(node)) return node.map((item) => mapToolSubschemas(item, rewrite));
  if (!isPlainObject(node)) return node;
  const out = Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (depth === "map" || TOOL_SUBSCHEMA_KEY.test(key)) {
        return [key, mapToolSubschemas(value, rewrite)];
      }
      return [
        key,
        TOOL_SCHEMA_MAP_KEY.test(key) ? mapToolSubschemas(value, rewrite, "map") : value,
      ];
    })
  );
  return depth === "map" ? out : rewrite(out);
}

const ZOD_UUID_PATTERN: unknown = (z.toJSONSchema(z.uuid()) as { pattern?: unknown }).pattern;

// Workflow agents get an agent_report schema the workflow author wrote, where null may mean
// something. MCP tools never reach this set: collectTools reserves every TOOL_DEFINITIONS name.
const OPTIONAL_NULL_TOOL_NAMES = new Set(
  Object.keys(TOOL_DEFINITIONS).filter((name) => name !== "agent_report")
);

function isNullSchema(schema: unknown): boolean {
  return isPlainObject(schema) && schema.type === "null" && Object.keys(schema).length === 1;
}

/** The schema with `null` dropped from its alternatives (a type list or anyOf branches). */
function withoutNull(schema: Record<string, unknown>): Record<string, unknown> {
  let out = schema;
  if (Array.isArray(out.type) && out.type.length > 1 && out.type.includes("null")) {
    const types: unknown[] = out.type.filter((type) => type !== "null");
    out = { ...out, type: types.length === 1 ? types[0] : types };
  }
  if (Array.isArray(out.anyOf) && out.anyOf.length > 1 && out.anyOf.some(isNullSchema)) {
    const { anyOf, ...rest } = out;
    const branches: unknown[] = anyOf.filter((branch) => !isNullSchema(branch));
    const [only] = branches;
    // Fold a lone branch into the property unless their keys clash (both described).
    out =
      branches.length === 1 && isPlainObject(only) && Object.keys(only).every((k) => !(k in rest))
        ? { ...rest, ...only }
        : { ...rest, anyOf: branches };
  }
  return out;
}

function compactSchemaNode(
  schema: Record<string, unknown>,
  stripOptionalNulls: boolean
): Record<string, unknown> {
  const out = { ...schema };
  if (out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  if (out.minimum === Number.MIN_SAFE_INTEGER) delete out.minimum;
  if (out.format === "uuid" && out.pattern === ZOD_UUID_PATTERN) delete out.pattern;
  if (stripOptionalNulls && isPlainObject(out.properties)) {
    const required = requiredPropertyNames(out);
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([name, property]) => [
        name,
        !required.has(name) && isPlainObject(property) ? withoutNull(property) : property,
      ])
    );
  }
  return out;
}

/**
 * A tool's input schema as the model should read it. Every request resends every schema, but
 * the AI SDK validates tool input against the tool's own schema (zod for built-ins), never this
 * JSON, so keywords that tell the model nothing go: `$schema`, the ±MAX_SAFE_INTEGER bounds zod
 * puts on every `.int()`, and the regex zod adds to `format: "uuid"`.
 *
 * On the Anthropic wire, built-in tools also lose `null` from their optional fields. Those
 * fields are `.nullish()` so that OpenAI's strict mode, which makes every field required, can
 * still skip one (see toolDefinitions.ts). Anthropic lets the model omit the field, and the
 * handlers read null and absent alike.
 */
export function compactToolInputSchema(
  tool: Pick<LanguageModelV4FunctionTool, "name" | "inputSchema" | "strict">,
  anthropicWire: boolean
): JSONSchema7 {
  const stripOptionalNulls =
    anthropicWire && tool.strict !== true && OPTIONAL_NULL_TOOL_NAMES.has(tool.name);
  const { $schema: _schemaUri, ...schema } = tool.inputSchema;
  return mapToolSubschemas(schema, (node) =>
    compactSchemaNode(node, stripOptionalNulls)
  ) as JSONSchema7;
}

/**
 * createAnthropic names its models "anthropic.messages" on every route (direct, Coder, custom
 * anthropic-messages providers); the Xum gateway forwards anthropic/* models to Anthropic.
 */
function sendsAnthropicMessages(model: { provider: string; modelId: string }): boolean {
  return (
    model.provider === "anthropic.messages" ||
    (model.provider === "gateway" && model.modelId.startsWith("anthropic/"))
  );
}

/** Applies compactToolInputSchema to every function tool of every request. */
export function createToolSchemaCompactionMiddleware(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: ({ params, model }) => {
      if (params.tools == null || params.tools.length === 0) return Promise.resolve(params);
      const anthropicWire = sendsAnthropicMessages(model);
      return Promise.resolve({
        ...params,
        tools: params.tools.map((tool) =>
          tool.type === "function"
            ? { ...tool, inputSchema: compactToolInputSchema(tool, anthropicWire) }
            : tool
        ),
      });
    },
  };
}
