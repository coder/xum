import { afterAll, mock } from "bun:test";

/**
 * bun test shares mock.module registrations across suites in the same run, so
 * a file-scope stub leaks into every later test file (a leaked closed-Dialog
 * stub renders nothing and empties later suites that mount dialog triggers).
 * Call at file scope with the captured real exports to restore them once the
 * registering suite finishes.
 */
export function restoreModulesAfterSuite(
  entries: [modulePath: string, realExports: Record<string, unknown>][]
): void {
  for (const [modulePath] of entries) {
    // Relative paths resolve against THIS file, not the caller, so the restore
    // would silently register a bogus virtual module and leave the real module
    // mocked (which poisons later suites' mock.module registrations).
    if (modulePath.startsWith(".")) {
      throw new Error(
        `restoreModulesAfterSuite: use an alias or package path instead of relative "${modulePath}"`
      );
    }
  }
  afterAll(() => {
    for (const [modulePath, exports] of entries) {
      void mock.module(modulePath, () => exports);
    }
  });
}
