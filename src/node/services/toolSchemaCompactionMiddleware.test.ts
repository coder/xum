import { describe, expect, it } from "bun:test";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { generateText, jsonSchema, tool, wrapLanguageModel, type Tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  compactToolInputSchema,
  createToolSchemaCompactionMiddleware,
} from "@/node/services/toolSchemaCompactionMiddleware";

/** The tool input schemas a model behind the middleware receives, by tool name. */
async function sentSchemas(
  provider: string,
  modelId: string,
  tools: Record<string, Tool>
): Promise<Record<string, unknown>> {
  const inner = new MockLanguageModelV4({
    provider,
    modelId,
    doGenerate: {
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  const model = wrapLanguageModel({
    model: inner,
    middleware: createToolSchemaCompactionMiddleware(),
  });
  await generateText({ model, prompt: "hi", tools });
  return Object.fromEntries(
    (inner.doGenerateCalls[0]?.tools ?? []).flatMap((sent) =>
      sent.type === "function" ? [[sent.name, sent.inputSchema]] : []
    )
  );
}

/** Paths of every schema node that admits null. */
function nullPaths(node: unknown, at = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => nullPaths(item, `${at}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const { type } = node as { type?: unknown };
  const own = type === "null" || (Array.isArray(type) && type.includes("null")) ? [at] : [];
  return own.concat(
    Object.entries(node).flatMap(([key, value]) => nullPaths(value, `${at}.${key}`))
  );
}

const compact = (name: string, inputSchema: Record<string, unknown>, anthropicWire = true) =>
  compactToolInputSchema({ name, inputSchema: inputSchema as JSONSchema7 }, anthropicWire);

describe("tool schema compaction", () => {
  it("drops $schema, safe-integer bounds and zod's uuid regex on every wire", async () => {
    const sent = await sentSchemas("openai.responses", "gpt-6", {
      sample: tool({
        inputSchema: z.object({
          id: z.uuid(),
          count: z.number().int().min(1).nullish(),
          guid: z.guid(),
        }),
      }),
    });

    expect(sent.sample).toEqual({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        count: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        // Not zod's uuid regex: a real constraint the format does not state.
        guid: { type: "string", format: "uuid", pattern: expect.any(String) as unknown },
      },
      required: ["id", "guid"],
      additionalProperties: false,
    });
  });

  it("drops null from optional built-in fields only on Anthropic wires", async () => {
    const tools = {
      task_await: tool({ inputSchema: TOOL_DEFINITIONS.task_await.schema }),
      linear_update_issue: tool({
        inputSchema: jsonSchema({
          type: "object",
          properties: { assigneeId: { type: ["string", "null"] } },
        }),
      }),
    };
    const anthropic = await sentSchemas("anthropic.messages", "claude-opus-5-5", tools);
    const gateway = await sentSchemas("gateway", "anthropic/claude-opus-5-5", tools);
    const openai = await sentSchemas("gateway", "openai/gpt-6", tools);

    expect(nullPaths(anthropic.task_await)).toEqual([]);
    expect(nullPaths(gateway.task_await)).toEqual([]);
    expect(nullPaths(openai.task_await)).not.toEqual([]);
    expect((anthropic.task_await as JSONSchema7).properties?.timeout_secs).toEqual({
      default: 600,
      description: expect.any(String) as string,
      type: "number",
      minimum: 0,
    });
    // An MCP tool's null may mean "clear the field".
    expect(nullPaths(anthropic.linear_update_issue)).toEqual(["$.properties.assigneeId"]);
  });

  it("keeps null where the schema needs it", () => {
    const optionalNull = { properties: { note: { type: ["string", "null"] } } };
    // Workflow report schemas are authored by the workflow, and strict tools must list nulls.
    expect(nullPaths(compact("agent_report", optionalNull))).not.toEqual([]);
    expect(
      nullPaths(
        compactToolInputSchema(
          { name: "task_await", inputSchema: optionalNull as JSONSchema7, strict: true },
          true
        )
      )
    ).not.toEqual([]);

    expect(
      compact("task_await", {
        type: "object",
        properties: {
          required: { type: ["boolean", "null"] },
          both: { description: "outer", anyOf: [{ description: "inner" }, { type: "null" }] },
          union: { type: ["string", "number", "null"] },
          nested: {
            anyOf: [
              { type: "object", properties: { inner: { type: ["string", "null"] } } },
              { type: "null" },
            ],
          },
        },
        required: ["required"],
      })
    ).toEqual({
      type: "object",
      properties: {
        required: { type: ["boolean", "null"] },
        both: { description: "outer", anyOf: [{ description: "inner" }] },
        union: { type: ["string", "number"] },
        nested: { type: "object", properties: { inner: { type: "string" } } },
      },
      required: ["required"],
    });
  });
});
