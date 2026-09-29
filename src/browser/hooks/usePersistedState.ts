import type { Dispatch, SetStateAction } from "react";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { getStorageChangeEvent } from "@/common/constants/events";
import { getPersistedKeyKind } from "@/common/constants/storage";

type SetValue<T> = T | ((prev: T) => T);

interface Subscriber {
  callback: () => void;
  componentId: string;
  listener: boolean;
}

export type PersistedStateWriteSource = "local" | "backend";

export interface PersistedStateWriteEvent {
  key: string;
  newValue: unknown;
  source: PersistedStateWriteSource;
}

type PersistedStateWriteListener = (event: PersistedStateWriteEvent) => void;

const writeListeners = new Set<PersistedStateWriteListener>();

export function subscribePersistedStateWrites(listener: PersistedStateWriteListener): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

function notifyWriteListeners(event: PersistedStateWriteEvent): void {
  for (const listener of writeListeners) {
    listener(event);
  }
}

const subscribersByKey = new Map<string, Set<Subscriber>>();

function addSubscriber(key: string, subscriber: Subscriber): () => void {
  const subs = subscribersByKey.get(key) ?? new Set<Subscriber>();
  subs.add(subscriber);
  subscribersByKey.set(key, subs);

  return () => {
    const current = subscribersByKey.get(key);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) {
      subscribersByKey.delete(key);
    }
  };
}

function notifySubscribers(key: string, origin?: string, includeNonListeners = false) {
  const subs = subscribersByKey.get(key);
  if (!subs) return;

  for (const sub of subs) {
    // If listener=false, only react to this hook instance or explicit cache hydration.
    if (!includeNonListeners && !sub.listener) {
      if (!origin || origin !== sub.componentId) continue;
    }
    sub.callback();
  }
}

function isQuotaExceededError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  // Chromium/WebKit throw "QuotaExceededError" (legacy code 22); Firefox uses its own name/code.
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

// A failing key fails on every keystroke; one warning per key per session keeps the console usable.
const keysWithReportedWriteFailures = new Set<string>();

function reportWriteFailureOnce(key: string, error: unknown): void {
  if (keysWithReportedWriteFailures.has(key)) return;
  keysWithReportedWriteFailures.add(key);
  console.warn(
    `Error writing to localStorage key "${key}" (further failures for this key are not logged):`,
    error
  );
}

/**
 * Free space by removing registry `cache` keys (refetchable data such as LRU cache entries and
 * cached plan content). Drafts, review data and preferences are never evicted: losing them is the
 * failure this eviction exists to prevent. Returns how many keys were removed.
 */
function evictCacheKeys(storage: Storage): number {
  const cacheKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && getPersistedKeyKind(key) === "cache") cacheKeys.push(key);
  }
  for (const key of cacheKeys) {
    storage.removeItem(key);
  }
  return cacheKeys.length;
}

/**
 * The single low-level localStorage write for persisted state. null/undefined remove the key.
 * On QuotaExceededError it evicts cache keys and retries once. Returns false when the value could
 * not be stored; callers skip change notifications then, because nothing changed on disk.
 */
function writePersistedValue(key: string, newValue: unknown): boolean {
  if (newValue === undefined || newValue === null) {
    window.localStorage.removeItem(key);
    return true;
  }
  return writeSerializedValue(key, JSON.stringify(newValue));
}

/** Store an already-serialized value (see writePersistedValue for the quota handling). */
function writeSerializedValue(key: string, serialized: string): boolean {
  const storage = window.localStorage;
  try {
    storage.setItem(key, serialized);
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error) || evictCacheKeys(storage) === 0) {
      reportWriteFailureOnce(key, error);
      return false;
    }
  }

  try {
    storage.setItem(key, serialized);
    return true;
  } catch (retryError) {
    reportWriteFailureOnce(key, retryError);
    return false;
  }
}

let storageListenerInstalled = false;
function ensureStorageListenerInstalled() {
  if (storageListenerInstalled) return;
  // Guard against test environments that stub `globalThis.window` with a
  // partial object lacking `addEventListener`. Treating that as a no-op
  // mirrors the SSR-safe fallback above and prevents unrelated tests from
  // crashing when they run after a polluting test.
  if (typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;

  window.addEventListener("storage", (e: StorageEvent) => {
    if (!e.key) return;
    // Cross-tab update: only listener=true subscribers should react.
    notifySubscribers(e.key);
  });

  storageListenerInstalled = true;
}
/**
 * Whether localStorage can be used. Browsers that deny storage access throw from the
 * window.localStorage getter itself; reads run in render paths (state initializers), so they fall
 * back to their defaults instead of throwing.
 */
function isLocalStorageReadable(): boolean {
  try {
    return typeof window !== "undefined" && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

/**
 * Read a persisted state value from localStorage (non-hook version)
 * Mirrors the reading logic from usePersistedState
 *
 * @param key - The localStorage key
 * @param defaultValue - Value to return if key doesn't exist or parsing fails
 * @returns The parsed value or defaultValue
 */
export function readPersistedState<T>(key: string, defaultValue: T): T {
  if (!isLocalStorageReadable()) {
    return defaultValue;
  }

  try {
    const storedValue = window.localStorage.getItem(key);
    if (storedValue === null || storedValue === "undefined") {
      return defaultValue;
    }
    return JSON.parse(storedValue) as T;
  } catch (error) {
    console.error(`Failed to read persisted state for key "${key}":`, error);
    return defaultValue;
  }
}

/** Every persisted key starting with `prefix` (e.g. to migrate a family of legacy keys). */
export function listPersistedKeys(prefix: string): string[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }
  const storage = window.localStorage;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/**
 * Read a persisted string value from localStorage.
 *
 * Unlike readPersistedState(), this tolerates values that were written as raw
 * strings (not JSON) by legacy code.
 */
export function readPersistedString(key: string): string | undefined {
  if (!isLocalStorageReadable()) {
    return undefined;
  }

  const storedValue = window.localStorage.getItem(key);
  if (storedValue === null || storedValue === "undefined") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Fall through to raw string.
  }

  return storedValue;
}

/**
 * List persisted-state keys that start with any of the given prefixes.
 * localStorage has no prefix query, so this is one pass over every key. Returns a snapshot,
 * so callers may remove the returned keys without skipping any (index iteration would shift).
 */
export function listPersistedStateKeys(prefixes: readonly string[]): string[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }

  const storage = window.localStorage;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && prefixes.some((prefix) => key.startsWith(prefix))) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Read a stored value exactly as written (no JSON parsing), or null when absent/unavailable.
 * For keys whose on-disk format must stay raw so older builds can still read them.
 */
export function readPersistedRawString(key: string): string | null {
  // The availability check is inside the try: browsers that deny storage access throw from the
  // window.localStorage getter itself, and callers (e.g. the auth token read during render) expect
  // null then.
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Store `value` verbatim (no JSON encoding) through the shared write path. Used for raw-format
 * keys and for copying already-serialized values (workspace fork). Does not notify subscribers:
 * raw keys have no hook consumers, and fork copies target a scope nothing has mounted yet.
 * Returns false when the value could not be stored.
 */
export function writePersistedRawString(key: string, value: string): boolean {
  try {
    // Inside the try for the same reason as readPersistedRawString.
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }
    return writeSerializedValue(key, value);
  } catch (error) {
    reportWriteFailureOnce(key, error);
    return false;
  }
}

/**
 * Remove many keys in one pass (startup cleanups, workspace deletion, orphan GC), then notify
 * write listeners and hook subscribers once per key so mounted consumers do not write a stale
 * value back. Unlike updatePersistedState it dispatches no per-key window CustomEvent: the only
 * key-specific window listeners (sidebar last-read keys of listed workspaces, resizable sidebar
 * widths, experiment flags) never watch keys these callers remove.
 */
export function removePersistedStateKeys(keys: readonly string[]): void {
  if (typeof window === "undefined" || !window.localStorage || keys.length === 0) {
    return;
  }
  const storage = window.localStorage;
  // Absent keys are skipped so callers that pass every possible key (workspace deletion) do not
  // wake listeners, e.g. the preferences sync, for values that never existed.
  const removed = keys.filter((key) => storage.getItem(key) !== null);
  for (const key of removed) {
    storage.removeItem(key);
  }
  for (const key of removed) {
    notifyWriteListeners({ key, newValue: undefined, source: "local" });
    notifySubscribers(key);
  }
}

/** True when a cross-tab `storage` event came from the persisted-state storage area. */
export function isPersistedStateStorageEvent(event: StorageEvent): boolean {
  return typeof window !== "undefined" && event.storageArea === window.localStorage;
}

/**
 * The persisted-state Storage, or null outside a browser. Only for reads and identity checks by
 * code that takes an injectable Storage (tests pass their own); writes must go through
 * updatePersistedState/syncPersistedStateFromBackend/removePersistedStateKeys.
 */
export function getPersistedStateStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

/**
 * Update a persisted state value from outside the hook.
 * This is useful when you need to update state from a different component/context
 * that doesn't have access to the setter (e.g., command palette updating workspace state).
 *
 * Supports functional updates to avoid races when toggling values.
 *
 * @param key - The same localStorage key used in usePersistedState
 * @param value - The new value to set, or a functional updater
 * @param defaultValue - Optional default value when reading existing state for functional updates
 * @returns false when the value could not be stored (e.g. quota exceeded even after evicting caches)
 */
export function updatePersistedState<T>(
  key: string,
  value: T | ((prev: T) => T),
  defaultValue?: T
): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return false;
  }

  try {
    const newValue: T | null | undefined =
      typeof value === "function"
        ? (value as (prev: T) => T)(readPersistedState(key, defaultValue as T))
        : value;

    if (!writePersistedValue(key, newValue)) {
      return false;
    }

    notifyWriteListeners({ key, newValue, source: "local" });

    // Notify same-tab subscribers (usePersistedState) immediately.
    notifySubscribers(key);

    // Dispatch custom event for same-tab synchronization for non-hook listeners.
    // No origin since this is an external update - all listeners should receive it.
    const customEvent = new CustomEvent(getStorageChangeEvent(key), {
      detail: { key, newValue },
    });
    window.dispatchEvent(customEvent);
    return true;
  } catch (error) {
    reportWriteFailureOnce(key, error);
    return false;
  }
}

export function syncPersistedStateFromBackend(key: string, newValue: unknown): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    if (!writePersistedValue(key, newValue)) {
      return;
    }

    notifyWriteListeners({ key, newValue, source: "backend" });
    notifySubscribers(key, undefined, true);

    const customEvent = new CustomEvent(getStorageChangeEvent(key), {
      detail: { key, newValue, source: "backend" },
    });
    window.dispatchEvent(customEvent);
  } catch (error) {
    reportWriteFailureOnce(key, error);
  }
}

interface UsePersistedStateOptions {
  /** Enable listening to storage changes from other components/tabs */
  listener?: boolean;
}

/**
 * Custom hook that persists state to localStorage with automatic synchronization.
 * Follows React's useState API while providing localStorage persistence.
 *
 * @param key - Unique localStorage key
 * @param initialValue - Default value if localStorage is empty or invalid
 * @param options - Optional configuration { listener: true } for cross-component sync
 * @returns [state, setState] tuple matching useState API
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T,
  options?: UsePersistedStateOptions
): [T, Dispatch<SetStateAction<T>>] {
  // Unique component ID for distinguishing self-updates.
  const componentIdRef = useRef(Math.random().toString(36));

  ensureStorageListenerInstalled();

  const subscribe = useCallback(
    (callback: () => void) => {
      return addSubscriber(key, {
        callback,
        componentId: componentIdRef.current,
        listener: Boolean(options?.listener),
      });
    },
    [key, options?.listener]
  );

  // Match the previous `usePersistedState` behavior: `initialValue` is only used
  // as the default when no value is stored; changes to `initialValue` should not
  // reinitialize state.
  const initialValueRef = useRef(initialValue);

  // useSyncExternalStore requires getSnapshot() to be referentially stable when
  // the underlying store value is unchanged. Since localStorage values are JSON,
  // we cache the parsed value by raw string.
  const snapshotRef = useRef<{ key: string; raw: string | null; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    if (typeof window === "undefined" || !window.localStorage) {
      return initialValueRef.current;
    }

    try {
      const raw = window.localStorage.getItem(key);

      if (raw === null || raw === "undefined") {
        if (snapshotRef.current?.key === key && snapshotRef.current.raw === null) {
          return snapshotRef.current.value;
        }

        snapshotRef.current = {
          key,
          raw: null,
          value: initialValueRef.current,
        };

        return initialValueRef.current;
      }

      if (snapshotRef.current?.key === key && snapshotRef.current.raw === raw) {
        return snapshotRef.current.value;
      }

      const parsed = JSON.parse(raw) as T;
      snapshotRef.current = { key, raw, value: parsed };
      return parsed;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return initialValueRef.current;
    }
  }, [key]);

  const getServerSnapshot = useCallback(() => initialValueRef.current, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setPersistedState = useCallback(
    (value: SetValue<T>) => {
      if (typeof window === "undefined" || !window.localStorage) {
        return;
      }

      try {
        const prevState = readPersistedState<T>(key, initialValueRef.current);
        const newValue = value instanceof Function ? value(prevState) : value;

        if (!writePersistedValue(key, newValue)) {
          return;
        }

        notifyWriteListeners({ key, newValue, source: "local" });

        // Notify hook subscribers synchronously (keeps UI responsive).
        notifySubscribers(key, componentIdRef.current);

        // Dispatch custom event for same-tab synchronization for non-hook listeners.
        const customEvent = new CustomEvent(getStorageChangeEvent(key), {
          detail: { key, newValue, origin: componentIdRef.current },
        });
        window.dispatchEvent(customEvent);
      } catch (error) {
        reportWriteFailureOnce(key, error);
      }
    },
    [key]
  );

  return [state, setPersistedState];
}
