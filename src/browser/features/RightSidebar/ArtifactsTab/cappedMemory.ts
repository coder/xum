import { useSyncExternalStore } from "react";

/**
 * A capped, in-memory key -> value map that mounted components read through
 * useSyncExternalStore. View choices (annotate mode, JSON mode, tree expansion) must outlive
 * remounts, and must also reach every mounted copy: a narrow window mounts ArtifactsDialog
 * while the CSS-hidden sidebar panel stays mounted, and a value copied into one instance's state
 * went stale in the other. In memory only: these choices do not need to survive a reload.
 */
export interface CappedMemory<V> {
  get: (key: string) => V | undefined;
  /** Store `value` as the most recent entry (undefined removes it); drops the oldest past the cap. */
  set: (key: string, value: V | undefined) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createCappedMemory<V>(maxEntries: number): CappedMemory<V> {
  if (!(Number.isInteger(maxEntries) && maxEntries > 0)) {
    throw new Error(`createCappedMemory: invalid cap ${maxEntries}`);
  }
  const values = new Map<string, V>();
  const listeners = new Set<() => void>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.delete(key);
      if (value !== undefined) values.set(key, value);
      for (const oldest of values.keys()) {
        if (values.size <= maxEntries) break;
        values.delete(oldest);
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Subscribe to `select(memory.get(key))`. `select` must return a primitive or a stable
 * reference, because useSyncExternalStore compares snapshots with Object.is.
 */
export function useCappedMemory<V, S>(
  memory: CappedMemory<V>,
  key: string,
  select: (value: V | undefined) => S
): S {
  return useSyncExternalStore(memory.subscribe, () => select(memory.get(key)));
}
