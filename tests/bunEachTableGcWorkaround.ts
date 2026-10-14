/**
 * Temporary workaround for a Bun 1.3.12 test-runner bug. Remove it with the Bun bump that
 * #4958 tracks (Bun 1.3.14 fixed this bug upstream).
 *
 * Bun 1.3.12 can garbage-collect the table passed to `.each(table)` before the returned
 * function registers the tests. The callbacks then receive freed rows: objects that lost
 * their properties, `[native code]` in a diff, or a segfault (#6020). This file does not
 * touch the AbortSignal.timeout regression that keeps the repo on 1.3.12 (#4958).
 *
 * A bunfig preload (not tests/setup.ts): Jest also runs tests/setup.ts and has no bun:test.
 */
import assert from "node:assert";
import { describe, it, test } from "bun:test";

/** Only the version the bug was verified on: Bun 1.3.14 and 1.4.3 hold the table themselves. */
const AFFECTED_BUN_VERSION = "1.3.12";

if (Bun.version === AFFECTED_BUN_VERSION) {
  // Every registrar (test, it, describe and their .only/.skip/.skipIf(...)/... forms) shares
  // one prototype that owns `each`, so one wrapper covers all of them.
  const registrarPrototype = Object.getPrototypeOf(test) as { each: unknown };
  const nativeEach = registrarPrototype.each;
  assert(typeof nativeEach === "function", "bun:test registrars no longer own an `each` method");
  // Rooted for the process lifetime: freeing a table before its tests run reopens the bug.
  // A closure that captured the table did not keep it alive in the repro; this array does.
  const rootedEachTables: unknown[] = [];
  const each = function (this: unknown, ...args: unknown[]): unknown {
    rootedEachTables.push(...args);
    return Reflect.apply(nativeEach, this, args);
  };
  registrarPrototype.each = each;

  // An unexpected prototype shape must fail startup, not silently drop the protection.
  // No `.only` entries: with CI set, Bun throws on any `.only` access, so this check
  // would fail every CI run. CI tests cannot reach `.only.each` either.
  const registrars: Record<string, { each: unknown }> = {
    test,
    it,
    describe,
    "test.skip": test.skip,
    "test.todo": test.todo,
    "test.if(true)": test.if(true),
    "test.skipIf(false)": test.skipIf(false),
    "test.todoIf(false)": test.todoIf(false),
    "it.skipIf(false)": it.skipIf(false),
    "describe.skip": describe.skip,
    "describe.skipIf(false)": describe.skipIf(false),
  };
  for (const [name, registrar] of Object.entries(registrars)) {
    assert(
      registrar.each === each,
      `${name}.each bypasses the Bun ${AFFECTED_BUN_VERSION} test.each table workaround`
    );
  }
}
