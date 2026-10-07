import {
  pruneUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
} from "@/common/constants/storage";
import { parseBoolean } from "@/common/preferences/userPreferenceParsing";

export interface UserPreferenceStorageArea {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface StoredUserPreferenceEntry {
  key: string;
  value: unknown;
}

const DYNAMIC_USER_PREFERENCE_PREFIXES = [
  getNotifyOnResponseAutoEnableKey(""),
  getNotifyOnResponseKey(""),
] as const;

function cloneUserPreferences(preferences: UserPreferences | undefined): UserPreferences {
  return preferences ? (JSON.parse(JSON.stringify(preferences)) as UserPreferences) : {};
}

function parseStoredValue(raw: string | null): unknown {
  if (raw === null || raw === "undefined") {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function readSuffix(key: string, prefix: string): string | undefined {
  if (!key.startsWith(prefix)) {
    return undefined;
  }

  const suffix = key.slice(prefix.length);
  return suffix.length > 0 ? suffix : undefined;
}

function getPreferenceKind(key: string): string | undefined {
  return DYNAMIC_USER_PREFERENCE_PREFIXES.find((prefix) => key.startsWith(prefix));
}

export function isUserPreferenceStorageKey(key: string): boolean {
  return getPreferenceKind(key) !== undefined;
}

function ensureWorkspaceCreationProject(
  preferences: UserPreferences,
  projectPath: string
): NonNullable<NonNullable<UserPreferences["workspaceCreation"]>["byProject"]>[string] {
  preferences.workspaceCreation ??= {};
  preferences.workspaceCreation.byProject ??= {};
  preferences.workspaceCreation.byProject[projectPath] ??= {};
  return preferences.workspaceCreation.byProject[projectPath];
}

function ensureNotifications(
  preferences: UserPreferences
): NonNullable<UserPreferences["notifications"]> {
  preferences.notifications ??= {};
  return preferences.notifications;
}

export function applyStoredUserPreference(
  preferences: UserPreferences | undefined,
  key: string,
  value: unknown
): UserPreferences | undefined {
  const next = cloneUserPreferences(preferences);

  const autoNotifyProjectPath = readSuffix(key, getNotifyOnResponseAutoEnableKey(""));
  if (autoNotifyProjectPath) {
    const parsed = parseBoolean(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    ensureWorkspaceCreationProject(next, autoNotifyProjectPath).notifyOnResponseAutoEnable = parsed;
    return pruneUserPreferences(next);
  }

  const notifyWorkspaceId = readSuffix(key, getNotifyOnResponseKey(""));
  if (notifyWorkspaceId) {
    const parsed = parseBoolean(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    const notifications = ensureNotifications(next);
    notifications.notifyOnResponseByWorkspace ??= {};
    notifications.notifyOnResponseByWorkspace[notifyWorkspaceId] = parsed;
    return pruneUserPreferences(next);
  }

  return pruneUserPreferences(next);
}

export function removeStoredUserPreference(
  preferences: UserPreferences | undefined,
  key: string
): UserPreferences | undefined {
  const next = cloneUserPreferences(preferences);

  const autoNotifyProjectPath = readSuffix(key, getNotifyOnResponseAutoEnableKey(""));
  const notifyWorkspaceId = readSuffix(key, getNotifyOnResponseKey(""));
  if (autoNotifyProjectPath)
    delete next.workspaceCreation?.byProject?.[autoNotifyProjectPath]?.notifyOnResponseAutoEnable;
  else if (notifyWorkspaceId)
    delete next.notifications?.notifyOnResponseByWorkspace?.[notifyWorkspaceId];

  return pruneUserPreferences(next);
}

export function entriesFromUserPreferences(
  preferences: UserPreferences | undefined
): StoredUserPreferenceEntry[] {
  const entries: StoredUserPreferenceEntry[] = [];
  if (!preferences) {
    return entries;
  }

  for (const [projectPath, defaults] of Object.entries(
    preferences.workspaceCreation?.byProject ?? {}
  )) {
    if (defaults.notifyOnResponseAutoEnable !== undefined)
      entries.push({
        key: getNotifyOnResponseAutoEnableKey(projectPath),
        value: defaults.notifyOnResponseAutoEnable,
      });
  }

  for (const [workspaceId, enabled] of Object.entries(
    preferences.notifications?.notifyOnResponseByWorkspace ?? {}
  )) {
    entries.push({ key: getNotifyOnResponseKey(workspaceId), value: enabled });
  }

  return entries;
}

export function readStoredUserPreferenceValue(
  storage: UserPreferenceStorageArea,
  key: string
): unknown {
  return parseStoredValue(storage.getItem(key));
}

export function getStoredUserPreferenceEntries(
  storage: UserPreferenceStorageArea
): StoredUserPreferenceEntry[] {
  const entries: StoredUserPreferenceEntry[] = [];
  for (const key of getStoredUserPreferenceKeys(storage)) {
    const next = applyStoredUserPreference(undefined, key, parseStoredValue(storage.getItem(key)));
    const entry = entriesFromUserPreferences(next).find((candidate) => candidate.key === key);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export function getStoredUserPreferenceKeys(storage: UserPreferenceStorageArea): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || seen.has(key) || !isUserPreferenceStorageKey(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
