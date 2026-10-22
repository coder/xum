import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { mapToolSubschemas, requiredPropertyNames } from "@/common/utils/tools/schemaSanitizer";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

const ZOD_UUID_PATTERN = z.toJSONSchema(z.uuid()).pattern;

// Workflow agents get an agent_report schema the workflow author wrote, where null may mean
// something. MCP tools never reach this set: collectTools reserves every TOOL_DEFINITIONS name.
const NULL_STRIPPED_TOOL_NAMES = new Set(
  Object.keys(TOOL_DEFINITIONS).filter((name) => name !== "agent_report")
);

function isNullSchema(schema: unknown): boolean {
  return isPlainObject(schema) && schema.type === "null" && Object.keys(schema).length === 1;
}

/** The schema with `null` dropped from its type list, unless null is its only type. */
function withoutNullType(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.type)) return schema;
  const types: unknown[] = schema.type.filter((type) => type !== "null");
  if (types.length === 0 || types.length === schema.type.length) return schema;
  return { ...schema, type: types.length === 1 ? types[0] : types };
}

/** The schema with its `null` anyOf branch dropped, unless null is its only branch. */
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

/** The object schema with `null` dropped from every optional property. */
function withoutOptionalNulls(schema: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(schema.properties)) return schema;
  const required = requiredPropertyNames(schema);
  const properties = Object.entries(schema.properties).map(([name, property]) => [
    name,
    !required.has(name) && isPlainObject(property)
      ? withoutNullBranch(withoutNullType(property))
      : property,
  ]);
  return { ...schema, properties: Object.fromEntries(properties) };
}

function withoutZodDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  // zod puts these bounds on every `.int()`.
  if (out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  if (out.minimum === Number.MIN_SAFE_INTEGER) delete out.minimum;
  // Only the regex zod adds to `z.uuid()`: any other pattern is a real constraint.
  if (out.format === "uuid" && out.pattern === ZOD_UUID_PATTERN) delete out.pattern;
  return out;
}

/**
 * A tool's input schema as the model should read it. The AI SDK validates tool input against the
 * tool's own schema (zod for built-ins), never this JSON, so keywords that tell the model nothing
 * go. On the Anthropic wire, built-in tools also lose `null` from optional fields: those are
 * `.nullish()` only so that OpenAI strict mode, which requires every field, can skip one (see
 * toolDefinitions.ts). Anthropic lets the model omit them, and handlers read null and absent alike.
 */
export function compactToolInputSchema(
  tool: Pick<LanguageModelV4FunctionTool, "name" | "inputSchema" | "strict">,
  options: { anthropicWire: boolean }
): JSONSchema7 {
  const stripOptionalNulls =
    options.anthropicWire && tool.strict !== true && NULL_STRIPPED_TOOL_NAMES.has(tool.name);
  const { $schema: _schemaUri, ...schema } = tool.inputSchema;
  return mapToolSubschemas(schema, (node) => {
    const compacted = withoutZodDefaults(node);
    return stripOptionalNulls ? withoutOptionalNulls(compacted) : compacted;
  }) as JSONSchema7;
}

/**
 * Whether a resolved SDK model speaks the Anthropic Messages wire. Check the resolved model, not
 * the requested prefix: createAnthropic names its models "anthropic.messages" on every route
 * (direct, Coder, custom anthropic-messages providers), and the gateway forwards anthropic/*
 * models to Anthropic.
 */
export function isAnthropicMessagesModel(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
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
      const anthropicWire = isAnthropicMessagesModel(model);
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
