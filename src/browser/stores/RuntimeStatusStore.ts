import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import { type FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isDevcontainerRuntime, isSSHRuntime, type RuntimeConfig } from "@/common/types/runtime";
import type { WorkspaceRuntimeStatus } from "@/common/orpc/schemas/runtime";
import type { RuntimeStatusEvent } from "@/common/types/stream";
import { MapStore } from "./MapStore";
import { RefreshController } from "@/browser/utils/RefreshController";
import { getStatusInputChanges } from "@/browser/utils/statusRefreshInputs";

export type RuntimeStatus = WorkspaceRuntimeStatus;

/** Runtimes with a start/stop lifecycle the UI shows: devcontainers and Daytona sandboxes. */
export function hasRuntimeStatus(runtimeConfig: RuntimeConfig | undefined): boolean {
  return (
    isDevcontainerRuntime(runtimeConfig) ||
    (isSSHRuntime(runtimeConfig) && runtimeConfig.daytona != null)
  );
}

/**
 * Whether a metadata update can change the status of a displayed devcontainer or Daytona workspace.
 * Every workspace metadata event (title, tag, AI settings, ...) delivers a new Map, and the store's
 * requestImmediate bypasses the debounce and the hidden-window check (#5573). So refresh only when
 * such a workspace appeared, its runtime inputs changed, or its task status changed: launching or
 * resuming a task starts a stopped container, and no other event tells this store.
 */
function hasDisplayedRuntimeChange(
  previous: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  next: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  isSubscribed: (workspaceId: string) => boolean
): boolean {
  const changedWorkspaceIds = getStatusInputChanges(previous, next, isSubscribed);
  for (const [workspaceId, workspace] of next) {
    const before = previous.get(workspaceId);
    if (before != null && before.taskStatus !== workspace.taskStatus) {
      changedWorkspaceIds.push(workspaceId);
    }
  }
  return changedWorkspaceIds.some(
    (workspaceId) =>
      isSubscribed(workspaceId) && hasRuntimeStatus(next.get(workspaceId)?.runtimeConfig)
  );
}

export class RuntimeStatusStore {
  private statuses = new MapStore<string, RuntimeStatus | null>();
  private statusCache = new Map<string, RuntimeStatus | null>();
  private client: APIClient | null = null;
  private immediateUpdateQueued = false;
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  private isActive = true;
  private readonly refreshController: RefreshController;
  /** Workspaces whose runtime a turn is starting: their status changes again once it is up. */
  private readonly startingWorkspaces = new Set<string>();
  private runtimeEventsUnsubscribe: (() => void) | null = null;

  constructor() {
    this.refreshController = new RefreshController({
      onRefresh: () => this.updateRuntimeStatuses(),
      onRefreshError: (failure) => {
        console.error("[RuntimeStatusStore] refresh failed:", failure.errorMessage);
      },
      refreshOnFocus: true,
      focusDebounceMs: 500,
    });
  }

  setClient(client: APIClient | null): void {
    // AppLoader re-applies the same client on every workspace metadata event (#5573); only a new
    // client (first connect or reconnect) warrants a refresh.
    if (client === this.client) {
      return;
    }
    this.client = client;

    if (!client) {
      return;
    }

    if (this.workspaceMetadata.size > 0) {
      this.refreshController.requestImmediate();
    }
  }

  subscribe = this.statuses.subscribeAny;

  subscribeKey = (workspaceId: string, listener: () => void) => {
    const unsubscribe = this.statuses.subscribeKey(workspaceId, listener);

    if (!this.immediateUpdateQueued && this.isActive && this.client) {
      this.immediateUpdateQueued = true;
      queueMicrotask(() => {
        this.immediateUpdateQueued = false;
        this.refreshController.requestImmediate();
      });
    }

    return unsubscribe;
  };

  getStatus(workspaceId: string): RuntimeStatus | null {
    if (!this.statuses.has(workspaceId)) {
      return null;
    }

    return this.statuses.get(workspaceId, () => {
      return this.statusCache.get(workspaceId) ?? null;
    });
  }

  syncWorkspaces(metadata: Map<string, FrontendWorkspaceMetadata>): void {
    const reactivated = !this.isActive && metadata.size > 0;
    if (reactivated) {
      this.isActive = true;
    }

    const needsRefresh = hasDisplayedRuntimeChange(
      this.workspaceMetadata,
      metadata,
      (workspaceId) => this.statuses.hasKeySubscribers(workspaceId)
    );
    this.workspaceMetadata = metadata;

    for (const workspaceId of Array.from(this.statusCache.keys())) {
      const workspace = metadata.get(workspaceId);
      if (!workspace || !hasRuntimeStatus(workspace.runtimeConfig)) {
        this.statusCache.delete(workspaceId);
        this.statuses.delete(workspaceId);
      }
    }

    this.refreshController.bindListeners();
    if (reactivated || needsRefresh) {
      this.refreshController.requestImmediate();
    }
  }

  /**
   * A turn's ensureReady starting a stopped devcontainer or Daytona sandbox changes its status,
   * and only the workspace chat stream tells. Idempotent: only the first call subscribes.
   */
  subscribeToRuntimeStatusEvents(
    subscribe: (listener: (event: RuntimeStatusEvent) => void) => () => void
  ): void {
    if (this.runtimeEventsUnsubscribe) {
      return;
    }
    this.runtimeEventsUnsubscribe = subscribe((event) => this.handleRuntimeStatusEvent(event));
  }

  private handleRuntimeStatusEvent(event: RuntimeStatusEvent): void {
    if (event.source !== "runtime" || !this.tracksRuntimeStart(event)) {
      return;
    }
    this.refreshIfDisplayed(event.workspaceId);
  }

  /**
   * Opening a terminal brings a stopped Daytona sandbox up first (the backend runs ensureReady),
   * outside any turn and so without runtime-status events: refetch a displayed one.
   */
  refreshAfterTerminalOpen(workspaceId: string): void {
    this.refreshIfDisplayed(workspaceId);
  }

  private refreshIfDisplayed(workspaceId: string): void {
    if (
      hasRuntimeStatus(this.workspaceMetadata.get(workspaceId)?.runtimeConfig) &&
      this.statuses.hasKeySubscribers(workspaceId)
    ) {
      this.refreshController.requestImmediate();
    }
  }

  /** Whether the event begins a start ("starting") or ends one; every turn reports "ready". */
  private tracksRuntimeStart(event: RuntimeStatusEvent): boolean {
    if (event.phase === "starting") {
      this.startingWorkspaces.add(event.workspaceId);
      return true;
    }
    if (event.phase !== "ready" && event.phase !== "error") {
      return false;
    }
    return this.startingWorkspaces.delete(event.workspaceId);
  }

  invalidateWorkspace(workspaceId: string): void {
    this.statusCache.delete(workspaceId);
    this.statuses.delete(workspaceId);
    this.refreshController.requestImmediate();
  }

  dispose(): void {
    this.isActive = false;
    this.runtimeEventsUnsubscribe?.();
    this.runtimeEventsUnsubscribe = null;
    this.startingWorkspaces.clear();
    this.statusCache.clear();
    this.statuses.clear();
    this.refreshController.dispose();
  }

  private async updateRuntimeStatuses(): Promise<void> {
    if (this.workspaceMetadata.size === 0 || !this.client || !this.isActive) {
      return;
    }

    const workspaceIds = Array.from(this.workspaceMetadata.values())
      .filter((workspace) => {
        return (
          hasRuntimeStatus(workspace.runtimeConfig) && this.statuses.hasKeySubscribers(workspace.id)
        );
      })
      .map((workspace) => workspace.id);

    if (workspaceIds.length === 0) {
      return;
    }

    const nextStatuses = await this.client.workspace.getRuntimeStatuses({ workspaceIds });

    if (!this.isActive) {
      return;
    }

    for (const workspaceId of workspaceIds) {
      const nextStatus = nextStatuses[workspaceId] ?? "unknown";
      if (this.statusCache.get(workspaceId) === nextStatus && this.statuses.has(workspaceId)) {
        continue;
      }

      this.statusCache.set(workspaceId, nextStatus);
      this.statuses.bump(workspaceId);
    }
  }
}

let runtimeStatusStoreInstance: RuntimeStatusStore | null = null;

/** The shared store, for non-React callers (useRuntimeStatusStoreRaw in components). */
export function getRuntimeStatusStoreInstance(): RuntimeStatusStore {
  runtimeStatusStoreInstance ??= new RuntimeStatusStore();
  return runtimeStatusStoreInstance;
}

export function useRuntimeStatus(workspaceId: string | undefined): RuntimeStatus | null {
  const store = getRuntimeStatusStoreInstance();

  return useSyncExternalStore(
    (listener) => (workspaceId ? store.subscribeKey(workspaceId, listener) : () => undefined),
    () => (workspaceId ? store.getStatus(workspaceId) : null)
  );
}

export function useRuntimeStatusStoreRaw(): RuntimeStatusStore {
  return getRuntimeStatusStoreInstance();
}
