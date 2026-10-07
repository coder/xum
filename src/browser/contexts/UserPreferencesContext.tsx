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

/**
 * Builds the merge patch that turns `before` into `after`. Temporary: only this provider's
 * key-based writes need it until callers patch typed preferences directly.
 */
function createMergePatch(before: UserPreferences, after: UserPreferences): UserPreferencesPatch {
  const diff = (from: unknown, to: unknown): unknown => {
    if (!isPlainObject(from) || !isPlainObject(to)) {
      return to;
    }
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(from)) {
      if (to[key] === undefined) {
        patch[key] = null;
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
