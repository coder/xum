import assert from "node:assert";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { validateStaticTree, type StaticNode } from "@/common/staticWorkspaceView/tree";
import { log } from "@/node/services/log";

/**
 * The main-thread side of the static view row-tree worker (staticRowTree.worker.ts). Only `xum
 * server` creates one: the worker costs about 170 MB while it lives. It never throws and never
 * waits for the cold load: every miss gives null rows, so the static view falls back to the live
 * one and the tail read stays fast.
 */
export interface RowTreeClient {
  /** One tree per row, or null. `tailKey` identifies the tail (last historySequence + row count). */
  render(
    workspaceId: string,
    tailKey: string,
    rows: RowTreeRow[]
  ): Promise<Array<StaticNode | null>>;
  dispose(): void;
}
export interface RowTreeRow {
  text: string;
  isUser: boolean;
}

export const ROW_TREE_LIMITS = {
  /** Per batch of at most `maxRows`, timed from the worker's "ready", never across its cold load. */
  batchTimeoutMs: 1_000,
  loadTimeoutMs: 5_000,
  idleMs: 10 * 60_000,
  /** After this many failures in a row (crash, timeout, failed load), wait `backoffMs`. */
  maxFailures: 3,
  backoffMs: 60_000,
  maxRows: 40,
  /** A larger serialized tree (UTF-8 bytes) would bloat the page; that row gets null. */
  maxTreeBytes: 64 * 1024,
  /** The memo keeps the most recently used tails up to this many serialized bytes in total. */
  memoBytes: 8 * 1024 * 1024,
};

/**
 * The worker's source when Bun runs from src, else dist/workers: from this file's tsc output
 * (dist/node/orpc/staticWorkspaceView) or from the Docker server bundle (dist/runtime).
 */
export function defaultRowTreeWorkerPath(): string {
  if (path.extname(__filename) === ".ts") {
    return path.join(__dirname, "../../../browser/workers/staticRowTree.worker.ts");
  }
  const candidates = ["../../../workers", "../workers"].map((dir) =>
    path.join(__dirname, dir, "staticRowTree.worker.js")
  );
  return candidates.find((file) => existsSync(file)) ?? candidates[0];
}

interface Batch {
  workspaceId: string;
  cacheKey: string;
  rows: RowTreeRow[];
  resolve: (trees: Array<StaticNode | null>) => void;
}
interface MemoEntry {
  trees: Array<StaticNode | null>;
  bytes: number;
}

const nulls = (rows: RowTreeRow[]) => rows.map((): StaticNode | null => null);

const treeBytes = (tree: StaticNode | null) => Buffer.byteLength(JSON.stringify(tree));

export function createRowTreeClient(options: {
  workerPath: string;
  limits?: Partial<typeof ROW_TREE_LIMITS>;
}): RowTreeClient {
  return new WorkerRowTreeClient(options.workerPath, { ...ROW_TREE_LIMITS, ...options.limits });
}

class WorkerRowTreeClient implements RowTreeClient {
  private readonly memo = new Map<string, MemoEntry>();
  private memoBytes = 0;
  private worker: Worker | null = null;
  private ready = false;
  private failures = 0;
  private backoffUntil = 0;
  private nextId = 0;
  private loadTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  // The worker renders one batch at a time, so one is posted at a time and its timer starts when
  // it is posted. Queued batches wait in arrival order, at most one (the newest) per workspace.
  private inFlight: { id: number; batch: Batch; timer: NodeJS.Timeout } | null = null;
  private readonly queue = new Map<string, Batch>();

  constructor(
    private readonly workerPath: string,
    private readonly limits: typeof ROW_TREE_LIMITS
  ) {}

  render(workspaceId: string, tailKey: string, rows: RowTreeRow[]) {
    const cacheKey = `${workspaceId}\0${tailKey}`;
    const cached = this.memo.get(cacheKey);
    if (cached) {
      this.memo.delete(cacheKey); // re-inserting moves a hit to the newest end (LRU)
      this.memo.set(cacheKey, cached);
      return Promise.resolve(cached.trees);
    }
    if (rows.length === 0 || rows.length > this.limits.maxRows) return Promise.resolve(nulls(rows));
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(null), this.limits.idleMs);
    this.idleTimer.unref();
    if (!this.worker && Date.now() >= this.backoffUntil) this.start();
    if (!this.ready) return Promise.resolve(nulls(rows)); // the cold load never delays a read
    return new Promise<Array<StaticNode | null>>((resolve) =>
      this.enqueue({ workspaceId, cacheKey, rows, resolve })
    );
  }

  dispose() {
    this.stop(null);
  }

  private start() {
    let worker: Worker;
    try {
      worker = new Worker(this.workerPath);
    } catch (error) {
      // Thread creation can fail synchronously (no memory for a thread): a miss, not a throw.
      return this.stop(`start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.worker = worker;
    worker.unref(); // never keeps the server process alive
    // Events of a worker this client already stopped or replaced are stale.
    const current = () => this.worker === worker;
    worker.on("message", (message: "ready" | { id: number; trees: unknown[] }) => {
      if (!current()) return;
      if (message !== "ready") return this.onReply(message.id, message.trees);
      clearTimeout(this.loadTimer);
      this.ready = true;
    });
    worker.on("error", (error: Error) => current() && this.stop(`error: ${error.message}`));
    worker.on("exit", (code: number) => current() && this.stop(`exit ${code}`));
    this.loadTimer = setTimeout(() => this.stop("load timeout"), this.limits.loadTimeoutMs);
  }

  private stop(reason: string | null) {
    clearTimeout(this.loadTimer);
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight.batch.resolve(nulls(this.inFlight.batch.rows));
      this.inFlight = null;
    }
    for (const batch of this.queue.values()) batch.resolve(nulls(batch.rows));
    this.queue.clear();
    worker?.terminate().catch(() => undefined);
    if (reason === null) return; // the idle stop is not a failure
    log.warn(`Static view row-tree worker stopped: ${reason}`);
    this.failures++;
    if (this.failures >= this.limits.maxFailures) {
      this.backoffUntil = Date.now() + this.limits.backoffMs;
    }
  }

  private enqueue(batch: Batch) {
    const older = this.queue.get(batch.workspaceId);
    older?.resolve(nulls(older.rows)); // a burst of page loads keeps only the newest request
    this.queue.delete(batch.workspaceId);
    this.queue.set(batch.workspaceId, batch);
    this.sendNext();
  }

  private sendNext() {
    const next = this.queue.values().next();
    if (this.inFlight || next.done) return;
    assert(this.worker && this.ready, "row-tree batches go only to a ready worker");
    const batch = next.value;
    this.queue.delete(batch.workspaceId);
    const id = this.nextId++;
    const timer = setTimeout(() => this.stop("batch timeout"), this.limits.batchTimeoutMs);
    this.inFlight = { id, batch, timer };
    this.worker.postMessage({ id, rows: batch.rows });
  }

  /** A tree the page may draw: allowed nodes only, and at most `maxTreeBytes`. */
  private accept(tree: unknown): StaticNode | null {
    const valid = validateStaticTree(tree);
    return valid !== null && treeBytes(valid) <= this.limits.maxTreeBytes ? valid : null;
  }

  private remember(cacheKey: string, trees: Array<StaticNode | null>) {
    const bytes = cacheKey.length + trees.reduce((sum, tree) => sum + treeBytes(tree), 0);
    this.memo.set(cacheKey, { trees, bytes });
    this.memoBytes += bytes;
    for (const [key, entry] of this.memo) {
      if (this.memoBytes <= this.limits.memoBytes) break;
      this.memo.delete(key); // the least recently used first
      this.memoBytes -= entry.bytes;
    }
  }

  private onReply(id: number, trees: unknown[]) {
    if (this.inFlight?.id !== id) return;
    const { batch, timer } = this.inFlight;
    clearTimeout(timer);
    this.inFlight = null;
    this.failures = 0; // a crash loop on one row still backs off: only a reply resets the count
    const accepted = batch.rows.map((_, i) => this.accept(trees[i]));
    if (!this.memo.has(batch.cacheKey)) this.remember(batch.cacheKey, accepted);
    batch.resolve(accepted);
    this.sendNext();
  }
}
