import type {
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import { z } from "zod";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { mapToolSubschemas, requiredPropertyNames } from "@/common/utils/tools/schemaSanitizer";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

const ZOD_UUID_PATTERN = z.toJSONSchema(z.uuid()).pattern;

// Built-in tools, whose schemas we build with zod, except agent_report, whose schema a workflow can
// supply under the same name. A bound, pattern or null that a workflow or an MCP server wrote may
// be deliberate. MCP tools never reach this set: collectTools reserves these names.
const ZOD_SCHEMA_TOOL_NAMES = new Set(
  Object.keys(TOOL_DEFINITIONS).filter((name) => name !== "agent_report")
);

function isNullSchema(schema: unknown): boolean {
  return isPlainObject(schema) && schema.type === "null" && Object.keys(schema).length === 1;
}

function withoutNullType(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.type)) return schema;
  const types: unknown[] = schema.type.filter((type) => type !== "null");
  if (types.length === 0 || types.length === schema.type.length) return schema;
  return { ...schema, type: types.length === 1 ? types[0] : types };
}

function withoutNullBranch(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.anyOf)) return schema;
  const { anyOf, ...rest } = schema;
  const branches: unknown[] = anyOf.filter((branch) => !isNullSchema(branch));
  if (branches.length === 0 || branches.length === anyOf.length) return schema;
  const [only] = branches;
  // Fold a lone branch into the property unless they share a key (both set `description`).
  return branches.length === 1 &&
    isPlainObject(only) &&
    Object.keys(only).every((k) => !(k in rest))
    ? { ...rest, ...only }
    : { ...rest, anyOf: branches };
}

function withoutOptionalNulls(schema: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(schema.properties)) return schema;
  const required = requiredPropertyNames(schema);
  const properties = Object.entries(schema.properties).map(
    ([name, property]): [string, unknown] => [
      name,
      !required.has(name) && isPlainObject(property)
        ? withoutNullBranch(withoutNullType(property))
        : property,
    ]
  );
  return { ...schema, properties: Object.fromEntries(properties) };
}

function withoutZodAddedKeywords(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  // zod puts these bounds on every `.int()`.
  if (out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  if (out.minimum === Number.MIN_SAFE_INTEGER) delete out.minimum;
  // Only the regex zod adds to `z.uuid()`: any other pattern is a real constraint.
  if (out.format === "uuid" && out.pattern === ZOD_UUID_PATTERN) delete out.pattern;
  return out;
}

/**
 * A tool's input schema as the model should read it. Built-in tools, which the AI SDK validates
 * against their zod schema rather than this JSON, also lose keywords zod adds and, on the Anthropic
 * wire, the `null` that only OpenAI strict mode needs (see toolDefinitions.ts).
 */
export function compactToolInputSchema(
  tool: Pick<LanguageModelV4FunctionTool, "name" | "inputSchema" | "strict">,
  options: { anthropicWire: boolean }
): JSONSchema7 {
  const { $schema: _schemaUri, ...schema } = tool.inputSchema;
  if (!ZOD_SCHEMA_TOOL_NAMES.has(tool.name)) return schema;
  const stripOptionalNulls = options.anthropicWire && tool.strict !== true;
  return mapToolSubschemas(schema, (node) => {
    const compacted = withoutZodAddedKeywords(node);
    return stripOptionalNulls ? withoutOptionalNulls(compacted) : compacted;
  }) as JSONSchema7;
}

// createAnthropic names its models "anthropic.messages" on every route (direct, Coder, custom
// anthropic-messages providers), and the gateway forwards anthropic/* models to Anthropic.
function sendsAnthropicMessages(model: Pick<LanguageModelV4, "provider" | "modelId">): boolean {
  return (
    model.provider === "anthropic.messages" ||
    (model.provider === "gateway" && model.modelId.startsWith("anthropic/"))
  );
}

export function createToolSchemaCompactionMiddleware(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: ({ params, model }) => {
      if (params.tools == null) return Promise.resolve(params);
      const anthropicWire = sendsAnthropicMessages(model);
      return Promise.resolve({
        ...params,
        tools: params.tools.map((tool) =>
          tool.type === "function"
            ? { ...tool, inputSchema: compactToolInputSchema(tool, { anthropicWire }) }
            : tool
        ),
      });
    },
  };
}
