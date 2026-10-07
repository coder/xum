import {
  pruneUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  REVIEW_INCLUDE_UNCOMMITTED_KEY,
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
  getReviewDefaultBaseKey,
} from "@/common/constants/storage";
import { parseBoolean, parseNonEmptyString } from "@/common/preferences/userPreferenceParsing";

export interface UserPreferenceStorageArea {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface StoredUserPreferenceEntry {
  key: string;
  value: unknown;
}

const STATIC_USER_PREFERENCE_KEYS = new Set<string>([REVIEW_INCLUDE_UNCOMMITTED_KEY]);

const DYNAMIC_USER_PREFERENCE_PREFIXES = [
  getNotifyOnResponseAutoEnableKey(""),
  getNotifyOnResponseKey(""),
  getReviewDefaultBaseKey(""),
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
  if (STATIC_USER_PREFERENCE_KEYS.has(key)) {
    return key;
  }

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

function ensureReview(preferences: UserPreferences): NonNullable<UserPreferences["review"]> {
  preferences.review ??= {};
  return preferences.review;
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

  if (key === REVIEW_INCLUDE_UNCOMMITTED_KEY) {
    const parsed = parseBoolean(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    ensureReview(next).includeUncommitted = parsed;
    return pruneUserPreferences(next);
  }

  const reviewDefaultProjectPath = readSuffix(key, getReviewDefaultBaseKey(""));
  if (reviewDefaultProjectPath) {
    const parsed = parseNonEmptyString(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    const review = ensureReview(next);
    review.defaultBaseByProject ??= {};
    review.defaultBaseByProject[reviewDefaultProjectPath] = parsed;
    return pruneUserPreferences(next);
  }

  return pruneUserPreferences(next);
}

export function removeStoredUserPreference(
  preferences: UserPreferences | undefined,
  key: string
): UserPreferences | undefined {
  const next = cloneUserPreferences(preferences);

  if (key === REVIEW_INCLUDE_UNCOMMITTED_KEY) delete next.review?.includeUncommitted;
  else {
    const autoNotifyProjectPath = readSuffix(key, getNotifyOnResponseAutoEnableKey(""));
    const notifyWorkspaceId = readSuffix(key, getNotifyOnResponseKey(""));
    const reviewDefaultProjectPath = readSuffix(key, getReviewDefaultBaseKey(""));

    if (autoNotifyProjectPath)
      delete next.workspaceCreation?.byProject?.[autoNotifyProjectPath]?.notifyOnResponseAutoEnable;
    else if (notifyWorkspaceId)
      delete next.notifications?.notifyOnResponseByWorkspace?.[notifyWorkspaceId];
    else if (reviewDefaultProjectPath)
      delete next.review?.defaultBaseByProject?.[reviewDefaultProjectPath];
  }

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

  if (preferences.review?.includeUncommitted !== undefined)
    entries.push({
      key: REVIEW_INCLUDE_UNCOMMITTED_KEY,
      value: preferences.review.includeUncommitted,
    });
  for (const [projectPath, defaultBase] of Object.entries(
    preferences.review?.defaultBaseByProject ?? {}
  )) {
    entries.push({ key: getReviewDefaultBaseKey(projectPath), value: defaultBase });
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
