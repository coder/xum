import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { assert } from "@/common/utils/assert";

/**
 * The slice of the API client the cache needs: one bulk `mcp.icons` call
 * answering (PNG data URL or null) per requested ref. The client object's
 * identity is also the lookup generation: a reconnected client is a new owner.
 */
export interface McpIconClient {
  mcp: {
    icons: (input: { iconRefs: string[] }) => Promise<Record<string, string | null>>;
  };
}

interface Pending {
  state: "pending";
  /** Client the lookup travels through; a replacement client issues its own. */
  owner: McpIconClient;
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
  reject: (error: Error) => void;
}
type Entry = Pending | { state: "resolved"; value: string | null };

interface Batch {
  owner: McpIconClient;
  refs: Map<string, Pending>;
  /** A full batch flushes early; the microtask scheduled at creation must not send it twice. */
  flushed: boolean;
}

/**
 * Renderer-session memo for `mcp.icons` lookups keyed by immutable iconRef.
 * Distinct misses raised in one tick travel in one bulk IPC call (bounded to
 * the capacity per call); rows sharing a ref coalesce on one pending entry.
 * One bounded LRU map holds pending and resolved entries alike: resolved
 * values (including null for refs the host no longer knows) are immutable and
 * belong to no client, rejected requests are dropped so a later mount retries,
 * and pending entries belong to the API client they were issued through — a
 * replacement client issues its own lookup, and a superseded or evicted
 * request's late outcome can neither reinsert, overwrite nor delete whatever
 * entry the ref has by then.
 */
export class McpIconRefCache {
  private readonly entries = new Map<string, Entry>();
  private batch: Batch | null = null;

  constructor(private readonly capacity: number) {
    assert(Number.isInteger(capacity) && capacity > 0, "icon cache capacity must be positive");
  }

  /** Number of pending + resolved entries (test seam for the bound). */
  get size(): number {
    return this.entries.size;
  }

  /** Cached answer without touching recency (safe to call while rendering). */
  peek(iconRef: string): string | null | undefined {
    const entry = this.entries.get(iconRef);
    return entry?.state === "resolved" ? entry.value : undefined;
  }

  resolve(iconRef: string, owner: McpIconClient): Promise<string | null> {
    const existing = this.entries.get(iconRef);
    if (
      existing?.state === "resolved" ||
      (existing?.state === "pending" && existing.owner === owner)
    ) {
      // Refresh recency on hit.
      this.entries.delete(iconRef);
      this.entries.set(iconRef, existing);
      return existing.state === "resolved" ? Promise.resolve(existing.value) : existing.promise;
    }
    // Miss, or a pending lookup owned by a replaced client: this client asks itself.
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    const promise = new Promise<string | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: Pending = { state: "pending", owner, promise, resolve, reject };
    this.entries.delete(iconRef);
    this.entries.set(iconRef, pending);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.enqueue(iconRef, pending);
    return promise;
  }

  private enqueue(iconRef: string, pending: Pending): void {
    // A batch belongs to one client and never exceeds the capacity per call;
    // it flushes on the next microtask so one render pass yields one IPC call.
    if (
      this.batch &&
      (this.batch.owner !== pending.owner || this.batch.refs.size >= this.capacity)
    ) {
      this.flush(this.batch);
    }
    if (!this.batch) {
      const batch: Batch = { owner: pending.owner, refs: new Map(), flushed: false };
      this.batch = batch;
      queueMicrotask(() => this.flush(batch));
    }
    this.batch.refs.set(iconRef, pending);
  }

  private flush(batch: Batch): void {
    if (this.batch === batch) this.batch = null;
    if (batch.flushed) return;
    batch.flushed = true;
    const iconRefs = [...batch.refs.keys()];
    // new Promise(resolve => resolve(call())) turns a synchronous throw (e.g.
    // an API surface without mcp.icons) into an ordinary rejection.
    new Promise<Record<string, string | null>>((resolve) =>
      resolve(batch.owner.mcp.icons({ iconRefs }))
    ).then(
      (icons) => {
        for (const [iconRef, pending] of batch.refs) {
          const value = icons[iconRef] ?? null;
          // Only the request this ref still owns may write; an evicted or
          // superseded request still answers its callers.
          if (this.entries.get(iconRef) === pending) {
            this.entries.set(iconRef, { state: "resolved", value });
          }
          pending.resolve(value);
        }
      },
      (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        for (const [iconRef, pending] of batch.refs) {
          if (this.entries.get(iconRef) === pending) this.entries.delete(iconRef);
          pending.reject(error);
        }
      }
    );
  }
}

export const mcpIconRefCache = new McpIconRefCache(MCP_ICON_LIMITS.registryMaxEntries);
