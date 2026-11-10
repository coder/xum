/**
 * Per-turn cost of the debug LLM request snapshot (#6912). Run: make bench BENCH=debugSnapshot
 *
 * One iteration is one turn's two captures, both synchronous on the backend event loop: the
 * request copy the turn builder stores before the stream starts, and the response the
 * stream-end handler attaches to it.
 */
import { bench, do_not_optimize } from "mitata";
import { Config } from "@/node/config";
import { ProvidersConfigStore } from "@/node/config/providersConfigStore";
import { AIService } from "@/node/services/aiService";
import { HistoryService } from "@/node/services/historyService";
import { InitStateManager } from "@/node/services/initStateManager";
import { ProviderService } from "@/node/services/providerService";
import { StreamManager } from "@/node/services/streamManager";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import type { StreamEndEvent } from "@/common/types/stream";

/** mitata passes this to generator benchmarks; get() returns the current .args() value. */
interface BenchState {
  get(name: string): unknown;
}

type EngineEventSink = Parameters<StreamManager["setEventSink"]>[0];

const WORKSPACE_ID = "bench-debug-snapshot";
const MESSAGE_ID = "assistant-bench";

/** Chat-like rows (user text, assistant text + tool call, JSON tool result) up to ~`mb` MB. */
function makeMessages(mb: number): unknown[] {
  const messages: unknown[] = [];
  const prose = "The quick brown fox jumps over the lazy dog while reading src/node/x.ts. ";
  let bytes = 0;
  for (let i = 0; bytes < mb * 1024 * 1024; i++) {
    const rows = [
      { role: "user", content: [{ type: "text", text: `${i}: ${prose.repeat(10)}` }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: prose.repeat(6) },
          {
            type: "tool-call",
            toolCallId: `call-${i}`,
            toolName: "file_read",
            input: { path: `src/f${i}.ts` },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${i}`,
            toolName: "file_read",
            output: {
              type: "json",
              value: {
                success: true,
                lines: Array.from({ length: 40 }, (_, n) => `${n}\t${prose}`),
              },
            },
          },
        ],
      },
    ];
    messages.push(...rows);
    bytes += JSON.stringify(rows).length;
  }
  return messages;
}

function makeStreamEnd(): StreamEndEvent {
  const prose = "Here is what I changed and why it matters for the request path. ";
  return {
    type: "stream-end",
    workspaceId: WORKSPACE_ID,
    messageId: MESSAGE_ID,
    metadata: { model: "anthropic:claude-opus-5-5" },
    parts: [{ type: "text", text: prose.repeat(120) }],
  };
}

bench("debug snapshot capture per turn ($mb MB request)", function* (state: BenchState) {
  const mb = state.get("mb") as number;
  // Kept until exit: AIService creates its sessions dir asynchronously after construction.
  const root = new DisposableTempDir("bench-debug-snapshot");
  process.once("exit", () => root[Symbol.dispose]());
  const config = new Config(root.path);
  const historyService = new HistoryService(config);
  const providerService = new ProviderService(config, new ProvidersConfigStore(config.rootDir));
  const streamManager = new StreamManager(historyService, undefined, () =>
    providerService.getConfig()
  );
  let sink: EngineEventSink | undefined;
  const install = streamManager.setEventSink.bind(streamManager);
  streamManager.setEventSink = (eventSink) => {
    sink = eventSink;
    install(eventSink);
  };
  const service = new AIService(
    config,
    historyService,
    new InitStateManager(config),
    providerService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    streamManager
  );
  if (sink == null) throw new Error("AIService did not install its engine event sink");
  const emit = sink;
  // The same store the turn builder writes before each stream (turnRequestBuilder.ts).
  // eslint-disable-next-line @typescript-eslint/dot-notation -- private members, bench only
  const store = service["turnRequestBuilder"]["dependencies"].lastLlmRequestByWorkspace;
  const snapshot: DebugLlmRequestSnapshot = {
    capturedAt: Date.now(),
    workspaceId: WORKSPACE_ID,
    messageId: MESSAGE_ID,
    model: "anthropic:claude-opus-5-5",
    providerName: "anthropic",
    thinkingLevel: "high",
    agentId: "exec",
    maxOutputTokens: 32_000,
    systemMessage: "You are a coding agent. ".repeat(2_000),
    messages: makeMessages(mb),
  };
  const streamEnd = makeStreamEnd();
  yield async () => {
    // The turn builder's line, verbatim: it copies the request before the stream starts.
    store.set(WORKSPACE_ID, structuredClone(snapshot));
    await emit(streamEnd);
    do_not_optimize(service.debugGetLastLlmRequest(WORKSPACE_ID));
  };
}).args("mb", [1, 4, 10]);
