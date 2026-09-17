import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";

type IconLookup = (iconRef: string) => Promise<string | null>;

/**
 * Renderer-session memo for `mcp.icon` lookups keyed by immutable iconRef:
 * one in-flight request per ref, resolved values (including null for refs the
 * host no longer knows) kept in a bounded LRU, rejected requests never stored
 * so a later mount retries. Refs are immutable, so a cached answer never
 * needs invalidation; eviction only bounds memory.
 */
export class McpIconRefCache {
  private readonly resolved = new Map<string, string | null>();
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(private readonly capacity: number) {}

  /** Cached answer without touching recency (safe to call while rendering). */
  peek(iconRef: string): string | null | undefined {
    return this.resolved.get(iconRef);
  }

  resolve(iconRef: string, lookup: IconLookup): Promise<string | null> {
    const cached = this.resolved.get(iconRef);
    if (cached !== undefined) {
      // Refresh recency on hit.
      this.resolved.delete(iconRef);
      this.resolved.set(iconRef, cached);
      return Promise.resolve(cached);
    }
    const pending = this.inflight.get(iconRef);
    if (pending) return pending;
    // new Promise(resolve => resolve(lookup(...))) turns a synchronous throw
    // (e.g. an API surface without mcp.icon) into an ordinary rejection.
    const request: Promise<string | null> = new Promise<string | null>((resolve) =>
      resolve(lookup(iconRef))
    ).then(
      (icon) => {
        // Only the request still registered for this ref may write; a
        // superseded completion (after reset) must not resurrect an entry.
        if (this.inflight.get(iconRef) === request) {
          this.inflight.delete(iconRef);
          this.resolved.set(iconRef, icon);
          while (this.resolved.size > this.capacity) {
            const oldest = this.resolved.keys().next().value;
            if (oldest === undefined) break;
            this.resolved.delete(oldest);
          }
        }
        return icon;
      },
      (error: unknown) => {
        if (this.inflight.get(iconRef) === request) this.inflight.delete(iconRef);
        throw error;
      }
    );
    this.inflight.set(iconRef, request);
    return request;
  }

  /** Forget everything; completions of older requests are ignored afterwards. */
  reset(): void {
    this.resolved.clear();
    this.inflight.clear();
  }
}

export const mcpIconRefCache = new McpIconRefCache(MCP_ICON_LIMITS.registryMaxEntries);
