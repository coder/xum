// Runtime harness for scripts/check-startup-imports-runtime.ts (#4423). Plain Node
// CommonJS so it loads the build output exactly like Electron's main process would,
// minus Electron itself.
//
// Usage: node scripts/check-startup-imports-runtime.cjs <absolute target.js> <absolute out.json>
//
// Writes { error, modules } to out.json: `error` is the load error's stack (or null),
// `modules` is every file in require.cache once module-scope work has run.
"use strict";

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const [target, out] = process.argv.slice(2);
if (target == null || out == null || !path.isAbsolute(target) || !path.isAbsolute(out)) {
  console.error(
    "usage: node check-startup-imports-runtime.cjs <absolute target.js> <absolute out.json>"
  );
  process.exit(2);
}

// `electron` stand-in: every property read returns another stub, and calling or
// constructing one returns another stub, so top-level Electron calls do not throw.
// `then` is a function that never calls its callbacks, which makes every Electron
// promise (e.g. `app.whenReady()`) never settle: nothing after the app is ready runs,
// which is exactly the pre-splash module set this check is about.
function stub() {
  return new Proxy(function electronStub() {}, {
    get(_target, prop) {
      if (prop === "then") return () => stub();
      if (prop === Symbol.toPrimitive) return () => "";
      return stub();
    },
    apply: () => stub(),
    construct: () => stub(),
  });
}

const electron = stub();
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electron;
  return originalLoad.call(this, request, ...rest);
};

let error = null;
try {
  require(target);
} catch (err) {
  error = String((err && err.stack) || err);
}

// tsc emits a module-scope `import()` as `Promise.resolve().then(() => require(...))`.
// Those microtasks run before the next macrotask, so wait one setImmediate for them.
setImmediate(() => {
  fs.writeFileSync(out, JSON.stringify({ error, modules: Object.keys(require.cache) }));
  // main.js may keep handles (timers, sockets) open; the snapshot is all we need.
  process.exit(0);
});
