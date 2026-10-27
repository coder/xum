/**
 * The agent loop on test layers only (5b PR 9). One AgentSession drives the real AIService,
 * StreamManager, TurnRequestBuilder and tools, as agentSession.pinnedBudget.test.ts builds them,
 * but every host service is a test layer: memory session files and locks, a TestClock, the
 * memory host (HostFiles, HostPaths and its FakeRuntime) and a scripted model.
 *
 * Config stays on the disk, in a root that the caller creates before it arms the trap: the
 * disk rule of the proof allows Config's calls under that root (claim 4.3).
 */
import { Effect, Layer } from "effect";
import type { LanguageModel } from "ai";
import { Ok } from "@/common/types/result";
import type { MuxMessage } from "@/common/types/message";
import { AIService } from "./aiService";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import { HostClockTag } from "./di/hostClockLive";
import { RuntimeFactoryTag } from "./di/tags";
import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import type { MemoryHost } from "./hostFiles/memoryHostFiles.testHarness";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import type { ProviderModelFactory } from "./providerModelFactory";
import { RuntimeFactoryFake } from "./runtimeFactory/fakeRuntimeFactory.testHarness";
import { SessionFilesMemory } from "./sessionFiles/memorySessionFiles.testHarness";
import { SessionLocksMemory } from "./sessionLocks/memorySessionLocks.testHarness";
import { StreamManager } from "./streamManager";
import { Config } from "@/node/config";
import { HistoryService } from "./historyService";
import { buildSessionFiles } from "./sessionFiles/buildSessionFiles.testHarness";
import { buildSessionLocks } from "./sessionLocks/buildSessionLocks.testHarness";

/** The workspace runs in place at this path of the memory volume. */
export const IN_MEMORY_WORKSPACE_PATH = "/ws";
const WORKSPACE_ID = "inmemoryproof";
const MODEL = "anthropic:claude-haiku-4-5";

export interface InMemoryLoop {
  readonly clock: TestEffectRunner;
  readonly harness: AgentSessionHarness;
  send(text: string): Promise<void>;
  /** Resolves once the turn's stream ended. */
  waitForStreamEnd(): Promise<void>;
  /** The results of every `tool-call-end` event of `toolName`, in order. */
  toolResults(toolName: string): unknown[];
  chatRoles(): Promise<string[]>;
  /** The text parts of the last assistant message. */
  lastAssistantText(): Promise<string>;
  /** Stops the session and Config's and ProviderService's file watches. Not the clock. */
  dispose(): Promise<void>;
}

/** Waits at most this many TestClock steps of 10 ms for the stream end. */
const MAX_STREAM_END_STEPS = 1000;

export async function makeInMemoryLoop(input: {
  host: MemoryHost;
  /** An existing empty dir on the disk: Config's root. The caller creates and removes it. */
  configRoot: string;
  model: LanguageModel;
}): Promise<InMemoryLoop> {
  const clock = makeTestEffectRunner();
  const lockDeps = Layer.mergeAll(Layer.succeed(HostClockTag)(clock.hostClock), input.host.layer);
  const config = new Config(input.configRoot);
  const historyService = new HistoryService(
    config,
    buildSessionFiles(SessionFilesMemory),
    buildSessionLocks(SessionLocksMemory.pipe(Layer.provide(lockDeps)))
  );
  config.findWorkspace = () => ({
    projectPath: IN_MEMORY_WORKSPACE_PATH,
    workspacePath: IN_MEMORY_WORKSPACE_PATH,
  });
  const init = new InitStateManager(config);
  init.waitForInit = () => Promise.resolve();
  // RuntimeFactoryFake: every runtime of the turn is the FakeRuntime of the memory host.
  const runtimeFactory = Effect.runSync(
    Effect.gen(function* () {
      return yield* RuntimeFactoryTag;
    }).pipe(Effect.provide(RuntimeFactoryFake(input.host)))
  );
  const streamManager = new StreamManager(
    historyService,
    undefined,
    undefined,
    undefined,
    clock.runner,
    undefined,
    undefined,
    { hostClock: clock.hostClock }
  );
  const providerService = new ProviderService(config);
  const service = new AIService(
    config,
    historyService,
    init,
    providerService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    streamManager,
    undefined,
    undefined,
    undefined,
    { runtimeFactory, hostFiles: input.host.files, hostPaths: input.host.paths }
  );
  const factory = Reflect.get(service, "providerModelFactory") as ProviderModelFactory;
  factory.resolveAndCreateModel = () =>
    Promise.resolve(
      Ok({
        model: input.model,
        effectiveModelString: MODEL,
        canonicalModelString: MODEL,
        canonicalProviderName: "anthropic",
        canonicalModelId: "claude-haiku-4-5",
        wireProviderName: "anthropic",
      })
    ) as ReturnType<ProviderModelFactory["resolveAndCreateModel"]>;
  service.getWorkspaceMetadata = () =>
    Promise.resolve(
      Ok({
        id: WORKSPACE_ID,
        name: IN_MEMORY_WORKSPACE_PATH,
        projectName: "proof",
        projectPath: IN_MEMORY_WORKSPACE_PATH,
        runtimeConfig: { type: "local" as const },
      })
    );
  const harness = await createAgentSessionHarness({
    workspaceId: WORKSPACE_ID,
    config,
    historyService,
    aiService: service,
    streamManager,
    aiEmitter: service,
    initStateManager: init,
    effectRunner: clock.runner,
    captureEvents: true,
  });
  const events = () =>
    harness.events as Array<{ type: string; toolName?: string; result?: unknown }>;
  const messages = async (): Promise<MuxMessage[]> => {
    const result = await historyService.getHistoryFromLatestBoundary(WORKSPACE_ID);
    if (!result.success) throw new Error(result.error);
    return result.data;
  };
  return {
    clock,
    harness,
    async send(text) {
      const result = await harness.session.sendMessage(text, { model: MODEL, agentId: "exec" });
      if (!result.success) throw new Error(JSON.stringify(result.error));
    },
    async waitForStreamEnd() {
      for (let step = 0; !events().some((event) => event.type === "stream-end"); step++) {
        if (step >= MAX_STREAM_END_STEPS) throw new Error("the turn's stream did not end");
        await clock.adjust(10);
      }
    },
    toolResults(toolName) {
      return events()
        .filter((event) => event.type === "tool-call-end" && event.toolName === toolName)
        .map((event) => event.result);
    },
    async chatRoles() {
      return (await messages()).map((message) => message.role);
    },
    async lastAssistantText() {
      const assistant = (await messages()).findLast((message) => message.role === "assistant");
      return (assistant?.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    },
    async dispose() {
      await harness.session.dispose();
      providerService.dispose();
      config.stopWatchingConfigFile();
    },
  };
}
