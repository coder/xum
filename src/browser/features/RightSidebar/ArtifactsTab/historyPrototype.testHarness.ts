import { afterEach } from "bun:test";
import { History } from "happy-dom";

/**
 * Happy DOM shares one History class between windows (BrowserWindow.js: `History = History`), and
 * the frame script wraps History.prototype.pushState and replaceState. Without a restore, the
 * wrapper of a closed window stays in the bun process and rewrites a "#x" URL in later tests,
 * including those of other files. Call this at the top of a test file that runs the frame script:
 * it puts the original methods back after each test.
 */
export function restoreHistoryPrototypeAfterEach(): void {
  const originals = ["pushState", "replaceState"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(History.prototype, name)] as const
  );
  afterEach(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(History.prototype, name, descriptor);
    }
  });
}
