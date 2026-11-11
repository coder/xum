import path from "node:path";
import { expect, test } from "bun:test";
import { loadReactCompiledModule } from "../../tests/ui/reactCompiledModule";

// Babel's first transform wraps Error.prepareStackTrace and raises Error.stackTraceLimit, both
// process-wide. Bun's own prepareStackTrace refuses a non-Error first argument, so once Babel has
// wrapped it, `Error.captureStackTrace({})` throws "First argument must be an Error object". The
// unit lane shares one process per shard, and undici's fetch() calls exactly that on every
// rejection: a later file then saw that TypeError, with no cause, instead of its own rejection
// (brotliResponseGuard.test.ts, once WorkspaceShell.test.tsx ran before it in the shard).
test("compiling a module through React Compiler leaves the stack trace hooks as they were", () => {
  const before = { prepare: Error.prepareStackTrace, limit: Error.stackTraceLimit };

  loadReactCompiledModule(path.join(import.meta.dir, "../constants/layout.ts"));

  expect(() => Error.captureStackTrace({})).not.toThrow();
  expect(Error.prepareStackTrace).toBe(before.prepare);
  expect(Error.stackTraceLimit).toBe(before.limit);
});
