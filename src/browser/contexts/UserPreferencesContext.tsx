import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  subscribePersistedStateWrites,
  syncPersistedStateFromBackend,
} from "@/browser/hooks/usePersistedState";
import {
  normalizeUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  applyStoredUserPreference,
  entriesFromUserPreferences,
  getStoredUserPreferenceEntries,
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

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }

  return window.localStorage;
}

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

export function mergeMissingLocalPreferences(
  backendPreferences: UserPreferences | undefined,
  storage: Storage
): UserPreferences | undefined {
  const backendKeys = new Set(
    entriesFromUserPreferences(backendPreferences).map((entry) => entry.key)
  );
  let next = backendPreferences;
  for (const entry of getStoredUserPreferenceEntries(storage)) {
    if (backendKeys.has(entry.key)) {
      continue;
    }
    next = applyStoredUserPreference(next, entry.key, entry.value);
  }

  return next;
}

export function mirrorBackendPreferences(params: {
  backendPreferences: UserPreferences | undefined;
  dirtyKeys: ReadonlySet<string>;
  initial: boolean;
  storage: Storage;
}) {
  const backendEntries = entriesFromUserPreferences(params.backendPreferences);
  const backendKeys = new Set(backendEntries.map((entry) => entry.key));

  for (const entry of backendEntries) {
    if (!params.dirtyKeys.has(entry.key)) {
      writeBackendEntryToLocalStorage(entry, params.storage);
    }
  }

  if (params.initial) {
    return;
  }

  for (const key of getStoredUserPreferenceKeys(params.storage)) {
    if (!backendKeys.has(key) && !params.dirtyKeys.has(key)) {
      removeBackendEntryFromLocalStorage(key, params.storage);
    }
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

export async function retryUserPreferenceHydration(params: {
  signal: AbortSignal;
  applyBackendConfig: () => Promise<void>;
  onError: (message: string, error: unknown) => void;
  getRetryDelayMs?: (retryAttempt: number) => number;
  waitForDelay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const getRetryDelayMs = params.getRetryDelayMs ?? getUserPreferenceRetryDelayMs;
  const waitForDelay = params.waitForDelay ?? waitForRetryDelay;
  let retryAttempt = 0;

  while (!params.signal.aborted) {
    try {
      await params.applyBackendConfig();
      return;
    } catch (error) {
      const retryDelayMs = getRetryDelayMs(retryAttempt);
      retryAttempt += 1;
      params.onError(`Failed to hydrate user preferences, retrying in ${retryDelayMs}ms:`, error);
      await waitForDelay(retryDelayMs, params.signal);
    }
  }
}

interface UserPreferenceConfigClient {
  getConfig: () => Promise<{ userPreferences?: unknown; userPreferencesInitialized?: boolean }>;
  saveConfig: (input: { userPreferences?: UserPreferences | null }) => Promise<void>;
}

export function applyLocalPreferenceWrite(params: {
  preferences: UserPreferences | undefined;
  key: string;
  newValue: unknown;
  storage: Storage;
}): UserPreferences | undefined {
  const basePreferences =
    params.preferences ?? mergeMissingLocalPreferences(undefined, params.storage);
  return params.newValue === undefined || params.newValue === null
    ? removeStoredUserPreference(basePreferences, params.key)
    : applyStoredUserPreference(basePreferences, params.key, params.newValue);
}

export function shouldBackfillLocalPreferences(params: {
  backendPreferences: UserPreferences | undefined;
  userPreferencesInitialized: boolean | undefined;
}): boolean {
  return params.userPreferencesInitialized !== true && params.backendPreferences === undefined;
}

export async function hydrateUserPreferencesLocalCache(params: {
  configClient: UserPreferenceConfigClient;
  signal?: AbortSignal;
  storage?: Storage | null;
}): Promise<UserPreferences | undefined> {
  const storage = params.storage ?? getLocalStorage();
  if (!storage || params.signal?.aborted) {
    return undefined;
  }

  const config = await params.configClient.getConfig();
  if (params.signal?.aborted) {
    return undefined;
  }

  const backendPreferences = normalizeUserPreferences(config.userPreferences);
  const shouldBackfill = shouldBackfillLocalPreferences({
    backendPreferences,
    userPreferencesInitialized: config.userPreferencesInitialized,
  });
  mirrorBackendPreferences({
    backendPreferences,
    dirtyKeys: new Set(),
    initial: shouldBackfill,
    storage,
  });

  return shouldBackfill
    ? mergeMissingLocalPreferences(backendPreferences, storage)
    : backendPreferences;
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

    // Treat every concrete API client identity as a fresh backend source. Electron normally
    // reconnects through null, but direct client swaps should still rerun the initial backfill.
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
    let iterator: AsyncIterator<unknown> | null = null;

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

    const applyBackendConfig = async () => {
      const config = await api.config.getConfig();
      if (signal.aborted) {
        return;
      }

      const backendPreferences = normalizeUserPreferences(config.userPreferences);
      const shouldBackfill = shouldBackfillLocalPreferences({
        backendPreferences,
        userPreferencesInitialized: config.userPreferencesInitialized,
      });
      mirrorBackendPreferences({
        backendPreferences,
        dirtyKeys: dirtyKeysRef.current,
        initial: shouldBackfill,
        storage,
      });

      const withLocalBackfill = shouldBackfill
        ? mergeMissingLocalPreferences(backendPreferences, storage)
        : backendPreferences;
      const nextPreferences = overlayDirtyLocalValues(
        withLocalBackfill,
        dirtyKeysRef.current,
        storage
      );

      currentPreferencesRef.current = nextPreferences;
      hydratedRef.current = true;
      setHydrated(true);

      if (
        (shouldBackfill || dirtyKeysRef.current.size > 0) &&
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
      currentPreferencesRef.current = applyLocalPreferenceWrite({
        preferences: currentPreferencesRef.current,
        key: event.key,
        newValue: event.newValue,
        storage,
      });

      if (!hydratedRef.current) {
        // Not saved yet (hydration will carry it), but a sender waiting on this key must not
        // be released before that save is acknowledged.
        saveQueue.reserve([event.key]);
        return;
      }

      saveQueue.enqueue(currentPreferencesRef.current, [event.key]);
    });

    const initialSync = retryUserPreferenceHydration({
      signal,
      applyBackendConfig,
      onError: (message, error) => {
        console.warn(message, error);
      },
    });
    initialSync.catch((error) => {
      console.warn("Failed to retry user preference hydration:", error);
    });

    const subscription = (async () => {
      try {
        const subscribedIterator = await api.config.onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          const cleanup = subscribedIterator.return?.();
          cleanup?.catch(() => undefined);
          return;
        }

        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          const refresh = applyBackendConfig();
          refresh.catch((error) => {
            console.warn("Failed to refresh user preferences:", error);
          });
        }
      } catch {
        // Config subscriptions are cancelled during unmounts and API reconnects.
      }
    })();

    subscription.catch((error) => {
      console.warn("Failed to subscribe to user preference changes:", error);
    });

    return () => {
      abortController.abort();
      unsubscribeWrites();
      const cleanup = iterator?.return?.();
      cleanup?.catch(() => undefined);
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
