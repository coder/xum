import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import { subscribeAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { RefreshController } from "@/browser/utils/RefreshController";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { AgentSkillListResult } from "@/common/types/agentSkill";
import { MapStore } from "./MapStore";

/** The input of `agentSkills.list`: a workspace, or a project before its workspace exists. */
export type AgentSkillsDiscovery =
  | { workspaceId: string; disableWorkspaceAgents: boolean }
  | { projectPath: string };

const EMPTY_RESULT: AgentSkillListResult = {
  skills: [],
  invalidSkills: [],
  unavailableSources: [],
};

interface Entry {
  result: AgentSkillListResult;
  /** The list missed a source or the call failed, so `ensureFresh` asks again. */
  stale: boolean;
}

function getDiscoveryKey(discovery: AgentSkillsDiscovery): string {
  return "projectPath" in discovery
    ? `project:${discovery.projectPath}`
    : `ws:${discovery.workspaceId}:${String(discovery.disableWorkspaceAgents)}`;
}

/**
 * One skill list per discovery input, shared by the composer, the hat icon, and
 * the command palette, so they show the same list and refresh on the same
 * signals. No event says when an SSH host becomes reachable, so a list that
 * missed a source refreshes on window focus, skill tool calls, plugin changes,
 * or when the user starts a `$` or `/` token.
 */
export class AgentSkillsStore {
  private readonly versions = new MapStore<string, AgentSkillListResult>();
  private readonly entries = new Map<string, Entry>();
  /** Keys with a subscriber. A key fetches each time it becomes active. */
  private readonly activeDiscoveries = new Map<string, AgentSkillsDiscovery>();
  /** The latest request id of each key with a request in flight. */
  private readonly requests = new Map<string, number>();
  private nextRequestId = 0;
  private client: APIClient | null = null;
  private unbindSignals: (() => void) | null = null;
  private readonly refreshController = new RefreshController({
    onRefresh: () => this.refreshActive(),
    onRefreshError: (failure) => {
      console.error("[AgentSkillsStore] refresh failed:", failure.errorMessage);
    },
    refreshOnFocus: true,
    focusDebounceMs: 500,
  });

  setClient(client: APIClient | null): void {
    if (client === this.client) return;
    this.client = client;

    // Lists from another backend are wrong for this one.
    this.requests.clear();
    const cachedKeys = Array.from(this.entries.keys());
    this.entries.clear();
    for (const key of cachedKeys) this.versions.bump(key);

    if (!client) return;
    this.bindSignals();
    this.refreshActive();
  }

  subscribe(discovery: AgentSkillsDiscovery, listener: () => void): () => void {
    const key = getDiscoveryKey(discovery);
    const unsubscribe = this.versions.subscribeKey(key, listener);
    if (!this.activeDiscoveries.has(key)) {
      this.activeDiscoveries.set(key, discovery);
      this.fetch(key, discovery);
    }

    return () => {
      unsubscribe();
      if (this.versions.hasKeySubscribers(key)) return;
      // React unsubscribes and subscribes again when the subscribe callback
      // changes. Keep the key active through that so a render does not refetch.
      queueMicrotask(() => {
        if (!this.versions.hasKeySubscribers(key)) this.activeDiscoveries.delete(key);
      });
    };
  }

  getResult(discovery: AgentSkillsDiscovery): AgentSkillListResult {
    const key = getDiscoveryKey(discovery);
    return this.versions.get(key, () => this.entries.get(key)?.result ?? EMPTY_RESULT);
  }

  /** Refetch only a list that missed a source or failed, and only if no request is in flight. */
  ensureFresh(discovery: AgentSkillsDiscovery): void {
    const key = getDiscoveryKey(discovery);
    if (this.entries.get(key)?.stale !== true || this.requests.has(key)) return;
    this.fetch(key, discovery);
  }

  dispose(): void {
    this.unbindSignals?.();
    this.unbindSignals = null;
    this.refreshController.dispose();
    this.requests.clear();
    this.entries.clear();
    this.activeDiscoveries.clear();
    this.versions.clear();
  }

  private bindSignals(): void {
    if (this.unbindSignals) return;
    this.refreshController.bindListeners();
    const refresh = () => this.refreshController.requestImmediate();
    const unsubscribePlugins = subscribeAgentPluginsMutated(refresh);
    if (typeof window !== "undefined") {
      window.addEventListener(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED, refresh);
    }
    this.unbindSignals = () => {
      unsubscribePlugins();
      if (typeof window !== "undefined") {
        window.removeEventListener(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED, refresh);
      }
    };
  }

  private refreshActive(): void {
    for (const [key, discovery] of this.activeDiscoveries) this.fetch(key, discovery);
  }

  private fetch(key: string, discovery: AgentSkillsDiscovery): void {
    const client = this.client;
    if (!client) return;

    const id = ++this.nextRequestId;
    this.requests.set(key, id);
    client.agentSkills.list(discovery).then(
      (result) => this.settle(key, id, { result, stale: result.unavailableSources.length > 0 }),
      (error: unknown) => {
        console.error("[AgentSkillsStore] Failed to load agent skills:", error);
        // Keep the last good list: a failed refresh must not empty the `$` menu.
        const result = this.entries.get(key)?.result ?? EMPTY_RESULT;
        this.settle(key, id, { result, stale: true });
      }
    );
  }

  private settle(key: string, id: number, entry: Entry): void {
    // A newer request, or a client change, owns this key now.
    if (this.requests.get(key) !== id) return;
    this.requests.delete(key);
    this.entries.set(key, entry);
    this.versions.bump(key);
  }
}

let agentSkillsStoreInstance: AgentSkillsStore | null = null;

export function getAgentSkillsStore(): AgentSkillsStore {
  agentSkillsStoreInstance ??= new AgentSkillsStore();
  return agentSkillsStoreInstance;
}

/** `null` does not subscribe, for example while the command palette is closed. */
export function useAgentSkills(discovery: AgentSkillsDiscovery | null): AgentSkillListResult {
  const store = getAgentSkillsStore();
  return useSyncExternalStore(
    (listener) => (discovery ? store.subscribe(discovery, listener) : () => undefined),
    () => (discovery ? store.getResult(discovery) : EMPTY_RESULT)
  );
}
