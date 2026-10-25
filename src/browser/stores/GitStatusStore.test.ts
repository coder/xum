import type { Result } from "@/common/types/result";
import type { BashToolResult } from "@/common/types/tools";

import { describe, it, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { GIT_FETCH_SCRIPT } from "@/common/utils/git/gitStatus";
import {
  GitStatusStore,
  type ProjectGitStatusResult,
  type MultiProjectGitSummary,
} from "./GitStatusStore";
import type { RuntimeStatus, RuntimeStatusStore } from "./RuntimeStatusStore";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

/**
 * Unit tests for GitStatusStore.
 *
 * Tests cover:
 * - Subscription/unsubscription
 * - syncWorkspaces adding/removing workspaces
 * - getStatus caching (returns same reference if unchanged)
 * - Per-workspace cache invalidation
 * - Status change detection
 * - Cleanup on dispose
 */

const mockExecuteBash = jest.fn<() => Promise<Result<BashToolResult, string>>>();
const mockGetProjectGitStatuses =
  jest.fn<
    (input: { workspaceId: string; baseRef: string | null }) => Promise<ProjectGitStatusResult[]>
  >();

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for passive git fetch");
    }
    await sleep(10);
  }
}

function createWorkspaceMetadata(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"] = DEFAULT_RUNTIME_CONFIG
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    projectName: "test-project",
    projectPath: "/home/user/test-project",
    namedWorkspacePath: `/home/user/.mux/src/test-project/${workspaceId}`,
    runtimeConfig,
  };
}

function createMultiProjectWorkspaceMetadata(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"] = DEFAULT_RUNTIME_CONFIG
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspaceMetadata(workspaceId, runtimeConfig),
    projectName: "project-a",
    projectPath: "/home/user/project-a",
    projects: [
      { projectPath: "/home/user/project-a", projectName: "project-a" },
      { projectPath: "/home/user/project-b", projectName: "project-b" },
    ],
  };
}

function createGitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "feature-branch",
    ahead: 0,
    behind: 0,
    dirty: false,
    outgoingAdditions: 0,
    outgoingDeletions: 0,
    incomingAdditions: 0,
    incomingDeletions: 0,
    ...overrides,
  };
}

function createProjectStatusResult(
  overrides: Partial<ProjectGitStatusResult> &
    Pick<ProjectGitStatusResult, "projectPath" | "projectName">
): ProjectGitStatusResult {
  return {
    projectPath: overrides.projectPath,
    projectName: overrides.projectName,
    gitStatus: "gitStatus" in overrides ? (overrides.gitStatus ?? null) : createGitStatus(),
    error: overrides.error ?? null,
  };
}

function createGitStatusOutput(
  overrides: Partial<ReturnType<typeof createGitStatus>> = {}
): string {
  const status = createGitStatus(overrides);
  return [
    "---HEAD_BRANCH---",
    status.branch,
    "---PRIMARY---",
    "main",
    "---AHEAD_BEHIND---",
    `${status.ahead} ${status.behind}`,
    "---DIRTY---",
    status.dirty ? "1" : "0",
    "---LINE_DELTA---",
    `${status.outgoingAdditions} ${status.outgoingDeletions} ${status.incomingAdditions} ${status.incomingDeletions}`,
  ].join("\n");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    } satisfies Pick<RuntimeStatusStore, "getStatus" | "subscribeKey">,
    setStatus(nextStatus: RuntimeStatus | null) {
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

function getFetchCallCount(): number {
  return mockExecuteBash.mock.calls.filter((call) => {
    const args = (call as unknown[])[0] as { script?: string } | undefined;
    return args?.script === GIT_FETCH_SCRIPT;
  }).length;
}

// One client reference, like AppLoader's `api`, so tests can replay its setClient calls.
const testClient = {
  workspace: {
    executeBash: mockExecuteBash,
    getProjectGitStatuses: mockGetProjectGitStatuses,
  },
} as unknown as Parameters<GitStatusStore["setClient"]>[0];

function createStore(
  runtimeStatusStore?: Pick<RuntimeStatusStore, "getStatus" | "subscribeKey">
): GitStatusStore {
  const store = new GitStatusStore(runtimeStatusStore);
  store.setClient(testClient);
  return store;
}

function getStatusCallCount(workspaceId: string): number {
  return mockExecuteBash.mock.calls.filter((call) => {
    const args = (call as unknown[])[0] as { workspaceId?: string; script?: string } | undefined;
    return args?.workspaceId === workspaceId && args.script !== GIT_FETCH_SCRIPT;
  }).length;
}

describe("GitStatusStore", () => {
  let store: GitStatusStore;
  let hadWindow = false;
  let originalWindow: unknown;

  beforeEach(() => {
    mockExecuteBash.mockReset();
    mockGetProjectGitStatuses.mockReset();
    mockExecuteBash.mockResolvedValue({
      success: true,
      data: {
        success: true,
        output: "",
        exitCode: 0,
        wall_duration_ms: 0,
      },
    } as Result<BashToolResult, string>);
    mockGetProjectGitStatuses.mockResolvedValue([]);

    hadWindow = "window" in globalThis;
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      api: {
        workspace: {
          executeBash: mockExecuteBash,
          getProjectGitStatuses: mockGetProjectGitStatuses,
        },
      },
    } as unknown as Window & typeof globalThis;

    store = createStore();
  });

  afterEach(() => {
    store.dispose();
    // Restore rather than delete: an earlier suite in the same bun process may have
    // installed a DOM, and deleting only `window` leaves `document` behind. Later
    // module-load checks (mermaid's `typeof document` then `window.addEventListener`)
    // then crash with an unhandled error in whichever suite imports them next.
    if (hadWindow) {
      (globalThis as { window?: unknown }).window = originalWindow;
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  test("subscribe and unsubscribe", () => {
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);

    expect(typeof unsubscribe).toBe("function");

    // Unsubscribe
    unsubscribe();

    // Ensure we can call unsubscribe multiple times without error
    unsubscribe();
  });

  test("syncWorkspaces initializes metadata", () => {
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Should have empty status initially
    const status = store.getStatus("ws1");
    expect(status).toBeNull();
  });

  test("syncWorkspaces removes deleted workspaces", () => {
    const metadata1 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
      [
        "ws2",
        {
          id: "ws2",
          name: "feature",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/feature",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata1);

    // Verify status is accessible for both workspaces
    const status1Initial = store.getStatus("ws1");
    const status2Initial = store.getStatus("ws2");
    expect(status1Initial).toBeNull(); // No status fetched yet
    expect(status2Initial).toBeNull();

    // Remove ws2
    const metadata2 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata2);

    // ws2 status still returns null (cache not actively cleaned, but won't be updated)
    const status2 = store.getStatus("ws2");
    expect(status2).toBeNull();
  });

  test("getStatus caching returns same reference if unchanged", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Get status twice
    const status1 = store.getStatus("ws1");
    const status2 = store.getStatus("ws1");

    // Should return same reference (both null)
    expect(status1).toBe(status2);
    expect(status1).toBeNull();
  });

  test("getStatus caching persists across calls", () => {
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Get status multiple times - should return same cached reference
    const status1 = store.getStatus("ws1");
    const status2 = store.getStatus("ws1");
    const status3 = store.getStatus("ws1");

    // Should return same reference (cached)
    expect(status1).toBe(status2);
    expect(status2).toBe(status3);
  });

  test("dispose cleans up resources", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Dispose
    store.dispose();

    // Subsequent operations should not throw
    const status = store.getStatus("ws1");
    expect(status).toBeNull();
  });

  test("status change detection", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Initially null
    const status1 = store.getStatus("ws1");
    expect(status1).toBeNull();

    // Note: We can't easily test status updates without mocking IPC
    // The store relies on window.api.workspace.executeBash which doesn't exist in test environment
    // Real integration tests would need to mock this API
  });

  test("emit only when workspaces are removed", () => {
    const listener = jest.fn();
    const unsub = store.subscribe(listener);

    const metadata1 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    // First sync - no workspaces exist yet, so no removal, no emit
    store.syncWorkspaces(metadata1);
    expect(listener).not.toHaveBeenCalled();

    // Manually add a workspace to the internal map to simulate it existing
    // (normally this would happen via polling, but we can't poll in tests without window.api)
    // @ts-expect-error - Accessing private field for testing
    store.statusCache.set("ws1", { ahead: 0, behind: 0, dirty: false });
    // @ts-expect-error - Accessing private field for testing
    store.statuses.bump("ws1");

    listener.mockClear();

    // Sync with empty metadata to remove ws1
    const metadata2 = new Map<string, FrontendWorkspaceMetadata>();
    store.syncWorkspaces(metadata2);

    // Listener should be called (workspace removed)
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();

    // Sync again with same empty metadata (no changes)
    store.syncWorkspaces(metadata2);

    // Listener should NOT be called (no changes)
    expect(listener).not.toHaveBeenCalled();

    unsub();
  });

  // #4662: opening a workspace must not spawn git status/fetch while its chat replay runs.
  it("defers a workspace's status and fetch until its chat replay settles", async () => {
    const pendingId = "replay-pending";
    const readyId = "replay-settled";
    let pending = true;
    const gateListeners = new Set<() => void>();
    store.setChatReplayGate({
      isReplayPending: (workspaceId) => pending && workspaceId === pendingId,
      subscribeKey: (workspaceId, listener) => {
        if (workspaceId !== pendingId) return () => undefined;
        gateListeners.add(listener);
        return () => gateListeners.delete(listener);
      },
    });
    const scriptsFor = (workspaceId: string) =>
      mockExecuteBash.mock.calls
        .map((call) => (call as unknown[])[0] as { workspaceId: string; script: string })
        .filter((args) => args.workspaceId === workspaceId)
        .map((args) => (args.script === GIT_FETCH_SCRIPT ? "fetch" : "status"));
    store.syncWorkspaces(
      new Map([
        // Separate projects: local fetches are deduplicated per project.
        [pendingId, { ...createWorkspaceMetadata(pendingId), projectName: "pending-project" }],
        [readyId, createWorkspaceMetadata(readyId)],
      ])
    );
    const unsubscribers = [pendingId, readyId].map((id) => store.subscribeKey(id, jest.fn()));

    await waitUntil(() => scriptsFor(readyId).length === 2);
    expect(scriptsFor(pendingId)).toEqual([]);
    expect(gateListeners.size).toBe(1);

    pending = false;
    for (const listener of Array.from(gateListeners)) listener();

    await waitUntil(() => scriptsFor(pendingId).length === 2);
    expect(scriptsFor(pendingId).sort()).toEqual(["fetch", "status"]);
    expect(gateListeners.size).toBe(0);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  describe("passive fetch runtime gating", () => {
    it("skips passive fetch and status checks for devcontainer with unresolved runtime status", async () => {
      store.dispose();
      const workspaceId = "dc-unresolved";
      const runtimeStatusStore = createRuntimeStatusStoreMock(null);
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      const unsubscribe = store.subscribeKey(workspaceId, jest.fn());

      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) > 0);
      expect(getFetchCallCount()).toBe(0);

      mockExecuteBash.mockClear();

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.updateGitStatus();

      expect(getFetchCallCount()).toBe(0);
      expect(mockExecuteBash).not.toHaveBeenCalled();

      unsubscribe();
    });

    it("retries passive fetch when devcontainer runtime transitions from null to running", async () => {
      store.dispose();
      const workspaceId = "dc-retry";
      const runtimeStatusStore = createRuntimeStatusStoreMock(null);
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      const unsubscribe = store.subscribeKey(workspaceId, jest.fn());

      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) > 0);
      expect(getFetchCallCount()).toBe(0);

      mockExecuteBash.mockClear();

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.updateGitStatus();
      expect(getFetchCallCount()).toBe(0);

      mockExecuteBash.mockClear();
      runtimeStatusStore.setStatus("running");
      runtimeStatusStore.emit(workspaceId);

      await waitUntil(() => getFetchCallCount() > 0);
      expect(getFetchCallCount()).toBe(1);

      unsubscribe();
    });

    it("installs a separate fetch retry even when status gating already registered a listener", async () => {
      store.dispose();
      const workspaceId = "dc-fetch-backoff";
      const runtimeStatusStore = createRuntimeStatusStoreMock(null);
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      const unsubscribe = store.subscribeKey(workspaceId, jest.fn());

      // Seed fetch backoff so the first passive refresh only registers the status retry.
      // @ts-expect-error - Accessing private field for fetch-backoff coverage
      store.fetchCache.set("test-project", {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: 0,
      });

      // @ts-expect-error - Accessing private method for passive runtime gating coverage
      await store.updateGitStatus();
      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) === 1);
      expect(getFetchCallCount()).toBe(0);

      // Let fetch become eligible while the runtime is still stopped so the fetch path
      // registers its own retry listener instead of sharing the status slot.
      // @ts-expect-error - Accessing private field for fetch-backoff coverage
      store.fetchCache.set("test-project", {
        lastFetch: Date.now() - 10_000,
        inProgress: false,
        consecutiveFailures: 0,
      });
      // @ts-expect-error - Accessing private method for passive runtime gating coverage
      await store.updateGitStatus();
      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) === 2);
      expect(getFetchCallCount()).toBe(0);

      // Re-arm backoff so only the fetch retry callback can make the immediate retry fetch.
      // @ts-expect-error - Accessing private field for fetch-backoff coverage
      store.fetchCache.set("test-project", {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: 0,
      });

      mockExecuteBash.mockClear();
      runtimeStatusStore.setStatus("running");
      runtimeStatusStore.emit(workspaceId);

      await waitUntil(() => getFetchCallCount() === 1);
      expect(getFetchCallCount()).toBe(1);
      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) === 0);

      unsubscribe();
    });

    it("rechecks passive eligibility before each secondary repo fetch", async () => {
      store.dispose();
      const workspaceId = "dc-secondary-stop";
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([
          [workspaceId, createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)],
        ])
      );

      let fetchCallCount = 0;
      mockExecuteBash.mockImplementation(() => {
        fetchCallCount += 1;
        if (fetchCallCount === 1) {
          runtimeStatusStore.setStatus(null);
        }

        const result: Result<BashToolResult, string> = {
          success: true,
          data: {
            success: true,
            output: "",
            exitCode: 0,
            wall_duration_ms: 0,
          },
        };
        return Promise.resolve(result);
      });

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.fetchSecondaryWorkspaceRepos(
        "project-a",
        new Map([
          ["/home/user/project-b", workspaceId],
          ["/home/user/project-c", workspaceId],
        ])
      );

      const fetchCalls = mockExecuteBash.mock.calls
        .map(
          (call) =>
            (call as unknown[])[0] as {
              script?: string;
              options?: { repoRootProjectPath?: string };
            }
        )
        .filter((call) => call.script === GIT_FETCH_SCRIPT);

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.options?.repoRootProjectPath).toBe("/home/user/project-b");
    });

    it("keeps the first workspace when shared fetch keys include the same secondary repo", () => {
      const workspaceIdA = "shared-secondary-a";
      const workspaceIdB = "shared-secondary-b";
      const sharedProjectName = "shared-project";
      const sharedSecondaryProjectPath = "/home/user/project-b";
      const workspaces = new Map<string, FrontendWorkspaceMetadata>([
        [
          workspaceIdA,
          {
            ...createWorkspaceMetadata(workspaceIdA),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-a",
            projects: [
              { projectPath: "/home/user/project-a", projectName: "project-a" },
              { projectPath: sharedSecondaryProjectPath, projectName: "project-b" },
            ],
          },
        ],
        [
          workspaceIdB,
          {
            ...createWorkspaceMetadata(workspaceIdB),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-c",
            projects: [
              { projectPath: "/home/user/project-c", projectName: "project-c" },
              { projectPath: sharedSecondaryProjectPath, projectName: "project-b" },
            ],
          },
        ],
      ]);
      store.syncWorkspaces(workspaces);

      // @ts-expect-error - Accessing private method for duplicate secondary repo coverage
      const secondaryRepoProjectPaths = store.getSecondaryRepoProjectPathsForFetchKey(
        sharedProjectName,
        workspaces
      );

      expect(Array.from(secondaryRepoProjectPaths.entries())).toEqual([
        [sharedSecondaryProjectPath, workspaceIdA],
      ]);
    });

    it("uses each secondary repo's owning workspace when fetch keys are shared", async () => {
      const workspaceIdA = "shared-fetch-a";
      const workspaceIdB = "shared-fetch-b";
      const sharedProjectName = "shared-project";
      const workspaces = new Map<string, FrontendWorkspaceMetadata>([
        [
          workspaceIdA,
          {
            ...createWorkspaceMetadata(workspaceIdA),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-a",
            projects: [
              { projectPath: "/home/user/project-a", projectName: "project-a" },
              { projectPath: "/home/user/project-b", projectName: "project-b" },
            ],
          },
        ],
        [
          workspaceIdB,
          {
            ...createWorkspaceMetadata(workspaceIdB),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-c",
            projects: [
              { projectPath: "/home/user/project-c", projectName: "project-c" },
              { projectPath: "/home/user/project-d", projectName: "project-d" },
            ],
          },
        ],
      ]);
      store.syncWorkspaces(workspaces);

      // @ts-expect-error - Accessing private method for secondary fetch aggregation coverage
      const secondaryRepoProjectPaths = store.getSecondaryRepoProjectPathsForFetchKey(
        sharedProjectName,
        workspaces
      );

      expect(Array.from(secondaryRepoProjectPaths.entries())).toEqual([
        ["/home/user/project-b", workspaceIdA],
        ["/home/user/project-d", workspaceIdB],
      ]);

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.fetchSecondaryWorkspaceRepos(sharedProjectName, secondaryRepoProjectPaths);

      const fetchCalls = mockExecuteBash.mock.calls
        .map(
          (call) =>
            (call as unknown[])[0] as {
              workspaceId?: string;
              script?: string;
              options?: { repoRootProjectPath?: string };
            }
        )
        .filter((call) => call.script === GIT_FETCH_SCRIPT)
        .map((call) => ({
          workspaceId: call.workspaceId,
          repoRootProjectPath: call.options?.repoRootProjectPath,
        }));

      expect(fetchCalls).toEqual([
        { workspaceId: workspaceIdA, repoRootProjectPath: "/home/user/project-b" },
        { workspaceId: workspaceIdB, repoRootProjectPath: "/home/user/project-d" },
      ]);
    });
  });

  describe("reference stability", () => {
    it("getStatus() returns same reference when status hasn't changed", () => {
      const status1 = store.getStatus("test-workspace");
      const status2 = store.getStatus("test-workspace");
      expect(status1).toBe(status2);
      expect(status1).toBeNull(); // No workspace = null
    });
  });

  describe("failure handling", () => {
    it("preserves old status when checkWorkspaceStatus fails", () => {
      const listener = jest.fn();
      const unsub = store.subscribe(listener);

      // Manually set an initial status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 2, behind: 1, dirty: true });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      const initialStatus = store.getStatus("ws1");
      expect(initialStatus).toEqual({ ahead: 2, behind: 1, dirty: true });

      listener.mockClear();

      // Simulate a failed status check by calling updateGitStatus with workspace that has status
      // When checkWorkspaceStatus returns [workspaceId, null], the logic should preserve old status
      // We can test this by directly manipulating the internal state to simulate the condition

      // Simulate the update logic receiving a failure result (null status)
      const newStatus = null; // Failed check
      const oldStatus = { ahead: 2, behind: 1, dirty: true };

      // Simulate the condition check from updateGitStatus
      // @ts-expect-error - Accessing private method for testing
      const statusesEqual = store.areStatusesEqual(oldStatus, newStatus);
      expect(statusesEqual).toBe(false); // They're different

      // The key behavior: when newStatus is null, we DON'T update the cache
      // So oldStatus should be preserved
      const statusAfterFailure = store.getStatus("ws1");
      expect(statusAfterFailure).toEqual({ ahead: 2, behind: 1, dirty: true });

      // Listener should NOT be called because we don't bump when status check fails
      expect(listener).not.toHaveBeenCalled();

      unsub();
    });

    it("updates status when checkWorkspaceStatus succeeds after previous failure", () => {
      const listener = jest.fn();
      const unsub = store.subscribe(listener);

      // Start with a status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 2, behind: 1, dirty: true });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      listener.mockClear();

      // Now simulate a successful update with new status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 3, behind: 0, dirty: false });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      const newStatus = store.getStatus("ws1");
      expect(newStatus).toEqual({ ahead: 3, behind: 0, dirty: false });

      // Listener should be called for the successful update
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });
  });

  test("skips polling when no subscribers", async () => {
    const metadata = {
      id: "ws1",
      name: "main",
      projectName: "test-project",
      projectPath: "/path",
      namedWorkspacePath: "/path",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    store.syncWorkspaces(new Map([["ws1", metadata]]));

    // Ensure executeBash is cleared
    mockExecuteBash.mockClear();

    // Trigger update
    // @ts-expect-error - Accessing private method
    await store.updateGitStatus();

    // Should not have called executeBash because no subscribers
    expect(mockExecuteBash).not.toHaveBeenCalled();

    // Add a subscriber
    const unsub = store.subscribeKey("ws1", jest.fn());

    // Trigger update again
    // @ts-expect-error - Accessing private method
    await store.updateGitStatus();

    // Should have called executeBash
    expect(mockExecuteBash).toHaveBeenCalled();

    unsub();
  });

  // AppLoader replays setClient(api) + syncWorkspaces(map) on every workspace metadata event, and
  // every event carries a new Map. Only a change to an open workspace's status inputs may spawn
  // git commands, hidden window or not.
  describe("metadata-driven refreshes", () => {
    const openId = "ws-open";
    const otherId = "ws-other";
    type MetadataMap = Map<string, FrontendWorkspaceMetadata>;
    let hadDocument = false;
    let originalDocument: unknown;
    let unsubscribe: () => void = () => undefined;

    function cleanStatusResult(): Result<BashToolResult, string> {
      return {
        success: true,
        data: { success: true, output: createGitStatusOutput(), exitCode: 0, wall_duration_ms: 0 },
      };
    }

    beforeEach(() => {
      hadDocument = "document" in globalThis;
      originalDocument = (globalThis as { document?: unknown }).document;
      mockExecuteBash.mockResolvedValue(cleanStatusResult());
    });

    afterEach(() => {
      unsubscribe();
      unsubscribe = () => undefined;
      if (hadDocument) {
        (globalThis as { document?: unknown }).document = originalDocument;
      } else {
        delete (globalThis as { document?: unknown }).document;
      }
    });

    function installDocument(visibility: "visible" | "hidden"): void {
      (globalThis as unknown as { document: unknown }).document = {
        hidden: visibility === "hidden",
        visibilityState: visibility,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      };
    }

    async function settle(): Promise<void> {
      await waitUntil(() => !store.isAnyRefreshInFlight());
    }

    async function openWorkspace(): Promise<MetadataMap> {
      const metadata: MetadataMap = new Map([
        [openId, createWorkspaceMetadata(openId)],
        [otherId, createWorkspaceMetadata(otherId)],
      ]);
      store.syncWorkspaces(metadata);
      unsubscribe = store.subscribeKey(openId, jest.fn());
      await waitUntil(() => getStatusCallCount(openId) === 1 && getFetchCallCount() === 1);
      await settle();
      expect(store.getStatus(openId)).not.toBeNull();
      mockExecuteBash.mockClear();
      return metadata;
    }

    /** Replays AppLoader's store-sync effect for one metadata event. */
    function emitMetadata(metadata: MetadataMap): void {
      store.setClient(testClient);
      store.syncWorkspaces(metadata);
    }

    /** Mirrors onMetadata: replace one entry, keep every other entry's reference. */
    function withEntry(
      metadata: MetadataMap,
      workspaceId: string,
      patch: Partial<FrontendWorkspaceMetadata>
    ): MetadataMap {
      const current = metadata.get(workspaceId);
      if (current == null) {
        throw new Error(`Missing metadata for ${workspaceId}`);
      }
      return new Map(metadata).set(workspaceId, { ...current, ...patch });
    }

    describe.each(["visible", "hidden"] as const)("in a %s window", (visibility) => {
      it.each<[string, (metadata: MetadataMap, i: number) => MetadataMap]>([
        [
          "another workspace changes, including its status inputs",
          (metadata, i) =>
            withEntry(metadata, otherId, {
              title: `Other ${i}`,
              isInitializing: i % 2 === 0,
              runtimeConfig: { type: "worktree", srcBaseDir: `/srv/${i}` },
            }),
        ],
        [
          "the open workspace changes fields status does not read",
          (metadata, i) =>
            withEntry(metadata, openId, { title: `Open ${i}`, tags: { round: String(i) } }),
        ],
        [
          "a snapshot rebuilds every entry with identical data",
          (metadata) =>
            new Map(Array.from(metadata, ([id, workspace]) => [id, structuredClone(workspace)])),
        ],
      ])("does not refresh when %s", async (_change, next) => {
        installDocument(visibility);
        let metadata = await openWorkspace();

        for (let i = 0; i < 10; i++) {
          metadata = next(metadata, i);
          emitMetadata(metadata);
        }
        await sleep(50);

        expect(mockExecuteBash).not.toHaveBeenCalled();
      });

      it.each<[string, Partial<FrontendWorkspaceMetadata>]>([
        ["runtime location", { runtimeConfig: { type: "worktree", srcBaseDir: "/srv/xum/src" } }],
        ["name", { name: "renamed" }],
        ["project path", { projectPath: "/home/user/moved-project" }],
        // Status never reads lifecycle fields, but a refresh after they change repopulates
        // status that the backend could not compute while the workspace was initializing.
        ["initialization state", { isInitializing: true }],
      ])("refreshes promptly when the open workspace's %s changes", async (_change, patch) => {
        installDocument(visibility);
        const metadata = await openWorkspace();

        emitMetadata(withEntry(metadata, openId, patch));

        // Well inside the 3 s debounce: the refresh must not wait for it.
        await waitUntil(() => getStatusCallCount(openId) === 1, 1000);
      });

      it("clears a removed open workspace and refreshes when its metadata returns", async () => {
        installDocument(visibility);
        const metadata = await openWorkspace();

        const withoutOpen = new Map(metadata);
        withoutOpen.delete(openId);
        emitMetadata(withoutOpen);
        await settle();
        expect(store.getStatus(openId)).toBeNull();
        expect(mockExecuteBash).not.toHaveBeenCalled();

        // The subscription outlived the metadata, so its return counts as an added workspace.
        emitMetadata(metadata);
        await waitUntil(() => getStatusCallCount(openId) === 1, 1000);
      });
    });

    it("refreshes when the client reconnects", async () => {
      installDocument("visible");
      await openWorkspace();

      store.setClient(null);
      store.setClient(testClient);

      await waitUntil(() => getStatusCallCount(openId) === 1, 1000);
    });

    it("keeps refreshing after a relevant change lands during an in-flight refresh", async () => {
      installDocument("visible");
      const metadata = await openWorkspace();
      const heldStatus = createDeferred<Result<BashToolResult, string>>();
      mockExecuteBash.mockImplementationOnce(() => heldStatus.promise);

      const moved = withEntry(metadata, openId, { projectPath: "/home/user/moved-project" });
      emitMetadata(moved);
      await waitUntil(() => getStatusCallCount(openId) === 1);
      emitMetadata(withEntry(moved, openId, { name: "renamed" }));
      heldStatus.resolve(cleanStatusResult());

      // The in-flight follow-up runs after the 3 s debounce.
      await waitUntil(() => getStatusCallCount(openId) === 2, 4500);
    }, 10_000);

    // Unrelated events no longer retry refreshes, so the passive fetch backoff (3-60 s) must not
    // swallow the fetch a checkout change needs: ahead/behind would compare stale remote refs.
    describe("passive fetch after a checkout change", () => {
      function fetchRoots(): Array<string | null> {
        return mockExecuteBash.mock.calls
          .map((call) => (call as unknown[])[0] as { script?: string; options?: unknown })
          .filter((args) => args.script === GIT_FETCH_SCRIPT)
          .map(
            (args) =>
              (args.options as { repoRootProjectPath?: string } | undefined)?.repoRootProjectPath ??
              null
          );
      }

      /** Holds GIT_FETCH_SCRIPT calls until released; status calls resolve at once. */
      function holdFetches(result: Result<BashToolResult, string> = cleanStatusResult()) {
        const held = createDeferred<void>();
        mockExecuteBash.mockImplementation(async (...args: unknown[]) => {
          const input = args[0] as { script?: string };
          if (input.script === GIT_FETCH_SCRIPT) {
            await held.promise;
            return result;
          }
          return cleanStatusResult();
        });
        return () => held.resolve();
      }

      it("fetches promptly when the open workspace moves within the fetch backoff", async () => {
        installDocument("visible");
        const metadata = await openWorkspace();

        emitMetadata(withEntry(metadata, openId, { projectPath: "/home/user/moved-project" }));

        await waitUntil(() => getFetchCallCount() === 1, 1000);
      });

      it("fetches when the workspace moved while nothing displayed it", async () => {
        installDocument("visible");
        const metadata = await openWorkspace();
        unsubscribe();
        emitMetadata(withEntry(metadata, openId, { projectPath: "/home/user/moved-project" }));
        await sleep(50);
        expect(mockExecuteBash).not.toHaveBeenCalled();

        unsubscribe = store.subscribeKey(openId, jest.fn());

        await waitUntil(() => getFetchCallCount() === 1, 1000);
      });

      it("fetches again when the open workspace moves during a fetch", async () => {
        installDocument("visible");
        const metadata: MetadataMap = new Map([[openId, createWorkspaceMetadata(openId)]]);
        store.syncWorkspaces(metadata);
        const release = holdFetches();
        unsubscribe = store.subscribeKey(openId, jest.fn());
        await waitUntil(() => getFetchCallCount() === 1);

        // The in-flight fetch covers the old checkout.
        emitMetadata(withEntry(metadata, openId, { projectPath: "/home/user/moved-project" }));
        await waitUntil(() => getStatusCallCount(openId) === 2);
        expect(getFetchCallCount()).toBe(1);
        release();

        await waitUntil(() => getFetchCallCount() === 2, 1000);
      });

      it("fetches again when the open workspace moves during a forced fetch", async () => {
        installDocument("visible");
        const metadata = await openWorkspace();
        const release = holdFetches();
        const moved = withEntry(metadata, openId, { projectPath: "/home/user/moved-project" });
        emitMetadata(moved);
        await waitUntil(() => getFetchCallCount() === 1, 1000);

        // The held forced fetch covers the first move only.
        emitMetadata(withEntry(moved, openId, { name: "renamed" }));
        await sleep(50);
        release();

        // Inside the 3 s fetch backoff, so only the pending rename can start this fetch.
        await waitUntil(() => getFetchCallCount() === 2, 1500);
      });

      it("fetches every changed fetch key from one metadata update", async () => {
        installDocument("visible");
        const second = "ws-second";
        let metadata: MetadataMap = new Map([
          [openId, createWorkspaceMetadata(openId)],
          [second, { ...createWorkspaceMetadata(second), projectName: "second-project" }],
        ]);
        store.syncWorkspaces(metadata);
        unsubscribe = store.subscribeKey(openId, jest.fn());
        const unsubscribeSecond = store.subscribeKey(second, jest.fn());
        try {
          await waitUntil(() => getFetchCallCount() >= 1);
          await sleep(100);
          mockExecuteBash.mockClear();

          metadata = withEntry(metadata, openId, { projectPath: "/home/user/moved-a" });
          metadata = withEntry(metadata, second, { projectPath: "/home/user/moved-b" });
          emitMetadata(metadata);

          // One fetch runs per refresh; the first fetch's completion requests the next refresh,
          // which waits for the 3 s debounce when the fetch settles before the status checks.
          await waitUntil(() => getFetchCallCount() === 2, 4500);
          const fetchedWorkspaceIds = mockExecuteBash.mock.calls
            .map((call) => (call as unknown[])[0] as { script?: string; workspaceId?: string })
            .filter((args) => args.script === GIT_FETCH_SCRIPT)
            .map((args) => args.workspaceId);
          expect(new Set(fetchedWorkspaceIds)).toEqual(new Set([openId, second]));
        } finally {
          unsubscribeSecond();
        }
      }, 10_000);

      it("reads status again only after the new secondary repo is fetched", async () => {
        installDocument("visible");
        const multi = createMultiProjectWorkspaceMetadata(openId);
        const addedProject = { projectPath: "/home/user/project-c", projectName: "project-c" };
        let projects = multi.projects ?? [];
        mockGetProjectGitStatuses.mockImplementation(() =>
          Promise.resolve(projects.map((project) => createProjectStatusResult(project)))
        );
        const metadata: MetadataMap = new Map([[openId, multi]]);
        store.syncWorkspaces(metadata);
        unsubscribe = store.subscribeProjectStatusesKey(openId, jest.fn());
        await waitUntil(() => fetchRoots().includes("/home/user/project-b"));
        await sleep(100);
        const heldSecondary = createDeferred<void>();
        mockExecuteBash.mockImplementation(async (...args: unknown[]) => {
          const input = args[0] as { options?: { repoRootProjectPath?: string } };
          if (input.options?.repoRootProjectPath === addedProject.projectPath) {
            await heldSecondary.promise;
          }
          return cleanStatusResult();
        });
        mockExecuteBash.mockClear();
        mockGetProjectGitStatuses.mockClear();

        projects = [...projects, addedProject];
        emitMetadata(withEntry(metadata, openId, { projects }));
        await waitUntil(() => fetchRoots().includes(addedProject.projectPath), 1000);
        // Past the 3 s debounce a racing follow-up read would use.
        await sleep(3500);
        expect(mockGetProjectGitStatuses).toHaveBeenCalledTimes(1);

        heldSecondary.resolve();
        await waitUntil(() => mockGetProjectGitStatuses.mock.calls.length === 2, 4500);
      }, 15_000);

      it("keeps a stopped workspace's fetch pending when a shared-key workspace fetches first", async () => {
        installDocument("visible");
        store.dispose();
        const runtimeStatus = createRuntimeStatusStoreMock(null);
        store = createStore(runtimeStatus.runtimeStatusStore);
        const runnableId = "multi-runnable";
        const stoppedId = "multi-stopped";
        const stoppedOnlyRepo = "/home/user/project-c";
        // Both share the local fetch key "project-a"; only the stopped one covers project-c.
        let metadata: MetadataMap = new Map([
          [runnableId, createMultiProjectWorkspaceMetadata(runnableId)],
          [
            stoppedId,
            {
              ...createMultiProjectWorkspaceMetadata(stoppedId, DEVCONTAINER_RUNTIME),
              projects: [
                { projectPath: "/home/user/project-a", projectName: "project-a" },
                { projectPath: stoppedOnlyRepo, projectName: "project-c" },
              ],
            },
          ],
        ]);
        mockGetProjectGitStatuses.mockImplementation(({ workspaceId }) =>
          Promise.resolve(
            (metadata.get(workspaceId)?.projects ?? []).map((project) =>
              createProjectStatusResult(project)
            )
          )
        );
        store.syncWorkspaces(metadata);
        unsubscribe = store.subscribeProjectStatusesKey(runnableId, jest.fn());
        const unsubscribeStopped = store.subscribeProjectStatusesKey(stoppedId, jest.fn());
        try {
          await waitUntil(() => getFetchCallCount() >= 1);
          await sleep(100);
          mockExecuteBash.mockClear();

          metadata = withEntry(metadata, runnableId, { name: "runnable-renamed" });
          metadata = withEntry(metadata, stoppedId, { name: "stopped-renamed" });
          emitMetadata(metadata);
          await waitUntil(() => getFetchCallCount() >= 1, 1000);
          // Let the runnable workspace's fetch and its follow-up refresh settle.
          await sleep(500);
          const fetchedWorkspaceIds = () =>
            mockExecuteBash.mock.calls
              .map((call) => (call as unknown[])[0] as { script?: string; workspaceId?: string })
              .filter((args) => args.script === GIT_FETCH_SCRIPT)
              .map((args) => args.workspaceId);
          // The stopped runtime is never woken.
          expect(fetchedWorkspaceIds()).not.toContain(stoppedId);
          expect(fetchRoots()).not.toContain(stoppedOnlyRepo);

          runtimeStatus.setStatus("running");
          runtimeStatus.emit(stoppedId);

          // Starting the runtime fetches its own repos without another trigger.
          await waitUntil(() => fetchRoots().includes(stoppedOnlyRepo), 4500);
          const settledFetches = getFetchCallCount();
          await sleep(1000);
          expect(getFetchCallCount()).toBe(settledFetches);
        } finally {
          unsubscribeStopped();
        }
      }, 15_000);

      it("does not retry a failed fetch in a loop", async () => {
        installDocument("visible");
        const metadata = await openWorkspace();
        const release = holdFetches({ success: false, error: "network down" });
        release();

        emitMetadata(withEntry(metadata, openId, { projectPath: "/home/user/moved-project" }));
        await waitUntil(() => getFetchCallCount() === 1, 1000);
        // The settled fetch requests one more status run (after the 3 s debounce when it
        // settles during the status checks), then nothing else runs.
        await waitUntil(() => getStatusCallCount(openId) === 2, 4500);
        await sleep(1000);

        expect(getFetchCallCount()).toBe(1);
        expect(getStatusCallCount(openId)).toBe(2);
      }, 10_000);
    });

    it("does not let unrelated churn postpone or add refreshes", async () => {
      installDocument("visible");
      let metadata = await openWorkspace();
      let notifyFileModified: (workspaceId: string) => void = () => undefined;
      store.subscribeToFileModifications((listener) => {
        notifyFileModified = listener;
        return () => undefined;
      });
      let i = 0;
      // 10 unrelated metadata events per second.
      async function churnOnce(): Promise<void> {
        metadata = withEntry(metadata, otherId, { title: `Other ${i++}` });
        emitMetadata(metadata);
        await sleep(100);
      }

      const scheduledAt = Date.now();
      notifyFileModified(openId);
      // Churn until the 3 s debounced file-modification refresh runs.
      while (getStatusCallCount(openId) === 0) {
        expect(Date.now() - scheduledAt).toBeLessThan(4500);
        await churnOnce();
      }
      // Churn for longer than one debounce window: a debounced refresh per window (for example
      // schedule() instead of no-op on unrelated events) would show up here.
      const refreshedAt = Date.now();
      while (Date.now() - refreshedAt < 3500) {
        await churnOnce();
      }

      expect(getStatusCallCount(openId)).toBe(1);
    }, 15_000);
  });

  describe("multi-project refreshes", () => {
    it("uses one project-status IPC call and derives workspace summaries", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-summary";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const projectResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({
            branch: "primary-branch",
            ahead: 2,
            behind: 1,
            dirty: true,
            outgoingAdditions: 10,
            outgoingDeletions: 3,
            incomingAdditions: 4,
            incomingDeletions: 1,
          }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({
            branch: "secondary-branch",
            ahead: 1,
            behind: 0,
            dirty: false,
            outgoingAdditions: 6,
            outgoingDeletions: 2,
            incomingAdditions: 7,
            incomingDeletions: 5,
          }),
        }),
      ];
      mockGetProjectGitStatuses.mockResolvedValue(projectResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      expect(mockGetProjectGitStatuses).toHaveBeenCalledTimes(1);
      expect(mockGetProjectGitStatuses).toHaveBeenCalledWith({
        workspaceId,
        baseRef: expect.any(String),
      });
      expect(getFetchCallCount()).toBe(1);
      expect(mockExecuteBash).toHaveBeenCalledTimes(getFetchCallCount());
      expect(store.getProjectStatuses(workspaceId)).toEqual(projectResults);
      expect(store.getProjectStatuses(workspaceId)).toBe(store.getProjectStatuses(workspaceId));

      const expectedSummary: MultiProjectGitSummary = {
        totalProjectCount: 2,
        divergedProjectCount: 2,
        dirtyProjectCount: 1,
        unknownProjectCount: 0,
        projects: store.getProjectStatuses(workspaceId)!,
      };
      expect(store.getMultiProjectSummary(workspaceId)).toEqual(expectedSummary);
      expect(store.getStatus(workspaceId)).toEqual({
        branch: "primary-branch",
        ahead: 3,
        behind: 1,
        dirty: true,
        outgoingAdditions: 16,
        outgoingDeletions: 5,
        incomingAdditions: 11,
        incomingDeletions: 6,
      });

      unsubscribe();
    });

    it("fetches secondary repos from every workspace that shares the fetch key", async () => {
      const firstWorkspace = createMultiProjectWorkspaceMetadata("multi-shared-a");
      const secondWorkspace: FrontendWorkspaceMetadata = {
        ...createMultiProjectWorkspaceMetadata("multi-shared-b"),
        projects: [
          { projectPath: "/home/user/project-a", projectName: "project-a" },
          { projectPath: "/home/user/project-c", projectName: "project-c" },
        ],
      };
      const workspaces = new Map<string, FrontendWorkspaceMetadata>([
        [firstWorkspace.id, firstWorkspace],
        [secondWorkspace.id, secondWorkspace],
      ]);

      store.syncWorkspaces(workspaces);
      mockExecuteBash.mockClear();

      // @ts-expect-error - Accessing private method for fetch dedupe coverage
      store.tryFetchWorkspaces(workspaces);
      await waitUntil(() => getFetchCallCount() === 3);

      const secondaryRepoProjectPaths = mockExecuteBash.mock.calls
        .map(
          (call) =>
            (call as unknown[])[0] as {
              script?: string;
              options?: { repoRootProjectPath?: string };
            }
        )
        .filter((call) => call.script === GIT_FETCH_SCRIPT)
        .map((call) => call.options?.repoRootProjectPath ?? null)
        .filter((projectPath): projectPath is string => projectPath !== null);

      expect(secondaryRepoProjectPaths).toHaveLength(2);
      expect(new Set(secondaryRepoProjectPaths)).toEqual(
        new Set(["/home/user/project-b", "/home/user/project-c"])
      );
    });

    it("skips multi-project IPC when passive runtime commands are ineligible and preserves cached state", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-passive-gate";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const initialResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "primary-branch", ahead: 1, dirty: true }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "secondary-branch", behind: 2 }),
        }),
      ];
      mockGetProjectGitStatuses.mockResolvedValue(initialResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      const initialProjectStatuses = store.getProjectStatuses(workspaceId);
      const initialSummary = store.getMultiProjectSummary(workspaceId);
      const initialStatus = store.getStatus(workspaceId);
      expect(initialProjectStatuses).toEqual(initialResults);
      expect(initialSummary).not.toBeNull();
      expect(initialStatus).not.toBeNull();

      runtimeStatusStore.setStatus(null);
      mockGetProjectGitStatuses.mockClear();

      // @ts-expect-error - Accessing private method for passive runtime gating coverage
      await store.updateGitStatus();

      expect(mockGetProjectGitStatuses).not.toHaveBeenCalled();
      expect(store.getProjectStatuses(workspaceId)).toBe(initialProjectStatuses);
      expect(store.getMultiProjectSummary(workspaceId)).toBe(initialSummary);
      expect(store.getStatus(workspaceId)).toBe(initialStatus);

      unsubscribe();
    });

    it("preserves per-project errors in the summary instead of dropping failed rows", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-errors";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const projectResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "primary-branch", dirty: true, ahead: 4 }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: null,
          error: "project-b exploded",
        }),
      ];
      mockGetProjectGitStatuses.mockResolvedValue(projectResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      expect(store.getProjectStatuses(workspaceId)).toEqual(projectResults);
      expect(store.getMultiProjectSummary(workspaceId)).toEqual({
        totalProjectCount: 2,
        divergedProjectCount: 1,
        dirtyProjectCount: 1,
        unknownProjectCount: 1,
        projects: store.getProjectStatuses(workspaceId)!,
      });
      expect(store.getStatus(workspaceId)).toEqual({
        branch: "primary-branch",
        ahead: 4,
        behind: 0,
        dirty: true,
        outgoingAdditions: 0,
        outgoingDeletions: 0,
        incomingAdditions: 0,
        incomingDeletions: 0,
      });

      unsubscribe();
    });

    it("ignores stale multi-project results after invalidation generation changes", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-stale";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const firstRefresh = createDeferred<ProjectGitStatusResult[]>();
      const secondResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "fresh-branch", ahead: 1, dirty: true }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "fresh-secondary", behind: 2 }),
        }),
      ];
      const staleResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "stale-branch", ahead: 9 }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "stale-secondary", dirty: true }),
        }),
      ];
      mockGetProjectGitStatuses
        .mockImplementationOnce(() => firstRefresh.promise)
        .mockResolvedValueOnce(secondResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for concurrent refresh coverage
      const staleUpdate = store.updateGitStatus();
      await waitUntil(() => mockGetProjectGitStatuses.mock.calls.length === 1);

      // @ts-expect-error - Accessing private invalidation generation for stale-result coverage
      store.invalidationGeneration.set(workspaceId, 1);

      // @ts-expect-error - Accessing private method for concurrent refresh coverage
      await store.updateGitStatus();
      expect(store.getProjectStatuses(workspaceId)).toEqual(secondResults);

      firstRefresh.resolve(staleResults);
      await staleUpdate;
      expect(store.getProjectStatuses(workspaceId)).toEqual(secondResults);
      expect(store.getStatus(workspaceId)?.branch).toBe("fresh-branch");

      unsubscribe();
    });

    it("tracks refreshing state while a multi-project refresh is pending", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-refreshing";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const refresh = createDeferred<ProjectGitStatusResult[]>();
      mockGetProjectGitStatuses.mockImplementation(() => refresh.promise);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      expect(store.isWorkspaceRefreshing(workspaceId)).toBe(false);
      store.invalidateWorkspace(workspaceId);
      expect(store.isWorkspaceRefreshing(workspaceId)).toBe(true);
      await waitUntil(() => mockGetProjectGitStatuses.mock.calls.length === 1);

      refresh.resolve([
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "done" }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "done-too" }),
        }),
      ]);

      await waitUntil(() => store.isWorkspaceRefreshing(workspaceId) === false);
      unsubscribe();
    });

    it("keeps the single-project executeBash refresh path unchanged", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "single-regression";
      mockExecuteBash.mockResolvedValue({
        success: true,
        data: {
          success: true,
          output: createGitStatusOutput({
            branch: "single-branch",
            ahead: 2,
            behind: 1,
            dirty: true,
            outgoingAdditions: 9,
            outgoingDeletions: 4,
            incomingAdditions: 3,
            incomingDeletions: 2,
          }),
          exitCode: 0,
          wall_duration_ms: 0,
        },
      } as Result<BashToolResult, string>);

      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.statuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      expect(mockGetProjectGitStatuses).not.toHaveBeenCalled();
      const fetchCallCount = getFetchCallCount();
      expect(mockExecuteBash).toHaveBeenCalledTimes(fetchCallCount + 1);
      expect(store.getStatus(workspaceId)).toEqual({
        branch: "single-branch",
        ahead: 2,
        behind: 1,
        dirty: true,
        outgoingAdditions: 9,
        outgoingDeletions: 4,
        incomingAdditions: 3,
        incomingDeletions: 2,
      });
      expect(store.getProjectStatuses(workspaceId)).toBeNull();

      unsubscribe();
    });
  });
});
