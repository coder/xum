import assert from "node:assert";
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
  /** A larger serialized tree would bloat the page; that row gets null. */
  maxTreeBytes: 64 * 1024,
  memoEntries: 64,
};

/** The worker next to this file's build output, or its source when Bun runs from src. */
export function defaultRowTreeWorkerPath(): string {
  const fromSource = path.extname(__filename) === ".ts";
  return fromSource
    ? path.join(__dirname, "../../../browser/workers/staticRowTree.worker.ts")
    : path.join(__dirname, "../../../workers/staticRowTree.worker.js");
}

interface Batch {
  workspaceId: string;
  cacheKey: string;
  rows: RowTreeRow[];
  resolve: (trees: Array<StaticNode | null>) => void;
}

const nulls = (rows: RowTreeRow[]) => rows.map((): StaticNode | null => null);

/** A tree the page may draw: allowed nodes only, and small. */
function acceptTree(tree: unknown): StaticNode | null {
  const valid = validateStaticTree(tree);
  return valid !== null && JSON.stringify(valid).length <= ROW_TREE_LIMITS.maxTreeBytes
    ? valid
    : null;
}

export function createRowTreeClient(options: {
  workerPath: string;
  limits?: Partial<typeof ROW_TREE_LIMITS>;
}): RowTreeClient {
  return new WorkerRowTreeClient(options.workerPath, { ...ROW_TREE_LIMITS, ...options.limits });
}

class WorkerRowTreeClient implements RowTreeClient {
  private readonly memo = new Map<string, Array<StaticNode | null>>();
  private worker: Worker | null = null;
  private ready = false;
  private failures = 0;
  private backoffUntil = 0;
  private nextId = 0;
  private loadTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  // At most one batch per workspace in the worker, and the newest request waiting behind it.
  private readonly inFlight = new Map<number, { batch: Batch; timer: NodeJS.Timeout }>();
  private readonly waiting = new Map<string, Batch>();

  constructor(
    private readonly workerPath: string,
    private readonly limits: typeof ROW_TREE_LIMITS
  ) {}

  render(workspaceId: string, tailKey: string, rows: RowTreeRow[]) {
    const cacheKey = `${workspaceId}\0${tailKey}`;
    const cached = this.memo.get(cacheKey);
    if (cached) return Promise.resolve(cached);
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
    const worker = new Worker(this.workerPath);
    this.worker = worker;
    worker.unref(); // never keeps the server process alive
    worker.on("message", (message: "ready" | { id: number; trees: unknown[] }) => {
      if (message !== "ready") return this.onReply(message.id, message.trees);
      clearTimeout(this.loadTimer);
      this.ready = true;
    });
    worker.on("error", (error: Error) => this.stopWorker(worker, `error: ${error.message}`));
    worker.on("exit", (code: number) => this.stopWorker(worker, `exit ${code}`));
    this.loadTimer = setTimeout(() => this.stop("load timeout"), this.limits.loadTimeoutMs);
  }

  /** Events of a worker this client already replaced are stale. */
  private stopWorker(worker: Worker, reason: string) {
    if (this.worker === worker) this.stop(reason);
  }

  private stop(reason: string | null) {
    clearTimeout(this.loadTimer);
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    for (const { batch, timer } of this.inFlight.values()) {
      clearTimeout(timer);
      batch.resolve(nulls(batch.rows));
    }
    for (const batch of this.waiting.values()) batch.resolve(nulls(batch.rows));
    this.inFlight.clear();
    this.waiting.clear();
    worker?.terminate().catch(() => undefined);
    if (reason === null) return; // the idle stop is not a failure
    log.warn(`Static view row-tree worker stopped: ${reason}`);
    this.failures++;
    if (this.failures >= this.limits.maxFailures) {
      this.backoffUntil = Date.now() + this.limits.backoffMs;
    }
  }

  private enqueue(batch: Batch) {
    const busy = [...this.inFlight.values()].some((e) => e.batch.workspaceId === batch.workspaceId);
    if (!busy) return this.send(batch);
    const older = this.waiting.get(batch.workspaceId);
    older?.resolve(nulls(older.rows)); // a burst of page loads keeps only the newest request
    this.waiting.set(batch.workspaceId, batch);
  }

  private send(batch: Batch) {
    assert(this.worker && this.ready, "row-tree batches go only to a ready worker");
    const id = this.nextId++;
    const timer = setTimeout(() => this.stop("batch timeout"), this.limits.batchTimeoutMs);
    this.inFlight.set(id, { batch, timer });
    this.worker.postMessage({ id, rows: batch.rows });
  }

  private onReply(id: number, trees: unknown[]) {
    const entry = this.inFlight.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.inFlight.delete(id);
    this.failures = 0; // a crash loop on one row still backs off: only a reply resets the count
    const accepted = entry.batch.rows.map((_, i) => acceptTree(trees[i]));
    this.memo.delete(entry.batch.cacheKey); // re-inserting moves the key to the newest end
    this.memo.set(entry.batch.cacheKey, accepted);
    const oldest = this.memo.keys().next();
    if (this.memo.size > this.limits.memoEntries && !oldest.done) this.memo.delete(oldest.value);
    entry.batch.resolve(accepted);
    const next = this.waiting.get(entry.batch.workspaceId);
    this.waiting.delete(entry.batch.workspaceId);
    if (next) this.send(next);
  }
}
