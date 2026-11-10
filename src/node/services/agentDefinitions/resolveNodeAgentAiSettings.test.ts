import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it, spyOn } from "bun:test";

import { collectDefinitionLayers } from "@/common/utils/ai/agentAncestorLayers";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RuntimeError, type Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { DisposableTempDir } from "@/node/services/tempDir";

import * as agentDefinitionsService from "./agentDefinitionsService";
import {
  loadAgentDefinitionAiLayers,
  resolveChainAgentCacheTtl,
  resolveNodeAgentAiSettings,
  resolveNodeAgentAiSettingsWithLayers,
  type ResolveNodeAgentAiSettingsParams,
} from "./resolveNodeAgentAiSettings";
// The Node layer: these tests read through host runtimes.
import { nodeRuntimeFactory as runtimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";

// Unrecognized providers avoid capability clamping (see resolveAgentAiSettings.test.ts).
const MODEL_A = "custom:model-a";
const MODEL_B = "custom:model-b";
const MODEL_C = "custom:model-c";

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

  it("merges duplicate same-ID ancestors closer-first instead of dropping them", () => {
    // A project exec.md's cacheTtl must reach agents based on exec over a global exec.md's.
    const layers = collectDefinitionLayers("researcher", [
      { id: "researcher" },
      { id: "exec", ai: { thinkingLevel: "high", cacheTtl: "1h" } },
      { id: "exec", ai: { model: MODEL_A, cacheTtl: "5m" } },
    ]);
    expect(layers.targetDefinitionAiDefaults).toBeUndefined();
    expect(layers.ancestors).toEqual([
      {
        agentId: "exec",
        definitionAiDefaults: { model: MODEL_A, thinkingLevel: "high", cacheTtl: "1h" },
      },
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

describe("resolveChainAgentCacheTtl", () => {
  it("ranks an agent ID that comes back after another ancestor at its later hop", () => {
    // Project explore.md (base: helper) over a global helper.md (base: explore), whose base
    // skips the project explore and resolves to the built-in explore (5m): helper is closer.
    expect(
      resolveChainAgentCacheTtl("explore", undefined, [
        { id: "explore" },
        { id: "helper", ai: { cacheTtl: "1h" } },
        { id: "explore", ai: { cacheTtl: "5m" } },
      ])
    ).toBe("1h");
    // Nothing closer sets one, so the later hop's own value still applies.
    expect(
      resolveChainAgentCacheTtl("explore", undefined, [
        { id: "explore" },
        { id: "helper" },
        { id: "explore", ai: { cacheTtl: "5m" } },
      ])
    ).toBe("5m");
  });

  it("ranks a base ID that comes back after another ancestor at its later hop", () => {
    // Project scout -> project helper -> global relay -> global helper (a global agent's base
    // skips the project helper): relay is closer than the second helper hop, while helper's
    // Settings still rank at its first hop.
    const chain = [
      { id: "scout" },
      { id: "helper" },
      { id: "relay", ai: { cacheTtl: "1h" as const } },
      { id: "helper", ai: { cacheTtl: "5m" as const } },
    ];
    expect(resolveChainAgentCacheTtl("scout", undefined, chain)).toBe("1h");
    expect(resolveChainAgentCacheTtl("scout", { helper: { cacheTtl: "5m" } }, chain)).toBe("5m");
  });

  it("merges same-ID scope refinements closer-first", () => {
    // A project exec.md (base: exec) without a TTL keeps the built-in exec's; with one, it wins.
    expect(
      resolveChainAgentCacheTtl("exec", undefined, [
        { id: "exec", ai: { model: MODEL_A } },
        { id: "exec", ai: { cacheTtl: "1h" } },
      ])
    ).toBe("1h");
    expect(
      resolveChainAgentCacheTtl("exec", undefined, [
        { id: "exec", ai: { cacheTtl: "5m" } },
        { id: "exec", ai: { cacheTtl: "1h" } },
      ])
    ).toBe("5m");
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
      { runtime, workspacePath, workspaceId: "ws", runtimeFactory },
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
      { runtime, workspacePath, workspaceId: "ws", runtimeFactory },
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
    const context = { runtime, workspacePath, workspaceId: "ws", runtimeFactory };
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
    runtimeFactory,
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

describe("resolveNodeAgentAiSettings with ai.settingsBase (Cursor model: fast)", () => {
  const FAST = "base: exec\nai:\n  settingsBase: explore\n";

  async function resolveWatcher(
    frontmatter: string,
    params: Pick<ResolveNodeAgentAiSettingsParams, "cfg" | "parentRuntime">,
    otherAgents: Record<string, string> = {}
  ) {
    using project = new DisposableTempDir("settings-base-project");
    using home = new DisposableTempDir("settings-base-home");
    const agentsRoot = path.join(project.path, ".xum", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });
    for (const [id, agentFrontmatter] of Object.entries({
      "ci-watcher": frontmatter,
      ...otherAgents,
    })) {
      await fs.writeFile(
        path.join(agentsRoot, `${id}.md`),
        `---\nname: ${id}\n${agentFrontmatter}---\nBody.\n`
      );
    }
    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = home.path;
    try {
      return await resolveNodeAgentAiSettings({
        agentId: "ci-watcher",
        profile: "subagent",
        ...params,
        definitionContext: {
          runtime: new LocalRuntime(project.path),
          workspacePath: project.path,
          workspaceId: "ws",
          runtimeFactory,
        },
      });
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  }

  it("takes Explore's Settings model and thinking level", async () => {
    const resolved = await resolveWatcher(FAST, {
      cfg: {
        agentAiDefaults: {
          explore: { modelString: MODEL_A, thinkingLevel: "low" },
          exec: { modelString: MODEL_B, thinkingLevel: "high" },
        },
      },
    });
    expect(resolved.selected.model).toBe(MODEL_A);
    expect(resolved.selected.thinkingLevel).toBe("low");
  });

  it("takes the Exec model from Settings when Explore has none", async () => {
    const resolved = await resolveWatcher(FAST, {
      cfg: { agentAiDefaults: { exec: { modelString: MODEL_B } } },
      parentRuntime: { model: MODEL_C },
    });
    expect(resolved.selected.model).toBe(MODEL_B);
  });

  it("takes the parent model when neither Explore nor Exec has one in Settings", async () => {
    const resolved = await resolveWatcher(FAST, { cfg: {}, parentRuntime: { model: MODEL_C } });
    expect(resolved.selected.model).toBe(MODEL_C);
  });

  it("ranks the agent's own Settings entry above Explore's", async () => {
    const resolved = await resolveWatcher(FAST, {
      cfg: {
        agentAiDefaults: {
          "ci-watcher": { modelString: MODEL_C },
          explore: { modelString: MODEL_A },
        },
      },
    });
    expect(resolved.selected.model).toBe(MODEL_C);
  });

  const HELPER = { helper: "base: exec\nai:\n  settingsBase: explore\n" };

  it.each([
    ["missing-agent", "missing", {}],
    ["ci-watcher", "self", {}],
    ["helper", "nested", HELPER],
    // agents.list cannot resolve an agent whose base is missing, so a run ignores it as well.
    ["broken", "incomplete", { broken: "base: missing-base\n" }],
  ])("ignores settingsBase %s with a warning", async (settingsBase, reason, otherAgents) => {
    const warn = spyOn(log, "warn");
    try {
      const cfg = {
        agentAiDefaults: {
          explore: { modelString: MODEL_A },
          exec: { modelString: MODEL_B },
          helper: { modelString: MODEL_C },
        },
      };
      const ignored = await resolveWatcher(
        `base: exec\nai:\n  settingsBase: ${settingsBase}\n`,
        { cfg },
        otherAgents
      );
      const without = await resolveWatcher("base: exec\n", { cfg }, otherAgents);
      expect(ignored).toEqual(without);
      expect(ignored.selected.model).toBe(MODEL_B);
      expect(warn).toHaveBeenCalledWith("settingsBase ignored", {
        agentId: "ci-watcher",
        settingsBase,
        reason,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores the settings base of an agent whose own base is missing", async () => {
    const warn = spyOn(log, "warn");
    try {
      const cfg = { agentAiDefaults: { explore: { modelString: MODEL_A } } };
      const params = { cfg, parentRuntime: { model: MODEL_C } };
      const ignored = await resolveWatcher(
        "base: missing-base\nai:\n  settingsBase: explore\n",
        params
      );
      expect(ignored).toEqual(await resolveWatcher("base: missing-base\n", params));
      expect(ignored.selected.model).toBe(MODEL_C);
      expect(warn).toHaveBeenCalledWith("settingsBase ignored", {
        agentId: "ci-watcher",
        settingsBase: "explore",
        reason: "incomplete",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a global agent's settings base past a project agent of that ID", async () => {
    using project = new DisposableTempDir("settings-base-scope-project");
    using home = new DisposableTempDir("settings-base-scope-home");
    await fs.mkdir(path.join(project.path, ".xum", "agents"), { recursive: true });
    await fs.writeFile(
      path.join(project.path, ".xum", "agents", "explore.md"),
      `---\nname: Explore\nbase: exec\nai:\n  model: ${MODEL_A}\n---\nExplore.\n`
    );
    await fs.mkdir(path.join(home.path, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home.path, "agents", "ci-watcher.md"),
      "---\nname: ci-watcher\nbase: exec\nai:\n  settingsBase: explore\n---\nWatch CI.\n"
    );
    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = home.path;
    try {
      const resolved = await resolveNodeAgentAiSettings({
        agentId: "ci-watcher",
        profile: "subagent",
        cfg: {},
        parentRuntime: { model: MODEL_C },
        definitionContext: {
          runtime: new LocalRuntime(project.path),
          workspacePath: project.path,
          workspaceId: "ws",
          runtimeFactory,
        },
      });
      // The built-in Explore sets no model: the project explore.md's model must not reach it.
      expect(resolved.selected.model).toBe(MODEL_C);
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });

  it("rethrows a transport failure while reading the settings-base agent", async () => {
    const unreachable = new RuntimeError("ssh: Connection reset by peer", "network");
    const realRead = agentDefinitionsService.readAgentDefinition;
    const read = spyOn(agentDefinitionsService, "readAgentDefinition").mockImplementation(
      (runtime, workspacePath, agentId, options) =>
        agentId === "explore"
          ? Promise.reject(unreachable)
          : realRead(runtime, workspacePath, agentId, options)
    );
    try {
      const outcome = await resolveWatcher(FAST, { cfg: {} }).catch((error: unknown) => error);
      expect(outcome).toBe(unreachable);
    } finally {
      read.mockRestore();
    }
  });
});
