import type { WorkspaceStore } from "@/browser/stores/WorkspaceStore";

/**
 * Overlay fake members on a real WorkspaceStore instance without destroying the rest of its
 * surface.
 *
 * Why this exists: Bun's mock.module() is process-wide and stays in place after the test
 * file that called it finishes, until a later mock.module() call replaces it. (Bun runs test
 * files one at a time: it evaluates a file, runs its tests, then moves to the next file.)
 * Until then, every caller of the mocked store gets the fake, including cleanup code and
 * later test files. A fake that exposes only the members one suite needs therefore breaks
 * unrelated suites in the same bun process (e.g. a missing setNavigateToWorkspace aborts
 * another file's cleanup, leaking happy-dom globals and cascading into timeouts).
 * WorkspaceStore is a class, so object spreads drop its prototype methods — delegate
 * through a Proxy instead, binding real methods to the real instance so #private fields
 * keep working.
 */
export function overlayWorkspaceStoreRaw<T extends object>(
  real: WorkspaceStore,
  overrides: T
): WorkspaceStore {
  return new Proxy(real, {
    get(target, prop) {
      if (Reflect.has(overrides, prop)) {
        return Reflect.get(overrides, prop);
      }
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target) as unknown;
      }
      return value;
    },
  });
}
