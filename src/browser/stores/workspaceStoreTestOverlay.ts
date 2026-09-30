import type { WorkspaceStore } from "@/browser/stores/WorkspaceStore";

/**
 * Overlay fake members on a real WorkspaceStore instance without destroying the rest of its
 * surface.
 *
 * Why this exists: Bun's mock.module() is process-wide, and a test file's static import
 * bindings freeze when that file evaluates — bun evaluates every test file in a run before
 * executing tests, so a file-scope store mock is visible to every later-evaluated file and
 * cannot be healed afterwards (re-mocking does not update already-frozen bindings). A fake
 * that exposes only the members one suite needs therefore breaks unrelated suites in the
 * same bun process (e.g. a missing setNavigateToWorkspace aborts another file's cleanup,
 * leaking happy-dom globals and cascading into timeouts). WorkspaceStore is a class, so
 * object spreads drop its prototype methods — delegate through a Proxy instead, binding
 * real methods to the real instance so #private fields keep working.
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
