import { describe, expect, it } from "bun:test";

import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import { RuntimeError, type Runtime } from "@/node/runtime/Runtime";

import {
  collectDefinitionLayers,
  loadAgentDefinitionAiLayers,
  resolveNodeAgentAiSettings,
  resolveNodeAgentAiSettingsWithLayers,
} from "./resolveNodeAgentAiSettings";

// Unrecognized providers avoid capability clamping (see resolveAgentAiSettings.test.ts).
const MODEL_A = "custom:model-a";
const MODEL_B = "custom:model-b";

describe("collectDefinitionLayers", () => {
  it("merges same-ID scope refinements into the target layer field-wise", () => {
    // Project exec.md (base: exec) refines the global exec.md: the closer
    // scope wins per field, gaps fall through to the further scope.
    const layers = collectDefinitionLayers("exec", [
      { id: "exec", ai: { thinkingLevel: "high" } },
      { id: "exec", ai: { model: MODEL_A, thinkingLevel: "low" } },
    ]);
    expect(layers.targetDefinitionAiDefaults).toEqual({ model: MODEL_A, thinkingLevel: "high" });
    expect(layers.ancestors).toEqual([]);
  });

  it("merges duplicate same-ID ancestors instead of dropping them", () => {
    const layers = collectDefinitionLayers("researcher", [
      { id: "researcher" },
      { id: "exec", ai: { thinkingLevel: "high" } },
      { id: "exec", ai: { model: MODEL_A } },
    ]);
    expect(layers.targetDefinitionAiDefaults).toBeUndefined();
    expect(layers.ancestors).toEqual([
      { agentId: "exec", definitionAiDefaults: { model: MODEL_A, thinkingLevel: "high" } },
    ]);
  });

  it("keeps distinct ancestors in chain order", () => {
    const layers = collectDefinitionLayers("worker", [
      { id: "worker", ai: { model: MODEL_A } },
      { id: "researcher", ai: { thinkingLevel: "low" } },
      { id: "exec", ai: { model: MODEL_B } },
    ]);
    expect(layers.targetDefinitionAiDefaults).toEqual({ model: MODEL_A, thinkingLevel: undefined });
    expect(layers.ancestors).toEqual([
      { agentId: "researcher", definitionAiDefaults: { model: undefined, thinkingLevel: "low" } },
      { agentId: "exec", definitionAiDefaults: { model: MODEL_B, thinkingLevel: undefined } },
    ]);
  });

  it("same-ID base definition fields survive resolution", () => {
    // A project exec.md that only refines the prompt must not erase the
    // global exec.md's ai defaults from the definition tier.
    const layers = collectDefinitionLayers("exec", [
      { id: "exec" },
      { id: "exec", ai: { model: MODEL_A, thinkingLevel: "high" } },
    ]);
    const resolved = resolveAgentAiSettings({
      targetAgentId: "exec",
      profile: "interactive",
      ...layers,
    });
    expect(resolved.selected.model).toBe(MODEL_A);
    expect(resolved.selected.thinkingLevel).toBe("high");
    expect(resolved.sources.model).toEqual({ tier: "definition", agentId: "exec" });
  });
});

describe("calling workspace adapter context", () => {
  it("forwards Exec context without changing the gateway identity", async () => {
    const model = "coder:openai/gpt-5.6";
    const result = await resolveNodeAgentAiSettings({
      agentId: "exec",
      profile: "subagent",
      cfg: { agentAiDefaults: { exec: { modelString: MODEL_A } } },
      parentWorkspaceExecSettings: { model, thinkingLevel: "high" },
    });
    expect(result.selected.model).toBe(model);
    expect(result.sources.model).toEqual({ tier: "parent-workspace-exec", agentId: "exec" });
  });
});

/**
 * Runtime whose stat/readFile honor their abort signal: pending operations stay open
 * until aborted, and the fake counts in-flight operations and abort listeners so the
 * test can prove cancellation and cleanup rather than mere signal forwarding.
 */
function createAbortAwareRuntime(options: {
  /** Files that resolve immediately (content by path); every other stat hangs. */
  files?: Record<string, string>;
  /** Invoked when a file's content is read (lets a test abort mid-traversal). */
  onRead?: (path: string) => void;
}) {
  let markPending!: () => void;
  const pending = new Promise<void>((resolve) => (markPending = resolve));
  const state = { statPaths: [] as string[], inFlight: 0, listeners: 0, pending };
  const files = options.files ?? {};
  const runtime = {
    normalizePath: (target: string, base: string) => `${base}/${target}`,
    resolvePath: (path: string) => Promise.resolve(path),
    getXumHome: () => "/home/test/.xum",
    stat(path: string, signal?: AbortSignal) {
      state.statPaths.push(path);
      if (signal?.aborted) return Promise.reject(signal.reason as Error);
      const content = files[path];
      if (content != null) {
        return Promise.resolve({
          size: content.length,
          modifiedTime: new Date(0),
          isDirectory: false,
        });
      }
      state.inFlight += 1;
      markPending();
      return new Promise((_resolve, reject) => {
        if (signal == null) return; // never settles without a signal
        state.listeners += 1;
        signal.addEventListener(
          "abort",
          () => {
            state.inFlight -= 1;
            state.listeners -= 1;
            reject(signal.reason as Error);
          },
          { once: true }
        );
      });
    },
    readFile(path: string) {
      options.onRead?.(path);
      const content = files[path] ?? "";
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });
    },
  };
  return { runtime: runtime as unknown as Runtime, state };
}

describe("loadAgentDefinitionAiLayers cancellation", () => {
  const workspacePath = "/ws";
  const agentFile = (id: string) => `${workspacePath}/.xum/agents/${id}.md`;

  it("settles to null on abort, stops probing, and leaves nothing in flight", async () => {
    const { runtime, state } = createAbortAwareRuntime({});
    const controller = new AbortController();
    const pending = loadAgentDefinitionAiLayers(
      "worker",
      { runtime, workspacePath, workspaceId: "ws" },
      { abortSignal: controller.signal }
    );
    // Agent Plugins container discovery reads the host filesystem before the first stat.
    await state.pending;
    expect(state.inFlight).toBe(1);
    const statsBeforeAbort = state.statPaths.length;

    controller.abort(new Error("timed out"));
    expect(await pending).toBeNull();
    // No further candidates were probed after the abort, and the fake is clean.
    expect(state.statPaths.length).toBe(statsBeforeAbort);
    expect(state.inFlight).toBe(0);
    expect(state.listeners).toBe(0);
  });

  it("inheritance traversal issues no further reads after the abort", async () => {
    const controller = new AbortController();
    const { runtime, state } = createAbortAwareRuntime({
      files: {
        [agentFile("worker")]: "---\nname: Worker\nbase: researcher\n---\nBody\n",
      },
      // Abort while the target definition is being read, before its base is resolved.
      onRead: () => controller.abort(new Error("timed out")),
    });
    const result = await loadAgentDefinitionAiLayers(
      "worker",
      { runtime, workspacePath, workspaceId: "ws" },
      { abortSignal: controller.signal }
    );
    expect(result).toBeNull();
    expect(state.statPaths.some((path) => path.endsWith("/researcher.md"))).toBe(false);
    expect(state.inFlight).toBe(0);
    expect(state.listeners).toBe(0);
  });

  it("WithLayers matches the async path for the same inputs", async () => {
    const { runtime } = createAbortAwareRuntime({
      files: {
        [agentFile("worker")]: `---\nname: Worker\nai:\n  model: ${MODEL_B}\n---\nBody\n`,
      },
    });
    const context = { runtime, workspacePath, workspaceId: "ws" };
    // The global root probe for built-ins would hang; a live signal bounds it.
    const params = {
      agentId: "worker",
      profile: "subagent" as const,
      cfg: { agentAiDefaults: { exec: { thinkingLevel: "high" as const } } },
      fallbacks: [{ model: MODEL_A }],
    };
    const layers = await loadAgentDefinitionAiLayers("worker", context, {
      abortSignal: new AbortController().signal,
    });
    expect(layers).not.toBeNull();
    const viaLayers = resolveNodeAgentAiSettingsWithLayers(params, layers ?? { ancestors: [] });
    const viaAsync = await resolveNodeAgentAiSettings({ ...params, definitionContext: context });
    expect(viaLayers).toEqual(viaAsync);
    expect(viaLayers.selected.model).toBe(MODEL_B);
  });
});

describe("loadAgentDefinitionAiLayers read failures (#4829)", () => {
  const context = (stat: (path: string, signal?: AbortSignal) => Promise<never>) => ({
    runtime: {
      normalizePath: (target: string, base: string) => `${base}/${target}`,
      resolvePath: (path: string) => Promise.resolve(path),
      getXumHome: () => "/home/test/.xum",
      stat,
    } as unknown as Runtime,
    workspacePath: "/ws",
    workspaceId: "ws",
  });

  it("rethrows a transport failure instead of resolving without the chain", async () => {
    const unreachable = new RuntimeError("ssh: Connection reset by peer", "network");
    const loaded = await loadAgentDefinitionAiLayers(
      "worker",
      context(() => Promise.reject(unreachable))
    ).catch((error: unknown) => error);
    expect(loaded).toBe(unreachable);
    // resolveNodeAgentAiSettings must not fall back to default settings either.
    const resolved = await resolveNodeAgentAiSettings({
      agentId: "worker",
      profile: "subagent",
      cfg: {},
      definitionContext: context(() => Promise.reject(unreachable)),
    }).catch((error: unknown) => error);
    expect(resolved).toBe(unreachable);
  });

  it("still settles to null for other read failures and for aborted transport reads", async () => {
    const denied = await loadAgentDefinitionAiLayers(
      "worker",
      context(() => Promise.reject(new Error("EACCES: permission denied")))
    );
    expect(denied).toBeNull();

    // SSH2 reports an aborted exec as "network": the abort decides, not the error type.
    const controller = new AbortController();
    const aborted = await loadAgentDefinitionAiLayers(
      "worker",
      context(() => {
        controller.abort(new Error("timed out"));
        return Promise.reject(new RuntimeError("ssh: exec aborted", "network"));
      }),
      { abortSignal: controller.signal }
    );
    expect(aborted).toBeNull();
  });
});
