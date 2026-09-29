// Runtime harness for scripts/check-startup-imports-runtime.ts (#4423). Plain Node
// CommonJS so it loads the build output exactly like Electron's main process would,
// minus Electron itself.
//
// Usage: node scripts/check-startup-imports-runtime.cjs <absolute target.js> <absolute out.json>
// Env: STARTUP_CHECK_APP_DATA, the directory the stubbed `app.getPath()` returns paths in.
//
// Writes { error, trigger, modules } to out.json: `error` is the load error's stack (or
// null), `trigger` says what ended startup, and `modules` is every file in require.cache
// at that point.
"use strict";

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const [target, out] = process.argv.slice(2);
const appDataDir = process.env.STARTUP_CHECK_APP_DATA;
if (
  target == null ||
  out == null ||
  !path.isAbsolute(target) ||
  !path.isAbsolute(out) ||
  appDataDir == null ||
  !path.isAbsolute(appDataDir)
) {
  console.error(
    "usage: STARTUP_CHECK_APP_DATA=<absolute dir> node check-startup-imports-runtime.cjs" +
      " <absolute target.js> <absolute out.json>"
  );
  process.exit(2);
}

// Startup branches on the OS (e.g. main.ts's macOS-only PATH fix), so the driver runs
// the target once per desktop platform. Only `process.platform` changes: `path` and
// other Node internals keep the host's behavior.
const platform = process.env.STARTUP_CHECK_PLATFORM;
if (platform != null) {
  Object.defineProperty(process, "platform", { value: platform });
}

const exit = process.exit.bind(process);
let error = null;
let snapshotTaken = false;

function writeSnapshot(trigger) {
  if (snapshotTaken) return;
  snapshotTaken = true;
  fs.writeFileSync(out, JSON.stringify({ error, trigger, modules: Object.keys(require.cache) }));
}

// Startup ends at the first of these, so the snapshot includes code that runs after
// real I/O (main.ts awaits its storage setup before it waits for the ready event):
// - `app.whenReady()` is called: that is the pre-splash gate. The snapshot waits one
//   setImmediate so microtasks queued in the same tick (tsc emits a module-scope
//   `import()` as `Promise.resolve().then(() => require(...))`) have run.
// - The event loop drains without reaching it.
// Then the harness exits 0 (main.js may keep handles such as timers open). A target that
// exits on its own leaves no snapshot, which the driver reports as a failure.
process.on("beforeExit", () => {
  writeSnapshot("event loop drained");
  exit(0);
});

// `electron` stand-in: every property read returns another stub, and calling or
// constructing one returns another stub, so top-level Electron calls do not throw.
// `then` is a function that never calls its callbacks, which makes every Electron
// promise (e.g. `app.whenReady()`) never settle: nothing after the app is ready runs,
// which is exactly the pre-splash module set this check is about. `getPath()` returns
// real paths because startup code passes them to `path.join()` and the file system.
function stub() {
  return new Proxy(function electronStub() {}, {
    get(_target, prop) {
      if (prop === "then") return () => stub();
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "getPath") return (name) => path.join(appDataDir, String(name));
      if (prop === "whenReady") {
        return () => {
          setImmediate(() => {
            writeSnapshot("app.whenReady()");
            exit(0);
          });
          return stub();
        };
      }
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

try {
  require(target);
} catch (err) {
  error = String((err && err.stack) || err);
  writeSnapshot("load error");
  exit(0);
}
