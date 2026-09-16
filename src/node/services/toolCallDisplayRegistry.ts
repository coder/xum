import type { MCPToolCallDisplay } from "@/common/types/mcp";
import assert from "@/common/utils/assert";

/**
 * Identity of one stream execution: the turn that assembled a tool set and
 * will consume its tool results. Ownership in the registry is by object
 * identity — the host creates one object per stream, binds it into tool
 * execute options (`withExecutionScope`), and passes that same object to
 * `open`/`close`/`take`. A structurally equal copy is a different scope.
 */
export interface ExecutionScope {
  readonly workspaceId: string;
  /** Assistant message the stream is producing. */
  readonly messageId: string;
  /** Per-stream token (see StreamManager); distinguishes retries of one message. */
  readonly token: string;
}

/** How long an unconsumed snapshot survives; consumers normally take it within the same tool step. */
export const TOOL_CALL_DISPLAY_TTL_MS = 10 * 60 * 1000;
/** Global hard cap across all scopes; the oldest unconsumed snapshot is evicted first. */
export const TOOL_CALL_DISPLAY_MAX_ENTRIES = 1_000;

interface Entry {
  readonly scope: ExecutionScope;
  readonly toolCallId: string;
  readonly snapshot: MCPToolCallDisplay;
  readonly expiresAt: number;
}

/**
 * Hands per-tool-call display snapshots from the MCP tool wrapper (writer)
 * to the stream that owns the call (consumer) without either side importing
 * the other. Keyed by (execution scope, tool call id):
 *
 * - `set` is accepted only for a scope that is currently open, so a call that
 *   completes after its stream was aborted cannot label a later stream that
 *   reuses the same tool call id.
 * - `take` reads only the given scope's entry and removes it (single
 *   consumer): a late consumer of one stream can never see another's snapshot.
 * - `close` removes exactly that scope's entries.
 * - Entries expire after a TTL and the registry is capped globally (oldest
 *   first), so leaked calls cannot grow memory.
 */
export class ToolCallDisplayRegistry {
  private readonly scopes = new Map<ExecutionScope, Map<string, Entry>>();
  /**
   * Oldest-first: entries are only ever appended (an overwrite removes the
   * old entry and appends a new one), so Set iteration order is age order and
   * both TTL sweeps and cap eviction walk it from the front.
   */
  private readonly order = new Set<Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options?: { now?: () => number; ttlMs?: number; maxEntries?: number }) {
    this.now = options?.now ?? (() => Date.now());
    this.ttlMs = options?.ttlMs ?? TOOL_CALL_DISPLAY_TTL_MS;
    this.maxEntries = options?.maxEntries ?? TOOL_CALL_DISPLAY_MAX_ENTRIES;
    assert(this.ttlMs > 0, "ToolCallDisplayRegistry ttlMs must be positive");
    assert(this.maxEntries > 0, "ToolCallDisplayRegistry maxEntries must be positive");
  }

  /** Register a scope so its writers are accepted. Idempotent: re-opening keeps existing entries. */
  open(scope: ExecutionScope): void {
    if (!this.scopes.has(scope)) {
      this.scopes.set(scope, new Map());
    }
  }

  /** Forget a scope and only its entries; later writes for it are ignored. */
  close(scope: ExecutionScope): void {
    const entries = this.scopes.get(scope);
    if (!entries) {
      return;
    }
    for (const entry of entries.values()) {
      this.order.delete(entry);
    }
    this.scopes.delete(scope);
  }

  /** Publish a snapshot; returns false (and stores nothing) when the scope is unknown or closed. */
  set(scope: ExecutionScope, toolCallId: string, snapshot: MCPToolCallDisplay): boolean {
    const entries = this.scopes.get(scope);
    if (!entries) {
      return false;
    }
    const now = this.now();
    this.evictExpired(now);
    const previous = entries.get(toolCallId);
    if (previous) {
      this.order.delete(previous);
    }
    const entry: Entry = { scope, toolCallId, snapshot, expiresAt: now + this.ttlMs };
    entries.set(toolCallId, entry);
    this.order.add(entry);
    for (const oldest of this.order) {
      if (this.order.size <= this.maxEntries) {
        break;
      }
      this.remove(oldest);
    }
    return true;
  }

  /** Consume the scope's snapshot for a call, if any and not expired. A second take returns undefined. */
  take(scope: ExecutionScope, toolCallId: string): MCPToolCallDisplay | undefined {
    const entry = this.scopes.get(scope)?.get(toolCallId);
    if (!entry) {
      return undefined;
    }
    this.remove(entry);
    return entry.expiresAt > this.now() ? entry.snapshot : undefined;
  }

  private remove(entry: Entry): void {
    this.order.delete(entry);
    this.scopes.get(entry.scope)?.delete(entry.toolCallId);
  }

  private evictExpired(now: number): void {
    for (const entry of this.order) {
      if (entry.expiresAt > now) {
        break;
      }
      this.remove(entry);
    }
  }
}
