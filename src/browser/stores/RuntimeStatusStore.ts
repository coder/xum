import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import { type FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isDevcontainerRuntime } from "@/common/types/runtime";
import { MapStore } from "./MapStore";
import { RefreshController } from "@/browser/utils/RefreshController";
import { getStatusInputChanges } from "@/browser/utils/statusRefreshInputs";

export type RuntimeStatus = "running" | "stopped" | "unknown" | "unsupported";

export class RuntimeStatusStore {
  private statuses = new MapStore<string, RuntimeStatus | null>();
  private statusCache = new Map<string, RuntimeStatus | null>();
  private client: APIClient | null = null;
  private immediateUpdateQueued = false;
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  private isActive = true;
  private readonly refreshController: RefreshController;

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

    // Every workspace metadata event (title, tag, AI settings, ...) delivers a new Map, and
    // requestImmediate bypasses the debounce and the hidden-window check (#5573). Refresh only when
    // a displayed devcontainer workspace appeared or its runtime inputs changed. Subscriptions,
    // focus and invalidation still refresh.
    const isSubscribed = (workspaceId: string) => this.statuses.hasKeySubscribers(workspaceId);
    const needsRefresh = getStatusInputChanges(this.workspaceMetadata, metadata, isSubscribed).some(
      (workspaceId) =>
        isSubscribed(workspaceId) && isDevcontainerRuntime(metadata.get(workspaceId)?.runtimeConfig)
    );
    this.workspaceMetadata = metadata;

    for (const workspaceId of Array.from(this.statusCache.keys())) {
      const workspace = metadata.get(workspaceId);
      if (!workspace || !isDevcontainerRuntime(workspace.runtimeConfig)) {
        this.statusCache.delete(workspaceId);
        this.statuses.delete(workspaceId);
      }
    }

    this.refreshController.bindListeners();
    if (reactivated || needsRefresh) {
      this.refreshController.requestImmediate();
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    this.statusCache.delete(workspaceId);
    this.statuses.delete(workspaceId);
    this.refreshController.requestImmediate();
  }

  dispose(): void {
    this.isActive = false;
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
          isDevcontainerRuntime(workspace.runtimeConfig) &&
          this.statuses.hasKeySubscribers(workspace.id)
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

function getRuntimeStatusStoreInstance(): RuntimeStatusStore {
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
