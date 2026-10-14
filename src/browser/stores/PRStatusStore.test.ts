import { describe, expect, it, mock, spyOn } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeStatus } from "./RuntimeStatusStore";
import { PRStatusStore, parseMergeQueueEntry } from "./PRStatusStore";

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createWorkspaceMetadata(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"]
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux",
    projectPath: "/tmp/mux",
    namedWorkspacePath: `/tmp/mux/${workspaceId}`,
    runtimeConfig,
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for passive GitHub refresh");
    }
    await sleep(10);
  }
}

function createRuntimeStatusStoreMock(initialStatus: RuntimeStatus | null) {
  let runtimeStatus = initialStatus;
  const subscribeKeyListeners = new Map<string, Set<() => void>>();

  return {
    runtimeStatusStore: {
      getStatus: (_workspaceId: string) => runtimeStatus,
      subscribeKey: (workspaceId: string, listener: () => void) => {
        let listeners = subscribeKeyListeners.get(workspaceId);
        if (!listeners) {
          listeners = new Set();
          subscribeKeyListeners.set(workspaceId, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners?.delete(listener);
        };
      },
    },
    setStatus: (nextStatus: RuntimeStatus | null) => {
      runtimeStatus = nextStatus;
    },
    emit(workspaceId: string) {
      for (const listener of Array.from(subscribeKeyListeners.get(workspaceId) ?? [])) {
        listener();
      }
    },
    getListenerCount(workspaceId: string) {
      return subscribeKeyListeners.get(workspaceId)?.size ?? 0;
    },
  };
}

async function runPassiveRefreshScenario(
  metadata: FrontendWorkspaceMetadata,
  runtimeStatus: RuntimeStatus | null,
  shouldRun: boolean
): Promise<number> {
  const executeBash = mock(() => {
    // Return failures because these tests only assert whether runtime gating invokes both commands.
    return Promise.resolve({ success: false as const, error: "gh unavailable" });
  });

  const store = new PRStatusStore({
    getStatus: () => runtimeStatus,
  });

  try {
    store.setClient({
      workspace: {
        executeBash,
      },
    } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

    store.syncWorkspaces(new Map([[metadata.id, metadata]]));
    await sleep(0);
    store.subscribeWorkspace(metadata.id, () => undefined);

    if (shouldRun) {
      await waitUntil(() => executeBash.mock.calls.length === 2);
    } else {
      await sleep(100);
    }

    return executeBash.mock.calls.length;
  } finally {
    store.dispose();
  }
}

describe("passive refresh runtime gating", () => {
  it("skips passive PR refresh for stopped devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-stopped", DEVCONTAINER_RUNTIME),
      "stopped",
      false
    );

    expect(callCount).toBe(0);
  });

  it("skips passive PR refresh for unknown devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-unknown", DEVCONTAINER_RUNTIME),
      "unknown",
      false
    );

    expect(callCount).toBe(0);
  });

  it("runs passive PR refresh for running devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-running", DEVCONTAINER_RUNTIME),
      "running",
      true
    );

    expect(callCount).toBe(2);
  });

  it("retries PR refresh when devcontainer runtime transitions from null to running", async () => {
    const metadata = createWorkspaceMetadata("dc-retry", DEVCONTAINER_RUNTIME);
    const runtimeStatusStore = createRuntimeStatusStoreMock(null);
    const executeBash = mock(() => {
      return Promise.resolve({ success: false as const, error: "gh unavailable" });
    });
    const store = new PRStatusStore(runtimeStatusStore.runtimeStatusStore);

    try {
      store.setClient({
        workspace: {
          executeBash,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(new Map([[metadata.id, metadata]]));
      await sleep(0);
      store.subscribeWorkspace(metadata.id, () => undefined);

      await waitUntil(() => runtimeStatusStore.getListenerCount(metadata.id) > 0);
      expect(executeBash.mock.calls.length).toBe(0);

      runtimeStatusStore.setStatus("running");
      runtimeStatusStore.emit(metadata.id);

      await waitUntil(() => executeBash.mock.calls.length === 2);
      expect(executeBash.mock.calls.length).toBe(2);
    } finally {
      store.dispose();
    }
  });

  it("does not retry PR refresh when devcontainer runtime stays stopped", async () => {
    const metadata = createWorkspaceMetadata("dc-stays-stopped", DEVCONTAINER_RUNTIME);
    const runtimeStatusStore = createRuntimeStatusStoreMock(null);
    const executeBash = mock(() => {
      return Promise.resolve({ success: false as const, error: "gh unavailable" });
    });
    const store = new PRStatusStore(runtimeStatusStore.runtimeStatusStore);

    try {
      store.setClient({
        workspace: {
          executeBash,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(new Map([[metadata.id, metadata]]));
      await sleep(0);
      store.subscribeWorkspace(metadata.id, () => undefined);

      await waitUntil(() => runtimeStatusStore.getListenerCount(metadata.id) > 0);
      expect(executeBash.mock.calls.length).toBe(0);

      runtimeStatusStore.setStatus("stopped");
      runtimeStatusStore.emit(metadata.id);
      await sleep(100);

      expect(executeBash.mock.calls.length).toBe(0);
    } finally {
      store.dispose();
    }
  });

  it("runs passive PR refresh for non-devcontainer workspace", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("wt-1", DEFAULT_RUNTIME_CONFIG),
      "unknown",
      true
    );

    expect(callCount).toBe(2);
  });
});

// #4662: opening a workspace must not spawn gh pr/stack probes while its chat replay runs.
describe("chat replay gating", () => {
  it.each(["the chat replay settles", "the last subscriber leaves"] as const)(
    "defers PR and stack probes until %s",
    async (release) => {
      const metadata = createWorkspaceMetadata("replay-pending", DEFAULT_RUNTIME_CONFIG);
      const executeBash = mock(() =>
        Promise.resolve({ success: false as const, error: "gh unavailable" })
      );
      let pending = true;
      const gateListeners = new Set<() => void>();
      const store = new PRStatusStore({ getStatus: () => null });

      try {
        store.setChatReplayGate({
          isReplayPending: () => pending,
          subscribeKey: (_workspaceId, listener) => {
            gateListeners.add(listener);
            return () => gateListeners.delete(listener);
          },
        });
        store.setClient({
          workspace: { executeBash },
        } as unknown as Parameters<PRStatusStore["setClient"]>[0]);
        store.syncWorkspaces(new Map([[metadata.id, metadata]]));
        const unsubscribe = store.subscribeWorkspace(metadata.id, () => undefined);

        await waitUntil(() => gateListeners.size === 1);
        expect(executeBash.mock.calls.length).toBe(0);

        if (release === "the last subscriber leaves") {
          // The last subscriber leaving must release the watcher on WorkspaceStore.
          unsubscribe();
          expect(gateListeners.size).toBe(0);
          return;
        }
        pending = false;
        for (const listener of Array.from(gateListeners)) listener();

        await waitUntil(() => executeBash.mock.calls.length === 2);
        const scripts = executeBash.mock.calls.map(
          (call) => ((call as unknown[])[0] as { script: string }).script
        );
        expect(scripts.some((script) => script.includes("gh pr view"))).toBe(true);
        expect(scripts.some((script) => script.includes("gh stack view"))).toBe(true);
        expect(gateListeners.size).toBe(0);
        unsubscribe();
      } finally {
        store.dispose();
      }
    }
  );
});

// AppLoader replays setClient(api) + syncWorkspaces(map) on every workspace metadata event. Once the
// PR/stack caches go stale, only a relevant metadata change may spawn gh probes.
describe("metadata-driven refreshes", () => {
  type ProbeResult =
    | { success: false; error: string }
    | {
        success: true;
        data: { success: true; output: string; exitCode: 0; wall_duration_ms: 0 };
      };
  const probeOutput = (output: string): ProbeResult => ({
    success: true,
    data: { success: true, output, exitCode: 0, wall_duration_ms: 0 },
  });
  // "No PR" for the PR probe; the stack probe parses it as "no stack". Both succeed.
  const noPullRequest = () => probeOutput('{"no_pr":true}');

  async function openWorkspace(options: {
    ageCaches: boolean;
    respond?: (script: string) => ProbeResult;
  }) {
    const open = createWorkspaceMetadata("pr-open", DEFAULT_RUNTIME_CONFIG);
    const other = createWorkspaceMetadata("pr-other", DEFAULT_RUNTIME_CONFIG);
    let gate: Promise<void> = Promise.resolve();
    let respond = options.respond ?? noPullRequest;
    const executeBash = mock(async (input: { script: string }) => {
      await gate;
      return respond(input.script);
    });
    const client = { workspace: { executeBash } } as unknown as Parameters<
      PRStatusStore["setClient"]
    >[0];
    const store = new PRStatusStore({ getStatus: () => null });
    let metadata = new Map([
      [open.id, open],
      [other.id, other],
    ]);

    store.setClient(client);
    store.syncWorkspaces(metadata);
    let unsubscribe = store.subscribeWorkspace(open.id, () => undefined);
    await waitUntil(() => executeBash.mock.calls.length >= 2);
    await sleep(20);

    // Optionally age every PR and stack cache entry past its TTL so any refresh would probe again.
    const realNow = Date.now.bind(Date);
    const nowSpy = options.ageCaches
      ? spyOn(Date, "now").mockImplementation(() => realNow() + 120_000)
      : null;
    executeBash.mockClear();

    return {
      store,
      executeBash,
      setResponse(next: (script: string) => ProbeResult) {
        respond = next;
      },
      unsubscribe() {
        unsubscribe();
        unsubscribe = () => undefined;
      },
      resubscribe() {
        unsubscribe = store.subscribeWorkspace(open.id, () => undefined);
      },
      /** Holds every later gh probe until the returned release function runs. */
      holdProbes() {
        let release: () => void = () => undefined;
        gate = new Promise((resolve) => {
          release = resolve;
        });
        return release;
      },
      /** Applies one onMetadata-style entry replacement, in AppLoader's call order. */
      emit(workspaceId: string, patch: Partial<FrontendWorkspaceMetadata>) {
        const current = metadata.get(workspaceId);
        if (current == null) {
          throw new Error(`Missing metadata for ${workspaceId}`);
        }
        metadata = new Map(metadata).set(workspaceId, { ...current, ...patch });
        store.setClient(client);
        store.syncWorkspaces(metadata);
      },
      [Symbol.dispose]() {
        nowSpy?.mockRestore();
        unsubscribe();
        store.dispose();
      },
    };
  }

  it("does not probe GitHub for unrelated metadata events", async () => {
    using workspace = await openWorkspace({ ageCaches: true });

    for (let i = 0; i < 10; i++) {
      workspace.emit("pr-other", { title: `Other ${i}`, isInitializing: i % 2 === 0 });
      workspace.emit("pr-open", { title: `Open ${i}`, tags: { round: String(i) } });
    }
    await sleep(50);

    expect(workspace.executeBash.mock.calls.length).toBe(0);
  });

  it("probes promptly when the open workspace's runtime changes", async () => {
    using workspace = await openWorkspace({ ageCaches: true });

    workspace.emit("pr-open", { runtimeConfig: { type: "worktree", srcBaseDir: "/srv/xum/src" } });

    // Well inside the 5 s debounce: the refresh must not wait for it.
    await waitUntil(() => workspace.executeBash.mock.calls.length === 2, 1000);
  });

  // Unrelated events no longer retry, so the PR (5 s) and stack (60 s) cache TTLs must not
  // swallow the single refresh a relevant change requests, or the previous checkout's PR stays.
  it("probes promptly when the open workspace moves within the cache TTLs", async () => {
    using workspace = await openWorkspace({ ageCaches: false });

    workspace.emit("pr-open", { name: "pr-open-renamed" });

    await waitUntil(() => workspace.executeBash.mock.calls.length === 2, 1000);
  });

  it("probes promptly when the workspace moved while nothing displayed it", async () => {
    using workspace = await openWorkspace({ ageCaches: false });
    workspace.unsubscribe();
    workspace.emit("pr-open", { name: "pr-open-renamed" });
    await sleep(50);
    expect(workspace.executeBash.mock.calls.length).toBe(0);

    workspace.resubscribe();

    await waitUntil(() => workspace.executeBash.mock.calls.length === 2, 1000);
  });

  // The change mark must be consumed by one probe; otherwise every later refresh of the workspace
  // bypasses the TTLs and brings back the gh-probe churn this store avoids.
  it("bypasses the cache TTLs only once per checkout change", async () => {
    using workspace = await openWorkspace({ ageCaches: false });
    workspace.emit("pr-open", { name: "pr-open-renamed" });
    await waitUntil(() => workspace.executeBash.mock.calls.length === 2, 1000);

    workspace.unsubscribe();
    workspace.resubscribe();
    await sleep(100);

    expect(workspace.executeBash.mock.calls.length).toBe(2);
  });

  // A transient failure of the one metadata-driven probe must not leave the previous checkout's
  // PR on screen: no unrelated event retries it, so the store retries on its own (bounded).
  it("retries a failed checkout-change probe until the old checkout's PR is gone", async () => {
    const oldPullRequestUrl = "https://github.com/coder/xum/pull/1";
    using workspace = await openWorkspace({
      ageCaches: false,
      respond: (script) =>
        script.includes("gh stack view")
          ? probeOutput('{"no_stack":true}')
          : probeOutput(JSON.stringify({ url: oldPullRequestUrl, state: "OPEN" })),
    });
    await waitUntil(() => workspace.store.getWorkspacePR("pr-open")?.prLink?.url != null);
    expect(workspace.store.getWorkspacePR("pr-open")?.prLink?.url).toBe(oldPullRequestUrl);

    workspace.setResponse(() => ({ success: false, error: "transient" }));
    workspace.emit("pr-open", { name: "pr-open-renamed" });
    await waitUntil(() => workspace.store.getWorkspacePR("pr-open")?.error != null, 1000);
    expect(workspace.store.getWorkspacePR("pr-open")?.prLink?.url).toBe(oldPullRequestUrl);

    // The new checkout has no PR. No focus, subscription or metadata event follows.
    workspace.setResponse(noPullRequest);
    await waitUntil(() => workspace.store.getWorkspacePR("pr-open")?.prLink === null, 8000);
  }, 15_000);

  it("stops retrying a failing checkout-change probe after three attempts", async () => {
    using workspace = await openWorkspace({ ageCaches: false });
    workspace.setResponse(() => ({ success: false, error: "gh down" }));

    workspace.emit("pr-open", { name: "pr-open-renamed" });

    // Three attempts of two probes each, one 5 s refresh debounce apart, then nothing.
    await waitUntil(() => workspace.executeBash.mock.calls.length === 6, 12_000);
    await sleep(6000);
    expect(workspace.executeBash.mock.calls.length).toBe(6);
  }, 25_000);

  it("probes again when the open workspace moves during a probe", async () => {
    using workspace = await openWorkspace({ ageCaches: false });
    const release = workspace.holdProbes();
    workspace.emit("pr-open", { name: "pr-open-renamed" });
    await waitUntil(() => workspace.executeBash.mock.calls.length === 2, 1000);

    // The in-flight probes ran against the old checkout; this change must still re-probe.
    workspace.emit("pr-open", { runtimeConfig: { type: "worktree", srcBaseDir: "/srv/xum/src" } });
    release();

    // The follow-up waits for the 5 s refresh debounce after the in-flight probes finish.
    await waitUntil(() => workspace.executeBash.mock.calls.length === 4, 8000);
  }, 15_000);
});

describe("parseMergeQueueEntry", () => {
  it("returns null for null and undefined", () => {
    expect(parseMergeQueueEntry(null)).toBeNull();
    expect(parseMergeQueueEntry(undefined)).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(parseMergeQueueEntry("queue")).toBeNull();
    expect(parseMergeQueueEntry(42)).toBeNull();
    expect(parseMergeQueueEntry(true)).toBeNull();
  });

  it("parses valid merge queue entry", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 0 })).toEqual({
      state: "QUEUED",
      position: 0,
    });
  });

  it("allows null position", () => {
    expect(parseMergeQueueEntry({ state: "AWAITING_CHECKS", position: null })).toEqual({
      state: "AWAITING_CHECKS",
      position: null,
    });
  });

  it("defaults state to QUEUED when absent", () => {
    expect(parseMergeQueueEntry({ position: 2 })).toEqual({
      state: "QUEUED",
      position: 2,
    });
  });

  it("normalizes invalid position values to null", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: -1 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 1.5 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: "0" })).toEqual({
      state: "QUEUED",
      position: null,
    });
  });
});
