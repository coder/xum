import {
  pruneUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";

export interface UserPreferenceStorageArea {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface StoredUserPreferenceEntry {
  key: string;
  value: unknown;
}

// Every preference now reads the typed store, so no localStorage key maps to one. The mirror
// that consumes this module is deleted with UserPreferencesContext.
export function isUserPreferenceStorageKey(_key: string): boolean {
  return false;
}

export function applyStoredUserPreference(
  preferences: UserPreferences | undefined,
  _key: string,
  _value: unknown
): UserPreferences | undefined {
  return pruneUserPreferences(preferences ? structuredClone(preferences) : {});
}

export function removeStoredUserPreference(
  preferences: UserPreferences | undefined,
  _key: string
): UserPreferences | undefined {
  return pruneUserPreferences(preferences ? structuredClone(preferences) : {});
}

export function entriesFromUserPreferences(
  _preferences: UserPreferences | undefined
): StoredUserPreferenceEntry[] {
  return [];
}

export function getStoredUserPreferenceKeys(_storage: UserPreferenceStorageArea): string[] {
  return [];
}
