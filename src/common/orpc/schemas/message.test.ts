import { describe, expect, test } from "bun:test";
import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { utf8JsonByteLength } from "@/common/utils/mcp/utf8ByteBudget";
import { MuxMessageSchema } from "./message";

function createMessage() {
  return {
    id: "msg-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "Hello" }],
  };
}

describe("MuxMessageSchema mcpPromptSnapshot parsing", () => {
  test("strips malformed snapshot metadata instead of failing the history parse", () => {
    const malformedSnapshotValues: unknown[] = [null, {}, { serverName: 42 }, "snapshot", []];

    for (const malformed of malformedSnapshotValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        role: "user" as const,
        metadata: {
          synthetic: true,
          mcpPromptSnapshot: malformed,
          agentSkillSnapshot: malformed,
        },
      });

      expect(parsed.metadata?.mcpPromptSnapshot).toBeUndefined();
      expect(parsed.metadata?.agentSkillSnapshot).toBeUndefined();
    }
  });

  test("preserves invokingMessageId across boundary parsing", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      role: "user" as const,
      metadata: {
        synthetic: true,
        mcpPromptSnapshot: {
          serverName: "coder",
          promptName: "review",
          commandKey: "mcp__coder__review",
          invokingMessageId: "user-1",
        },
      },
    });

    expect(parsed.metadata?.mcpPromptSnapshot?.invokingMessageId).toBe("user-1");
  });
});

describe("MuxMessageSchema step boundaries", () => {
  test("preserves step indices and continuous summary metadata across replay", () => {
    const metadata = {
      stepStartPartIndices: [0, 2, 5],
      muxMetadata: { type: "compaction-summary", strategy: "continuous" },
    };
    const parsed = MuxMessageSchema.parse({ ...createMessage(), metadata });
    expect(parsed.metadata?.stepStartPartIndices).toEqual(metadata.stepStartPartIndices);
    expect(parsed.metadata?.muxMetadata).toEqual(metadata.muxMetadata);
  });

  test("ignores malformed step metadata rather than failing chat replay", () => {
    for (const stepStartPartIndices of [null, "0,2", [0, "2"], {}]) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: { stepStartPartIndices },
      });
      expect(parsed.metadata?.stepStartPartIndices).toBeUndefined();
      expect(parsed.parts).toEqual(createMessage().parts);
    }
  });
});

describe("MuxMessageSchema compactionEpoch parsing", () => {
  test("preserves valid positive integer compactionEpoch", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        compactionEpoch: 7,
      },
    });

    expect(parsed.metadata?.compactionEpoch).toBe(7);
  });

  test("preserves acpPromptId metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        acpPromptId: "acp-prompt-123",
      },
    });

    expect(parsed.metadata?.acpPromptId).toBe("acp-prompt-123");
  });

  test("preserves routeProvider metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        routeProvider: "openai",
      },
    });

    expect(parsed.metadata?.routeProvider).toBe("openai");
  });

  test("preserves modelFallback metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        modelFallback: {
          requestedModel: "openai:gpt-5.5",
          refusedModels: ["openai:gpt-5.5", "google:gemini-3.1-pro-preview"],
        },
      },
    });

    expect(parsed.metadata?.modelFallback).toEqual({
      requestedModel: "openai:gpt-5.5",
      refusedModels: ["openai:gpt-5.5", "google:gemini-3.1-pro-preview"],
    });
  });

  test("preserves unknown muxMetadata as an opaque value", () => {
    const legacyMetadata = {
      type: "removed-feature",
      rawCommand: "/removed legacy command",
      nested: { version: 1 },
    };
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: { muxMetadata: legacyMetadata },
    });

    expect(parsed.metadata?.muxMetadata).toEqual(legacyMetadata);
  });

  test("tolerates malformed modelFallback values by treating them as absent", () => {
    const malformedModelFallbackValues: unknown[] = [
      null,
      "openai:gpt-5.5",
      7,
      [],
      {},
      { requestedModel: "openai:gpt-5.5" }, // missing refusedModels
      { refusedModels: ["openai:gpt-5.5"] }, // missing requestedModel
      { requestedModel: "openai:gpt-5.5", refusedModels: [7] }, // wrong element type
      { requestedModel: 7, refusedModels: ["openai:gpt-5.5"] },
    ];

    for (const malformedModelFallback of malformedModelFallbackValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: {
          modelFallback: malformedModelFallback,
        },
      });

      expect(parsed.metadata?.modelFallback).toBeUndefined();
    }
  });

  test("tolerates malformed compactionEpoch values by treating them as absent", () => {
    const malformedCompactionEpochValues: unknown[] = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "7",
      null,
      true,
      {},
      [],
    ];

    for (const malformedCompactionEpoch of malformedCompactionEpochValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: {
          compactionEpoch: malformedCompactionEpoch,
        },
      });

      expect(parsed.metadata?.compactionEpoch).toBeUndefined();
    }
  });
});

describe("MuxMessageSchema mcpServer snapshots", () => {
  const validSnapshot: MCPToolCallDisplay = {
    connection: { key: "identity", transport: "stdio" },
    identity: { name: "Response identity", version: "2" },
    source: "response",
  };
  // Every field individually valid, but the serialized whole exceeds the snapshot byte budget.
  const overBudget: MCPToolCallDisplay = {
    ...validSnapshot,
    identity: {
      ...validSnapshot.identity,
      title: "字".repeat(80),
      description: "字".repeat(300),
      websiteUrl: `https://example.com/${"a".repeat(490)}`,
    },
    connection: {
      key: "字".repeat(80),
      transport: "http",
      origin: `https://${"a".repeat(250)}:65535`,
    },
  };
  expect(utf8JsonByteLength(overBudget)).toBeGreaterThan(
    MCP_IDENTITY_LIMITS.displaySnapshotMaxBytes
  );
  const toolMessage = (mcpServer: unknown, nestedMcpServer: unknown) => ({
    ...createMessage(),
    parts: [
      {
        type: "dynamic-tool" as const,
        toolCallId: "code-exec",
        toolName: "code_execution",
        input: { code: "…" },
        state: "output-available" as const,
        output: { ok: true },
        ...(mcpServer === "absent" ? {} : { mcpServer }),
        nestedCalls: [
          {
            toolCallId: "nested-1",
            toolName: "identity_identity_probe",
            input: {},
            output: { content: [] },
            state: "output-available" as const,
            ...(nestedMcpServer === "absent" ? {} : { mcpServer: nestedMcpServer }),
          },
        ],
      },
    ],
  });
  const parsedSnapshots = (mcpServer: unknown, nestedMcpServer: unknown) => {
    const parsed = MuxMessageSchema.parse(toolMessage(mcpServer, nestedMcpServer));
    const part = parsed.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected the tool part to survive parsing");
    }
    expect(part.output).toEqual({ ok: true });
    expect(part.nestedCalls?.[0]?.output).toEqual({ content: [] });
    return { top: part.mcpServer, nested: part.nestedCalls?.[0]?.mcpServer };
  };

  test("rows written before the field existed and rows without a snapshot parse unchanged", () => {
    expect(parsedSnapshots("absent", "absent")).toEqual({ top: undefined, nested: undefined });
  });

  test("valid snapshots are preserved on the part and on nested records", () => {
    expect(parsedSnapshots(validSnapshot, validSnapshot)).toEqual({
      top: validSnapshot,
      nested: validSnapshot,
    });
  });

  const malformed: unknown[] = [
    null,
    "snapshot",
    [],
    { connection: validSnapshot.connection, source: "response" },
    { ...validSnapshot, identity: { name: "", version: "2" } },
    { ...validSnapshot, connection: { key: "identity", transport: "auto" } },
    { ...validSnapshot, source: "handshake" },
    overBudget,
  ];
  // Rows are wrapped so an array value is one argument, not spread arguments.
  test.each(malformed.map((bad) => [bad]))(
    "malformed or over-budget snapshot %j degrades to absent without losing the message",
    (bad) => {
      // Each level degrades independently: a bad nested snapshot never taints the part and vice versa.
      expect(parsedSnapshots(bad, validSnapshot)).toEqual({
        top: undefined,
        nested: validSnapshot,
      });
      expect(parsedSnapshots(validSnapshot, bad)).toEqual({
        top: validSnapshot,
        nested: undefined,
      });
    }
  );
});
