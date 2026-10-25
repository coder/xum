import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { join, dirname, sep, extname } from "node:path";
import { log } from "@/node/services/log";
import type { EncodingName, TokenizerWorkerData } from "./tokenizer.worker";

interface WorkerRequest {
  messageId: number;
  taskName: string;
  data: unknown;
}

interface WorkerSuccessResponse {
  messageId: number;
  result: unknown;
}

interface WorkerErrorResponse {
  messageId: number;
  error: {
    message: string;
    stack?: string;
  };
}

type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface EncodingWorker {
  worker: Worker;
  pending: Map<number, PendingRequest>;
  // Set once the worker dies (e.g., failed to load); later calls reject immediately.
  error: Error | null;
}

let messageIdCounter = 0;

// Resolve worker path
// In production: both workerPool.js and tokenizer.worker.js are in dist/utils/main/
// During tests: workerPool.ts is in src/utils/main/ but worker is in dist/utils/main/
const currentDir = dirname(__filename);
const pathParts = currentDir.split(sep);
const hasDist = pathParts.includes("dist");
const srcIndex = pathParts.lastIndexOf("src");

let workerDir: string;
let workerFile = "tokenizer.worker.js";

// Check if we're running under Bun (not Node with ts-jest)
// ts-jest transpiles .ts files but runs them via Node, which can't load .ts workers
// eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
const isBun = !!(process as unknown as { isBun?: boolean }).isBun;

if (isBun && extname(__filename) === ".ts") {
  // Running from source via Bun - use .ts worker directly
  workerDir = currentDir;
  workerFile = "tokenizer.worker.ts";
} else if (srcIndex !== -1 && !hasDist) {
  // Replace 'src' with 'dist' in the path (only if not already in dist)
  pathParts[srcIndex] = "dist";
  workerDir = pathParts.join(sep);
} else {
  workerDir = currentDir;
}

const workerPath = join(workerDir, workerFile);

// One worker per encoding, spawned on first use: loading an encoding is seconds of synchronous CPU
// (o200k_base ~10 s), so a shared worker would block every other encoding's counts behind it (#4816).
const encodingWorkers = new Map<EncodingName, EncodingWorker>();

function spawnWorker(encoding: EncodingName): EncodingWorker {
  assert(!encodingWorkers.has(encoding), `Tokenizer worker for '${encoding}' already exists`);
  const workerData: TokenizerWorkerData = { encoding };
  const entry: EncodingWorker = {
    worker: new Worker(workerPath, { workerData }),
    pending: new Map(),
    error: null,
  };
  encodingWorkers.set(encoding, entry);

  const failAll = (error: Error) => {
    entry.error = error;
    for (const pending of entry.pending.values()) {
      pending.reject(error);
    }
    entry.pending.clear();
  };

  // Handle messages from worker
  entry.worker.on("message", (response: WorkerResponse) => {
    const pending = entry.pending.get(response.messageId);
    if (!pending) {
      log.error(`No pending promise for messageId ${response.messageId}`);
      return;
    }

    entry.pending.delete(response.messageId);

    if ("error" in response) {
      const error = new Error(response.error.message);
      error.stack = response.error.stack;
      pending.reject(error);
    } else {
      pending.resolve(response.result);
    }
  });

  // Handle worker errors
  entry.worker.on("error", (error: Error) => {
    log.error(`Tokenizer worker (${encoding}) error:`, error);
    failAll(error);
  });

  // Handle worker exit
  entry.worker.on("exit", (code) => {
    if (code !== 0) {
      log.error(`Tokenizer worker (${encoding}) stopped with exit code ${code}`);
      failAll(new Error(`Worker stopped with exit code ${code}`));
    }
  });

  // Don't block process exit
  entry.worker.unref();
  return entry;
}

/**
 * Run a task on the worker thread that serves `encoding`, spawning it on first use.
 * Spawning is synchronous here, so concurrent calls can never create two workers for one encoding.
 * @param encoding The encoding whose worker should run the task
 * @param taskName The name of the task to run (e.g., "countTokensBatch", "ready")
 * @param data The data to pass to the task
 * @returns A promise that resolves with the task result
 */
export function run<T>(encoding: EncodingName, taskName: string, data: unknown): Promise<T> {
  const entry = encodingWorkers.get(encoding) ?? spawnWorker(encoding);

  // If worker already died (e.g., failed to load), reject immediately
  // This prevents hanging promises when the worker is not available
  if (entry.error) {
    return Promise.reject(entry.error);
  }

  const messageId = messageIdCounter++;
  const request: WorkerRequest = { messageId, taskName, data };

  return new Promise<T>((resolve, reject) => {
    entry.pending.set(messageId, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    entry.worker.postMessage(request);
  });
}
