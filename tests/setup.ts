/**
 * Jest setup file to ensure Symbol.dispose is available in test environment.
 * Required for explicit resource management (using declarations) to work.
 */

import assert from "assert";
import "disposablestack/auto";
import { resolveXumEnvironmentValue } from "../src/common/compat/xumEnv";

assert.equal(typeof Symbol.dispose, "symbol");
// Use fast approximate token counting in Jest to avoid 10s WASM cold starts
// Individual tests can override with XUM_FORCE_REAL_TOKENIZER=1

// Many renderer components gate test-only behavior on `import.meta.env.MODE === "test"`.
// In Jest, `import.meta.env` is rewritten to `process.env` by our Babel plugin.
process.env.MODE ??= "test";
if (resolveXumEnvironmentValue("FORCE_REAL_TOKENIZER", process.env) !== "1") {
  process.env.XUM_APPROX_TOKENIZER ??= process.env.MUX_APPROX_TOKENIZER ?? "1";
}

// Some deps (e.g. json-schema-ref-parser) treat `window` existence as "browser"
// and then read from the global `location` object. Some Happy DOM-based tests
// attach `globalThis.window` without defining global `location`, which can crash
// code paths that only check `typeof window !== "undefined"`.
if (!Object.getOwnPropertyDescriptor(globalThis, "location")) {
  let fallbackLocation: { href: string } | undefined = { href: "file:///" };
  // A test-installed window whose `location` resolves back to the global one re-enters
  // this getter forever. CI hit "Maximum call stack size exceeded" here, which aborted
  // WorkspaceContext's module evaluation and left every later importer in the same bun
  // process failing with "Cannot access 'WorkspaceMetadataContext' before initialization".
  let resolvingLocation = false;

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    get() {
      if (resolvingLocation) {
        return fallbackLocation;
      }
      resolvingLocation = true;
      try {
        // Typed loosely because tests install partial window stubs (or none at all).
        const win: { location?: unknown; window?: { location?: unknown } } | undefined =
          globalThis.window;
        return win?.location ?? win?.window?.location ?? fallbackLocation;
      } finally {
        resolvingLocation = false;
      }
    },
    set(value: { href: string } | undefined) {
      fallbackLocation = value;
    },
  });
}
assert.equal(typeof Symbol.asyncDispose, "symbol");

// Polyfill File for undici in jest environment
// undici expects File to be available globally but jest doesn't provide it
if (typeof globalThis.File === "undefined") {
  (globalThis as { File?: unknown }).File = class File extends Blob {
    constructor(bits: BlobPart[], name: string, options?: FilePropertyBag) {
      super(bits, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
    name: string;
    lastModified: number;
  };
}

// Preload tokenizer and AI SDK modules for integration tests
// This eliminates ~10s initialization delay on first use
if (process.env.TEST_INTEGRATION === "1") {
  const preloadGlobal = globalThis as { __muxPreloadPromise?: Promise<void> };
  // Store promise globally to ensure it blocks subsequent test execution
  preloadGlobal.__muxPreloadPromise = (async () => {
    const { preloadTestModules } = await import("./ipc/setup");
    await preloadTestModules();
  })();

  // Add a global beforeAll to block until preload completes
  beforeAll(async () => {
    await preloadGlobal.__muxPreloadPromise;
  }, 30000); // 30s timeout for preload
}
