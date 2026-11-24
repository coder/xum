import { afterEach } from "bun:test";
import { History } from "happy-dom";

const HISTORY_METHODS = ["pushState", "replaceState"] as const;

/**
 * The own descriptor of each History method the frame script wraps. Throws when `target` has no
 * own descriptor for one: a Happy DOM release that moves a method would leave nothing to restore,
 * and the leak that `restoreHistoryPrototypeAfterEach` stops would come back unseen.
 */
export function snapshotHistoryMethods(
  target: object = History.prototype
): ReadonlyArray<readonly [string, PropertyDescriptor]> {
  return HISTORY_METHODS.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor) {
      throw new Error(
        `Happy DOM's History.prototype has no own "${name}": update historyPrototype.testHarness.ts`
      );
    }
    return [name, descriptor] as const;
  });
}

/**
 * Happy DOM shares one History class between windows (BrowserWindow.js: `History = History`), and
 * the frame script wraps History.prototype.pushState and replaceState. Without a restore, the
 * wrapper of a closed window stays in the bun process and rewrites a "#x" URL in later tests,
 * including those of other files. Call this at the top of a test file that runs the frame script:
 * it puts the original methods back after each test.
 */
export function restoreHistoryPrototypeAfterEach(): void {
  const originals = snapshotHistoryMethods();
  afterEach(() => {
    for (const [name, descriptor] of originals) {
      Object.defineProperty(History.prototype, name, descriptor);
    }
  });
}
