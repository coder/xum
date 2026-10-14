// Starts a built analytics worker and runs its "init" task, which opens a DuckDB
// database through the native @duckdb bindings. The Docker smoke test runs this inside
// the server image (#5603): /health passes even when the image lacks the worker bundle
// or its native module, because AnalyticsService starts the worker lazily.
//
// Usage: node scripts/check-analytics-worker.cjs <absolute analyticsWorker.js>
// Also works from stdin: docker exec -i <container> node - <path> < check-analytics-worker.cjs
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const TIMEOUT_MS = 60_000;
const INIT_MESSAGE_ID = 1;

const workerPath = process.argv[2];
if (workerPath == null || !path.isAbsolute(workerPath)) {
  console.error("usage: node check-analytics-worker.cjs <absolute analyticsWorker.js>");
  process.exit(2);
}

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-worker-check-"));
let initialized = false;

function finish(code, message) {
  fs.rmSync(dbDir, { recursive: true, force: true });
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}

const timer = setTimeout(
  () => finish(1, `analytics worker did not answer init within ${TIMEOUT_MS} ms`),
  TIMEOUT_MS
);

const worker = new Worker(workerPath);
worker.on("error", (error) => finish(1, `analytics worker error: ${error.message}`));
worker.on("exit", (code) => {
  clearTimeout(timer);
  if (!initialized) {
    finish(1, `analytics worker exited with code ${code} before init completed`);
  }
  if (code !== 0) {
    finish(1, `analytics worker shutdown exited with code ${code}`);
  }
  finish(0, `analytics worker OK: ${workerPath}`);
});
worker.on("message", (response) => {
  if (response?.messageId !== INIT_MESSAGE_ID) {
    return;
  }
  if (response.error != null) {
    finish(1, `analytics worker init failed: ${response.error.message}`);
  }
  initialized = true;
  // Graceful shutdown closes DuckDB, then the worker exits with code 0.
  worker.postMessage({ type: "shutdown" });
});
worker.postMessage({
  messageId: INIT_MESSAGE_ID,
  taskName: "init",
  data: { dbPath: path.join(dbDir, "analytics.db") },
});
