import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { assert } from "@/common/utils/assert";

type IconLookup = (iconRef: string) => Promise<string | null>;

type Entry =
  | { state: "pending"; request: Promise<string | null> }
  | { state: "resolved"; value: string | null };

/**
 * Renderer-session memo for `mcp.icon` lookups keyed by immutable iconRef.
 * One bounded LRU map holds pending and resolved entries alike: one in-flight
 * request per ref, resolved values (including null for refs the host no longer
 * knows) kept, rejected requests dropped so a later mount retries. Refs are
 * immutable, so a cached answer never needs invalidation; eviction only bounds
 * memory, and a request evicted while pending may complete later without
 * touching whatever entry the ref has by then.
 */
export class McpIconRefCache {
  private readonly entries = new Map<string, Entry>();

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

  resolve(iconRef: string, lookup: IconLookup): Promise<string | null> {
    const existing = this.entries.get(iconRef);
    if (existing) {
      // Refresh recency on hit (pending or resolved).
      this.entries.delete(iconRef);
      this.entries.set(iconRef, existing);
      return existing.state === "resolved" ? Promise.resolve(existing.value) : existing.request;
    }
    // new Promise(resolve => resolve(lookup(...))) turns a synchronous throw
    // (e.g. an API surface without mcp.icon) into an ordinary rejection.
    const request: Promise<string | null> = new Promise<string | null>((resolve) =>
      resolve(lookup(iconRef))
    ).then(
      (icon) => {
        // Only the request this ref still owns may write; an evicted or
        // superseded request must neither reinsert nor overwrite.
        if (this.owns(iconRef, request)) {
          this.entries.set(iconRef, { state: "resolved", value: icon });
        }
        return icon;
      },
      (error: unknown) => {
        if (this.owns(iconRef, request)) this.entries.delete(iconRef);
        throw error;
      }
    );
    this.entries.set(iconRef, { state: "pending", request });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return request;
  }

  private owns(iconRef: string, request: Promise<string | null>): boolean {
    const entry = this.entries.get(iconRef);
    return entry?.state === "pending" && entry.request === request;
  }
}

export const mcpIconRefCache = new McpIconRefCache(MCP_ICON_LIMITS.registryMaxEntries);
