import { describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { Ok } from "@/common/types/result";
import { shellQuote } from "@/common/utils/shell";
import { MCP_SERVER_INFO_META_KEY } from "@/node/services/mcpServerIdentity";
import type {
  ProviderModelFactory,
  ResolveAndCreateModelResult,
} from "@/node/services/providerModelFactory";
import {
  cleanupTestEnvironment,
  createTestEnvironment,
  setupProviders,
} from "../../../tests/ipc/setup";
import {
  HAIKU_MODEL,
  cleanupTempGitRepo,
  createStreamCollector,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
  readChatHistory,
  resolveOrpcClient,
  sendMessageWithModel,
} from "../../../tests/ipc/helpers";
import { assertStreamSuccess, type StreamCollector } from "../../../tests/ipc/streamCollector";

// Runs under `bun test` (not Jest): the PTC sandbox's type generator loads prettier, whose CJS
// bundle uses dynamic import(), which Jest's VM rejects without --experimental-vm-modules.
const FIXTURE_SERVER = path.resolve(
  import.meta.dir,
  "../../../tests/fixtures/mcp/modern-server.ts"
);
const MCP_SERVER_KEY = "identity";
const MCP_TOOL_NAME = "identity_identity_probe";

type WorkspaceEvent = ReturnType<StreamCollector["getEvents"]>[number];
type ToolCallEndEvent = Extract<WorkspaceEvent, { type: "tool-call-end" }>;

const FINISH_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * A provider that first emits the scripted tool call, then answers. Only the
 * language model is substituted: turn assembly, tool wrapping, the PTC
 * sandbox, the MCP process, and stream persistence are all real.
 */
function scriptedModel(toolCall: {
  toolName: string;
  input: unknown;
  toolCallId?: string;
}): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      step += 1;
      const chunks: LanguageModelV3StreamPart[] =
        step === 1
          ? [
              {
                type: "tool-call",
                toolCallId: toolCall.toolCallId ?? `scripted-${toolCall.toolName}`,
                toolName: toolCall.toolName,
                input: JSON.stringify(toolCall.input),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: FINISH_USAGE,
              },
            ]
          : [
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "done" },
              { type: "text-end", id: "answer" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: FINISH_USAGE,
              },
            ];
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [{ type: "stream-start", warnings: [] }, ...chunks],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      });
    },
  });
}

function toolCallEnds(collector: StreamCollector): ToolCallEndEvent[] {
  return collector.getEvents().filter((e): e is ToolCallEndEvent => e.type === "tool-call-end");
}

async function waitForToolCallEnd(
  collector: StreamCollector,
  predicate: (event: ToolCallEndEvent) => boolean,
  timeoutMs = 10_000
): Promise<ToolCallEndEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = toolCallEnds(collector).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`tool-call-end not observed: ${JSON.stringify(toolCallEnds(collector))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runScriptedTurn(
  collector: StreamCollector,
  env: Awaited<ReturnType<typeof createTestEnvironment>>,
  workspaceId: string,
  message: string,
  options?: { experiments?: { programmaticToolCalling: boolean } }
): Promise<void> {
  collector.clear();
  const sent = await sendMessageWithModel(env, workspaceId, message, HAIKU_MODEL, {
    thinkingLevel: "off",
    agentId: "exec",
    ...options,
  });
  expect(sent.success).toBe(true);
  expect(await collector.waitForEvent("stream-end", 60_000)).not.toBeNull();
  assertStreamSuccess(collector);
}

describe("MCP identity through real turn assembly", () => {
  test("top-level and PTC-nested MCP calls carry the originating execution's identity snapshot live and persisted", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    let workspaceId = "";
    let scopedCollector: StreamCollector | undefined;
    try {
      // The provider key only has to exist: model creation is substituted below.
      await setupProviders(env, { anthropic: { apiKey: "mock-model-key" } });
      const workspace = await createWorkspace(env, repoPath, generateBranchName("mcp-identity"));
      if (!workspace.success) throw new Error(workspace.error);
      workspaceId = workspace.metadata.id;
      const client = resolveOrpcClient(env);
      const added = await client.mcp.add({
        name: MCP_SERVER_KEY,
        command: `${shellQuote(process.execPath)} ${shellQuote(FIXTURE_SERVER)}`,
      });
      expect(added.success).toBe(true);

      // Substitute only the language model; everything downstream of
      // resolveAndCreateModel is the production path.
      const factory = (
        env.services.aiService as unknown as { providerModelFactory: ProviderModelFactory }
      ).providerModelFactory;
      let nextModel: () => MockLanguageModelV3 = () => {
        throw new Error("no scripted model for this turn");
      };
      spyOn(factory, "resolveAndCreateModel").mockImplementation(() =>
        Promise.resolve(
          Ok({
            model: nextModel(),
            effectiveModelString: HAIKU_MODEL,
            canonicalModelString: HAIKU_MODEL,
            canonicalProviderName: "anthropic",
            canonicalModelId: HAIKU_MODEL.slice(HAIKU_MODEL.indexOf(":") + 1),
            wireProviderName: "anthropic",
            routedThroughGateway: false,
          } satisfies ResolveAndCreateModelResult)
        )
      );

      scopedCollector = createStreamCollector(env.orpc, workspaceId);
      scopedCollector.start();
      await scopedCollector.waitForSubscription(5_000);

      // Turn 1: flat tool set, the model calls the MCP tool directly.
      nextModel = () => scriptedModel({ toolName: MCP_TOOL_NAME, input: {} });
      await runScriptedTurn(scopedCollector, env, workspaceId, "probe the identity server");
      const topLevelEnd = await waitForToolCallEnd(
        scopedCollector,
        (e) => e.toolName === MCP_TOOL_NAME && e.parentToolCallId === undefined
      );
      expect(topLevelEnd.mcpServer).toMatchObject({
        connection: { key: MCP_SERVER_KEY, transport: "stdio" },
        identity: { name: "Response identity", version: "2", title: "Fixture response" },
        source: "response",
      });
      // The display key never reaches the model-visible output; unrelated _meta survives.
      expect(JSON.stringify(topLevelEnd.result)).not.toContain(MCP_SERVER_INFO_META_KEY);
      expect(JSON.stringify(topLevelEnd.result)).toContain("preserved");

      // Turn 2: PTC exclusive posture, the model reaches the same MCP tool from the sandbox.
      nextModel = () =>
        scriptedModel({
          toolName: "code_execution",
          input: { code: `return xum.${MCP_TOOL_NAME}({});` },
        });
      await runScriptedTurn(scopedCollector, env, workspaceId, "probe it from the sandbox", {
        experiments: { programmaticToolCalling: true },
      });
      const nestedEnd = await waitForToolCallEnd(
        scopedCollector,
        (e) => e.toolName === MCP_TOOL_NAME && e.parentToolCallId !== undefined
      );
      expect(nestedEnd.parentToolCallId).toBe("scripted-code_execution");
      expect(nestedEnd.mcpServer).toMatchObject({
        connection: { key: MCP_SERVER_KEY, transport: "stdio" },
        identity: { name: "Response identity" },
        source: "response",
      });
      const parentEnd = await waitForToolCallEnd(
        scopedCollector,
        (e) => e.toolCallId === "scripted-code_execution"
      );
      // The sandbox result itself is not an MCP result: no snapshot on the parent.
      expect(parentEnd.mcpServer).toBeUndefined();

      // Turn 3: the server rejects the call. There is no result metadata to
      // replace the handshake identity, so the failed part keeps the
      // connection-derived snapshot the wrapper published before rethrowing.
      nextModel = () =>
        scriptedModel({ toolName: MCP_TOOL_NAME, input: { fail: true }, toolCallId: "failed" });
      await runScriptedTurn(scopedCollector, env, workspaceId, "make the probe fail");
      const failedEnd = await waitForToolCallEnd(scopedCollector, (e) => e.toolCallId === "failed");
      expect(failedEnd.result).toMatchObject({ success: false });
      expect(JSON.stringify(failedEnd.result)).toContain("fixture tool failure");
      expect(failedEnd.mcpServer).toEqual({
        connection: { key: MCP_SERVER_KEY, transport: "stdio" },
        identity: { name: "Connection identity", version: "1", title: "Fixture" },
        source: "connection",
      });

      // Persisted history: the snapshot is frozen on the part (top-level) and the
      // nested record (PTC). The nested record matching proves writer and consumer
      // shared one scope and one call id: the MCP wrapper published under
      // options.toolCallId, and the nested-event consumer took event.callId.
      const history = await readChatHistory(env.tempDir, workspaceId);
      const toolParts = history
        .filter((row) => row.role === "assistant")
        .flatMap((row) => row.parts.filter((part) => part.type === "dynamic-tool"));
      const persistedTop = toolParts.find((part) => part.toolCallId === topLevelEnd.toolCallId);
      expect(persistedTop?.mcpServer).toEqual(topLevelEnd.mcpServer);
      expect(JSON.stringify(persistedTop?.output)).not.toContain(MCP_SERVER_INFO_META_KEY);
      const persistedParent = toolParts.find(
        (part) => part.toolCallId === "scripted-code_execution"
      );
      expect(persistedParent?.mcpServer).toBeUndefined();
      const nestedCalls = persistedParent?.nestedCalls as
        | Array<Record<string, unknown>>
        | undefined;
      expect(nestedCalls).toHaveLength(1);
      expect(nestedCalls?.[0]?.toolCallId).toBe(nestedEnd.toolCallId);
      expect(nestedCalls?.[0]?.mcpServer).toEqual(nestedEnd.mcpServer);
      expect(JSON.stringify(nestedCalls?.[0]?.output)).not.toContain(MCP_SERVER_INFO_META_KEY);
      const persistedFailed = toolParts.find((part) => part.toolCallId === "failed");
      expect(persistedFailed?.state).toBe("output-available");
      expect(persistedFailed?.output).toMatchObject({ success: false });
      expect(persistedFailed?.mcpServer).toEqual(failedEnd.mcpServer);
    } finally {
      scopedCollector?.stop();
      if (workspaceId) {
        await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
      }
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});
