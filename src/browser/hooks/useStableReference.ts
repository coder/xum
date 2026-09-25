import { useRef, useMemo, type DependencyList } from "react";

/**
 * Compare two Maps for deep equality (same keys and values).
 * Uses === for value comparison by default.
 *
 * @param prev Previous Map
 * @param next Next Map
 * @param valueEquals Optional custom value equality function
 * @returns true if Maps are equal, false otherwise
 */
export function compareMaps<K, V>(
  prev: Map<K, V>,
  next: Map<K, V>,
  valueEquals: (a: V, b: V) => boolean = (a, b) => a === b
): boolean {
  if (prev.size !== next.size) return false;

  for (const [key, value] of next) {
    if (!prev.has(key)) return false;
    if (!valueEquals(prev.get(key)!, value)) return false;
  }

  return true;
}

/**
 * Hook to stabilize reference identity for computed values.
 *
 * Returns the previous reference if the new value is deeply equal to the previous value,
 * preventing unnecessary re-renders in components that depend on reference equality.
 *
 * Common use case: Stabilizing Map identities in useMemo when the
 * underlying values haven't actually changed.
 *
 * @example
 * ```typescript
 * // Stabilize a Map<string, boolean>
 * const unreadStatus = useStableReference(
 *   () => {
 *     const map = new Map<string, boolean>();
 *     for (const [id, state] of workspaceStates) {
 *       map.set(id, calculateUnread(state));
 *     }
 *     return map;
 *   },
 *   compareMaps,
 *   [workspaceStates]
 * );
 * ```
 *
 * @param factory Function that creates the new value
 * @param comparator Function to check equality between prev and next values
 * @param deps Dependency list for useMemo
 * @returns Stable reference to the value
 */
export function useStableReference<T>(
  factory: () => T,
  comparator: (prev: T, next: T) => boolean,
  deps: DependencyList
): T {
  const ref = useRef<T | undefined>(undefined);

  return useMemo(() => {
    const next = factory();

    // First render or no previous value
    if (ref.current === undefined) {
      ref.current = next;
      return next;
    }

    // Compare with previous value
    if (comparator(ref.current, next)) {
      return ref.current; // Maintain identity
    }

    // Value changed, update ref and return new value
    ref.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
