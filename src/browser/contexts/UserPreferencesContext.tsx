import { useEffect, useState, type ReactNode } from "react";

import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  getPersistedStateStorage,
  subscribePersistedStateWrites,
  syncPersistedStateFromBackend,
} from "@/browser/hooks/usePersistedState";
import {
  normalizeUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  getAppConfigStore,
  getUserPreferences,
  updateUserPreferences,
  type UserPreferencesPatch,
} from "@/browser/stores/AppConfigStore";
import {
  applyStoredUserPreference,
  entriesFromUserPreferences,
  getStoredUserPreferenceKeys,
  isUserPreferenceStorageKey,
  removeStoredUserPreference,
} from "@/common/preferences/userPreferencesStorage";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { assert } from "@/common/utils/assert";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { normalizeOrder } from "@/common/utils/projectOrdering";
import { stableStringify } from "@/common/utils/stableStringify";

// Tests inject their own Storage; production reads the persisted-state storage and writes to it
// only through syncPersistedStateFromBackend (see writeBackendEntryToLocalStorage).
const getLocalStorage = getPersistedStateStorage;

function writeBackendEntryToLocalStorage(entry: { key: string; value: unknown }, storage: Storage) {
  if (storage === getLocalStorage()) {
    syncPersistedStateFromBackend(entry.key, entry.value);
    return;
  }

  storage.setItem(entry.key, JSON.stringify(entry.value));
}

function removeBackendEntryFromLocalStorage(key: string, storage: Storage) {
  if (storage === getLocalStorage()) {
    syncPersistedStateFromBackend(key, undefined);
    return;
  }

  storage.removeItem(key);
}

export function mirrorBackendPreferences(params: {
  backendPreferences: UserPreferences | undefined;
  storage: Storage;
}) {
  const backendEntries = entriesFromUserPreferences(params.backendPreferences);
  const backendKeys = new Set(backendEntries.map((entry) => entry.key));

  for (const entry of backendEntries) {
    writeBackendEntryToLocalStorage(entry, params.storage);
  }

  for (const key of getStoredUserPreferenceKeys(params.storage)) {
    if (!backendKeys.has(key)) {
      removeBackendEntryFromLocalStorage(key, params.storage);
    }
  }
}

/** Writes the store's preferences into the local copies that RouterProvider reads at mount. */
export function mirrorUserPreferencesLocalCache(): void {
  const storage = getLocalStorage();
  if (storage) {
    mirrorBackendPreferences({
      backendPreferences: getUserPreferences(),
      storage,
    });
  }
}

export function prunePreferenceScopes(params: {
  preferences: UserPreferences | undefined;
  projectPaths: Set<string>;
  workspaceIds: Set<string>;
  userProjects: Parameters<typeof normalizeOrder>[1];
}): UserPreferences | undefined {
  const next = params.preferences
    ? (JSON.parse(JSON.stringify(params.preferences)) as UserPreferences)
    : undefined;
  if (!next) {
    return undefined;
  }

  const pruneProjectRecord = <T,>(record: Record<string, T> | undefined) => {
    if (!record) {
      return;
    }
    for (const projectPath of Object.keys(record)) {
      // The scratch composer persists AI prefs under the scratch system project
      // scope, which userProjects excludes and which may not exist in config yet.
      // Keep it valid here or pruning deletes those prefs and the picker reverts.
      if (projectPath === SCRATCH_PROJECT_CONFIG_KEY) {
        continue;
      }
      if (!params.projectPaths.has(projectPath)) {
        delete record[projectPath];
      }
    }
  };

  if (next.navigation?.projectOrder) {
    next.navigation.projectOrder = normalizeOrder(
      next.navigation.projectOrder,
      params.userProjects
    );
  }

  pruneProjectRecord(next.ai?.projectDefaults);
  pruneProjectRecord(next.workspaceCreation?.byProject);
  pruneProjectRecord(next.review?.defaultBaseByProject);

  const workspaceNotifications = next.notifications?.notifyOnResponseByWorkspace;
  if (workspaceNotifications) {
    for (const workspaceId of Object.keys(workspaceNotifications)) {
      if (!params.workspaceIds.has(workspaceId)) {
        delete workspaceNotifications[workspaceId];
      }
    }
  }

  return normalizeUserPreferences(next);
}

export function canPrunePreferenceScopes(params: {
  hydrated: boolean;
  projectLoading: boolean;
  projectLoaded: boolean;
  projectLoadError: string | null | undefined;
  workspaceLoading: boolean;
  workspaceLoaded: boolean;
  workspaceLoadError: string | null | undefined;
}): boolean {
  return (
    params.hydrated &&
    !params.projectLoading &&
    params.projectLoaded &&
    params.projectLoadError == null &&
    !params.workspaceLoading &&
    params.workspaceLoaded &&
    params.workspaceLoadError == null
  );
}

const USER_PREFERENCE_RETRY_BASE_DELAY_MS = 250;
const USER_PREFERENCE_RETRY_MAX_DELAY_MS = 5000;

function getUserPreferenceRetryDelayMs(retryAttempt: number): number {
  return Math.min(
    USER_PREFERENCE_RETRY_BASE_DELAY_MS * 2 ** retryAttempt,
    USER_PREFERENCE_RETRY_MAX_DELAY_MS
  );
}

function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(finish, delayMs);
    function finish() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

interface UserPreferenceConfigClient {
  saveConfig: (input: { userPreferences?: UserPreferences | null }) => Promise<void>;
}

const USER_PREFERENCE_SAVE_FAILED_MESSAGE = "Settings could not be saved";

export interface UserPreferenceSaveQueue {
  /**
   * Queue the latest preferences snapshot. `changedKeys` names the storage keys whose
   * values this snapshot carries fresh writes for; each one gets a new requested version
   * that `waitForPersisted` can wait on.
   */
  enqueue: (preferences: UserPreferences | undefined, changedKeys?: Iterable<string>) => void;
  /**
   * Record fresh local writes for `keys` that are NOT being saved yet (writes made before
   * hydration ride along with the hydration save). Waiters on those keys stay pending until
   * that later save acknowledges them, or `settle` confirms the backend already holds them.
   */
  reserve: (keys: Iterable<string>) => void;
  /** The backend already holds the reserved values for `keys`; release their waiters. */
  settle: (keys: Iterable<string>) => void;
  /**
   * Resolve once the backend has acknowledged the latest write requested for `key` at
   * call time. Rejects when the save attempt carrying that write fails (the queue keeps
   * retrying in the background) or when `signal` aborts; callers tell the two apart via
   * `signal.aborted`.
   */
  waitForPersisted: (key: string, signal: AbortSignal) => Promise<void>;
}

export function createUserPreferenceSaveQueue(params: {
  configClient: UserPreferenceConfigClient;
  signal: AbortSignal;
  getCurrentPreferences: () => UserPreferences | undefined;
  clearDirtyKeys: () => void;
  onError: (message: string, error: unknown) => void;
}): UserPreferenceSaveQueue {
  interface PendingPreferenceSave {
    value: UserPreferences | undefined;
    // Requested version per key at the moment the snapshot was taken, so an acknowledgement
    // credits exactly the writes the saved payload carried.
    versions: ReadonlyMap<string, number>;
  }
  interface PersistenceWaiter {
    key: string;
    version: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }
  let saveInFlight = false;
  let pendingSave: PendingPreferenceSave | null = null;
  let retryAttempt = 0;
  const requestedVersions = new Map<string, number>();
  const acknowledgedVersions = new Map<string, number>();
  const waiters = new Set<PersistenceWaiter>();

  const takeWaiters = (shouldTake: (waiter: PersistenceWaiter) => boolean) => {
    const taken: PersistenceWaiter[] = [];
    for (const waiter of waiters) {
      if (shouldTake(waiter)) {
        waiters.delete(waiter);
        taken.push(waiter);
      }
    }
    return taken;
  };

  const acknowledgeSave = (versions: ReadonlyMap<string, number>) => {
    for (const [key, version] of versions) {
      const requested = requestedVersions.get(key) ?? 0;
      const acknowledged = acknowledgedVersions.get(key) ?? 0;
      assert(version <= requested, "acknowledged preference version cannot exceed requested");
      assert(version >= acknowledged, "acknowledged preference versions must be monotonic");
      acknowledgedVersions.set(key, version);
    }
    for (const waiter of takeWaiters(
      (waiter) => (acknowledgedVersions.get(waiter.key) ?? 0) >= waiter.version
    )) {
      waiter.resolve();
    }
  };

  const failWaiters = (shouldFail: (waiter: PersistenceWaiter) => boolean) => {
    for (const waiter of takeWaiters(shouldFail)) {
      waiter.reject(new Error(USER_PREFERENCE_SAVE_FAILED_MESSAGE));
    }
  };

  // Once the owning scope aborts nothing pending is ever acknowledged, so release waiters
  // as failures instead of letting callers hang.
  params.signal.addEventListener(
    "abort",
    () => {
      failWaiters(() => true);
    },
    { once: true }
  );

  const flush = async () => {
    saveInFlight = true;
    try {
      while (pendingSave !== null && !params.signal.aborted) {
        const preferencesToSave = pendingSave.value;
        const savedVersions = pendingSave.versions;
        pendingSave = null;
        const savedFingerprint = stableStringify(preferencesToSave);

        try {
          await params.configClient.saveConfig({ userPreferences: preferencesToSave ?? null });
        } catch (error) {
          const hasNewerPendingSave = pendingSave !== null;
          if (!hasNewerPendingSave) {
            pendingSave = { value: preferencesToSave, versions: savedVersions };
          }
          // Only writes this attempt actually carried failed; newer versions of the same key
          // still have their own attempt ahead of them.
          failWaiters((waiter) => waiter.version <= (savedVersions.get(waiter.key) ?? 0));

          const retryDelayMs = getUserPreferenceRetryDelayMs(retryAttempt);
          retryAttempt += 1;
          params.onError(
            `Failed to persist user preferences, retrying in ${retryDelayMs}ms:`,
            error
          );
          await waitForRetryDelay(retryDelayMs, params.signal);
          continue;
        }

        retryAttempt = 0;
        acknowledgeSave(savedVersions);
        if (params.signal.aborted) {
          return;
        }

        if (stableStringify(params.getCurrentPreferences()) === savedFingerprint) {
          params.clearDirtyKeys();
        }
      }
    } finally {
      saveInFlight = false;
      if (pendingSave !== null && !params.signal.aborted) {
        const retry = flush();
        retry.catch((error) => {
          params.onError("Failed to retry user preference persistence:", error);
        });
      }
    }
  };

  const reserve: UserPreferenceSaveQueue["reserve"] = (keys) => {
    for (const key of keys) {
      requestedVersions.set(key, (requestedVersions.get(key) ?? 0) + 1);
    }
  };

  const settle: UserPreferenceSaveQueue["settle"] = (keys) => {
    const settled = new Map<string, number>();
    for (const key of keys) {
      const requested = requestedVersions.get(key) ?? 0;
      if (requested > (acknowledgedVersions.get(key) ?? 0)) settled.set(key, requested);
    }
    if (settled.size > 0) acknowledgeSave(settled);
  };

  const enqueue: UserPreferenceSaveQueue["enqueue"] = (preferences, changedKeys) => {
    reserve(changedKeys ?? []);
    pendingSave = { value: preferences, versions: new Map(requestedVersions) };
    if (saveInFlight) {
      return;
    }

    const flushPromise = flush();
    flushPromise.catch((error) => {
      params.onError("Failed to flush user preference persistence:", error);
    });
  };

  const waitForPersisted: UserPreferenceSaveQueue["waitForPersisted"] = (key, signal) => {
    const requested = requestedVersions.get(key) ?? 0;
    const acknowledged = acknowledgedVersions.get(key) ?? 0;
    assert(acknowledged <= requested, "acknowledged preference version cannot exceed requested");
    if (acknowledged >= requested) {
      return Promise.resolve();
    }
    const abortError = (): Error =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Preference wait aborted", "AbortError");
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    if (params.signal.aborted) {
      return Promise.reject(new Error(USER_PREFERENCE_SAVE_FAILED_MESSAGE));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: PersistenceWaiter = {
        key,
        version: requested,
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      function onAbort() {
        waiters.delete(waiter);
        waiter.reject(abortError());
      }
      waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  return { enqueue, reserve, settle, waitForPersisted };
}

/**
 * Builds the merge patch that turns `before` into `after`. Temporary: only this provider's
 * key-based writes need it until callers patch typed preferences directly.
 */
export function createMergePatch(
  before: UserPreferences,
  after: UserPreferences
): UserPreferencesPatch {
  // Null only stored values, never an emptied ancestor: that would also erase a sibling another
  // client added since this snapshot. Entries hold the stored objects themselves, so identity works.
  const storedValues = new Set(entriesFromUserPreferences(before).map((entry) => entry.value));
  const deletion = (value: unknown): unknown =>
    isPlainObject(value) && !storedValues.has(value)
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, deletion(child)]))
      : null;
  const diff = (from: unknown, to: unknown): unknown => {
    if (!isPlainObject(from) || !isPlainObject(to)) {
      return to;
    }
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(from)) {
      if (to[key] === undefined) {
        patch[key] = deletion(from[key]);
      }
    }
    for (const [key, value] of Object.entries(to)) {
      if (value !== undefined && stableStringify(value) !== stableStringify(from[key])) {
        patch[key] = diff(from[key], value);
      }
    }
    return patch;
  };
  return diff(before, after) as UserPreferencesPatch;
}

export function UserPreferencesProvider(props: { children: ReactNode }) {
  const { api } = useAPI();
  const projectContext = useProjectContext();
  const workspaceContext = useWorkspaceContext();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!api) {
      setHydrated(false);
      return;
    }

    setHydrated(false);

    const storage = getLocalStorage();
    if (!storage) {
      return;
    }

    const appConfigStore = getAppConfigStore();
    let mirroredPreferences: UserPreferences | undefined;
    const applyBackendPreferences = () => {
      const snapshotPreferences = appConfigStore.getSnapshot()?.userPreferences;
      // The store keeps the previous object for unchanged values, so unrelated config writes skip.
      if (snapshotPreferences === undefined || snapshotPreferences === mirroredPreferences) {
        return;
      }
      mirroredPreferences = snapshotPreferences;
      mirrorBackendPreferences({
        backendPreferences: normalizeUserPreferences(snapshotPreferences),
        storage,
      });
      setHydrated(true);
    };

    const unsubscribeWrites = subscribePersistedStateWrites((event) => {
      if (event.source === "backend" || !isUserPreferenceStorageKey(event.key)) {
        return;
      }

      const before = getUserPreferences();
      const after =
        event.newValue === undefined || event.newValue === null
          ? removeStoredUserPreference(before, event.key)
          : applyStoredUserPreference(before, event.key, event.newValue);
      updateUserPreferences(createMergePatch(before, after ?? {}));
    });

    const unsubscribeStore = appConfigStore.subscribe(applyBackendPreferences);
    applyBackendPreferences();

    return () => {
      unsubscribeWrites();
      unsubscribeStore();
    };
  }, [api]);

  useEffect(() => {
    if (
      !canPrunePreferenceScopes({
        hydrated,
        projectLoading: projectContext.loading,
        projectLoaded: projectContext.loaded,
        projectLoadError: projectContext.loadError,
        workspaceLoading: workspaceContext.loading,
        workspaceLoaded: workspaceContext.loaded,
        workspaceLoadError: workspaceContext.loadError,
      })
    ) {
      return;
    }

    const projectPaths = new Set(projectContext.userProjects.keys());
    const workspaceIds = new Set(workspaceContext.workspaceMetadata.keys());
    const current = getUserPreferences();
    const pruned = prunePreferenceScopes({
      preferences: current,
      projectPaths,
      workspaceIds,
      userProjects: projectContext.userProjects,
    });

    if (stableStringify(pruned) !== stableStringify(normalizeUserPreferences(current))) {
      updateUserPreferences(createMergePatch(current, pruned ?? {}));
    }
  }, [
    hydrated,
    projectContext.loading,
    projectContext.loaded,
    projectContext.loadError,
    projectContext.userProjects,
    workspaceContext.loading,
    workspaceContext.loaded,
    workspaceContext.loadError,
    workspaceContext.workspaceMetadata,
  ]);

  return props.children;
}
