import { useEffect, type ReactNode } from "react";

import { useAPI } from "@/browser/contexts/API";
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
import { isPlainObject } from "@/common/utils/isPlainObject";
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

  useEffect(() => {
    if (!api) {
      return;
    }

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

  return props.children;
}
