import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

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
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import {
  applyStoredUserPreference,
  entriesFromUserPreferences,
  getStoredUserPreferenceKeys,
  isUserPreferenceStorageKey,
  readStoredUserPreferenceValue,
  removeStoredUserPreference,
} from "@/common/preferences/userPreferencesStorage";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { getAutoCompactionThresholdKey } from "@/common/constants/storage";
import { assert } from "@/common/utils/assert";
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

export function overlayDirtyLocalValues(
  preferences: UserPreferences | undefined,
  dirtyKeys: Iterable<string>,
  storage: Storage
): UserPreferences | undefined {
  let next = preferences;
  for (const key of dirtyKeys) {
    const value = readStoredUserPreferenceValue(storage, key);
    next =
      value === undefined
        ? removeStoredUserPreference(next, key)
        : applyStoredUserPreference(next, key, value);
  }

  return next;
}

export function mirrorBackendPreferences(params: {
  backendPreferences: UserPreferences | undefined;
  dirtyKeys: ReadonlySet<string>;
  storage: Storage;
}) {
  const backendEntries = entriesFromUserPreferences(params.backendPreferences);
  const backendKeys = new Set(backendEntries.map((entry) => entry.key));

  for (const entry of backendEntries) {
    if (!params.dirtyKeys.has(entry.key)) {
      writeBackendEntryToLocalStorage(entry, params.storage);
    }
  }

  for (const key of getStoredUserPreferenceKeys(params.storage)) {
    if (!backendKeys.has(key) && !params.dirtyKeys.has(key)) {
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
      dirtyKeys: new Set(),
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

/** Preference entries the backend reads at request time, so senders can wait on them. */
export interface UserPreferencePersistenceEntry {
  kind: "autoCompactionThreshold";
  model: string;
}

export interface UserPreferencesPersistenceContextValue {
  /**
   * Resolve once the backend has acknowledged the latest local write for `entry`.
   * Rejects with a user-readable Error when that write's save failed, or with the abort
   * reason when `signal` aborts (distinguish via `signal.aborted`).
   */
  waitForPreferencePersisted: (
    entry: UserPreferencePersistenceEntry,
    signal: AbortSignal
  ) => Promise<void>;
}

function getPersistenceEntryStorageKey(entry: UserPreferencePersistenceEntry): string {
  switch (entry.kind) {
    case "autoCompactionThreshold":
      return getAutoCompactionThresholdKey(entry.model);
  }
}

// Without a provider (unit tests, stories) nothing is pending toward a backend.
export const UserPreferencesPersistenceContext =
  createContext<UserPreferencesPersistenceContextValue>({
    waitForPreferencePersisted: () => Promise.resolve(),
  });

export function useUserPreferencePersistence(): UserPreferencesPersistenceContextValue {
  return useContext(UserPreferencesPersistenceContext);
}

export function UserPreferencesProvider(props: { children: ReactNode }) {
  const { api } = useAPI();
  const projectContext = useProjectContext();
  const workspaceContext = useWorkspaceContext();
  const currentPreferencesRef = useRef<UserPreferences | undefined>(undefined);
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const saveQueueRef = useRef<UserPreferenceSaveQueue | null>(null);
  const hydratedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);

  const persistence: UserPreferencesPersistenceContextValue = {
    waitForPreferencePersisted: (entry, signal) => {
      // Without an API client nothing is pending toward the backend; before hydration the
      // queue holds reserved versions for local writes the hydration save will carry.
      const queue = saveQueueRef.current;
      if (!queue) {
        return Promise.resolve();
      }
      return queue.waitForPersisted(getPersistenceEntryStorageKey(entry), signal);
    },
  };

  useEffect(() => {
    if (!api) {
      saveQueueRef.current = null;
      hydratedRef.current = false;
      setHydrated(false);
      return;
    }

    // Treat every concrete API client identity as a fresh backend source.
    currentPreferencesRef.current = undefined;
    dirtyKeysRef.current.clear();
    hydratedRef.current = false;
    setHydrated(false);

    const storage = getLocalStorage();
    if (!storage) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;

    const saveQueue = createUserPreferenceSaveQueue({
      configClient: api.config,
      signal,
      getCurrentPreferences: () => currentPreferencesRef.current,
      clearDirtyKeys: () => {
        dirtyKeysRef.current.clear();
      },
      onError: (message, error) => {
        console.warn(message, error);
      },
    });

    saveQueueRef.current = saveQueue;

    const appConfigStore = getAppConfigStore();
    let mirroredPreferences: UserPreferences | undefined;
    const applyBackendPreferences = () => {
      const snapshotPreferences = appConfigStore.getSnapshot()?.userPreferences;
      // The store keeps the previous object for unchanged values, so unrelated config writes skip.
      if (snapshotPreferences === undefined || snapshotPreferences === mirroredPreferences) {
        return;
      }
      mirroredPreferences = snapshotPreferences;
      // Empty preferences normalize to undefined, so pruning them finds nothing to save.
      const backendPreferences = normalizeUserPreferences(snapshotPreferences);

      mirrorBackendPreferences({ backendPreferences, dirtyKeys: dirtyKeysRef.current, storage });
      const nextPreferences = overlayDirtyLocalValues(
        backendPreferences,
        dirtyKeysRef.current,
        storage
      );

      currentPreferencesRef.current = nextPreferences;
      hydratedRef.current = true;
      setHydrated(true);

      if (
        dirtyKeysRef.current.size > 0 &&
        stableStringify(nextPreferences) !== stableStringify(backendPreferences)
      ) {
        // Dirty keys written before hydration were reserved, not enqueued; this save carries
        // them, so it owns their requested versions and its acknowledgement releases waiters.
        saveQueue.enqueue(nextPreferences, dirtyKeysRef.current);
      } else {
        // Nothing to save: the backend already holds every dirty value, so their waiters can go.
        saveQueue.settle(dirtyKeysRef.current);
      }
    };

    const unsubscribeWrites = subscribePersistedStateWrites((event) => {
      if (event.source === "backend" || !isUserPreferenceStorageKey(event.key)) {
        return;
      }

      dirtyKeysRef.current.add(event.key);
      currentPreferencesRef.current =
        event.newValue === undefined || event.newValue === null
          ? removeStoredUserPreference(currentPreferencesRef.current, event.key)
          : applyStoredUserPreference(currentPreferencesRef.current, event.key, event.newValue);

      if (!hydratedRef.current) {
        // Not saved yet (hydration will carry it), but a sender waiting on this key must not
        // be released before that save is acknowledged.
        saveQueue.reserve([event.key]);
        return;
      }

      saveQueue.enqueue(currentPreferencesRef.current, [event.key]);
    });

    const unsubscribeStore = appConfigStore.subscribe(applyBackendPreferences);
    applyBackendPreferences();

    return () => {
      abortController.abort();
      unsubscribeWrites();
      unsubscribeStore();
      saveQueueRef.current = null;
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
    const pruned = prunePreferenceScopes({
      preferences: currentPreferencesRef.current,
      projectPaths,
      workspaceIds,
      userProjects: projectContext.userProjects,
    });

    if (stableStringify(pruned) === stableStringify(currentPreferencesRef.current)) {
      return;
    }

    currentPreferencesRef.current = pruned;
    const storage = getLocalStorage();
    if (storage) {
      for (const entry of entriesFromUserPreferences(pruned)) {
        writeBackendEntryToLocalStorage(entry, storage);
      }
    }

    const prunedKeys = new Set(entriesFromUserPreferences(pruned).map((entry) => entry.key));
    if (storage) {
      for (const key of getStoredUserPreferenceKeys(storage)) {
        if (!prunedKeys.has(key)) {
          removeBackendEntryFromLocalStorage(key, storage);
        }
      }
    }

    saveQueueRef.current?.enqueue(pruned);
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

  return (
    <UserPreferencesPersistenceContext.Provider value={persistence}>
      {props.children}
    </UserPreferencesPersistenceContext.Provider>
  );
}
