import { createHash, randomBytes } from "node:crypto";
import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import type { MCPConnectionRef } from "@/common/types/mcp";
import assert from "@/common/utils/assert";
import { isPngDataUrl } from "@/common/utils/mcp/pngDataUrl";
import { isWithinIconSourceBudget } from "./mcpServerIcon";
import type { IconCandidate } from "./mcpServerIdentity";

/** Empty host-created token: object identity, not serializable data, owns one generation. */
export type MCPIconOwner = Readonly<Record<string, never>>;

interface Entry {
  readonly owner: MCPIconOwner;
  readonly key: string;
  readonly result: Promise<string | null>;
  expiresAt: number;
  bytes: number;
}

/**
 * Immutable session-local artwork. The host uses a fresh owner object for each
 * connection/test generation; aliases and URLs cannot relabel historical calls.
 * Only digests, opaque refs and bounded PNGs survive resolution, not data URLs
 * from the server. Eviction never re-fetches or resurrects an old reference.
 */
export class MCPIconRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly owners = new WeakMap<MCPIconOwner, Map<string, string>>();
  private bytes = 0;

  constructor(
    private readonly resolve: (
      candidates: readonly IconCandidate[],
      binding: MCPConnectionRef
    ) => Promise<string | null>,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Register before publishing the ref; lookup can await even the first call. */
  ensure(
    owner: MCPIconOwner,
    candidates: readonly IconCandidate[],
    binding: MCPConnectionRef
  ): string | undefined {
    if (candidates.length === 0) return undefined;
    assert(
      candidates.length <= MCP_IDENTITY_LIMITS.iconCandidatesMax,
      "Icon candidates must be normalized before registration"
    );
    // Runs on every tool call, including cached handshake icons, on the main
    // process: refuse an over-budget set before the copy and digest below.
    if (!isWithinIconSourceBudget(candidates)) return undefined;
    this.prune();
    const copied = candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.sizes ? { sizes: [...candidate.sizes] } : {}),
    }));
    const connection = { ...binding };
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          connection.key,
          connection.transport,
          connection.origin,
          copied.map((candidate) => [
            candidate.src,
            candidate.mimeType,
            candidate.sizes,
            candidate.theme,
          ]),
        ])
      )
      .digest("hex");
    let owned = this.owners.get(owner);
    if (!owned) {
      owned = new Map();
      this.owners.set(owner, owned);
    }
    const previous = owned.get(key);
    if (previous) {
      const entry = this.entries.get(previous);
      assert(entry, "Owner index must only contain retained icon references");
      this.touch(previous, entry);
      return previous;
    }
    const ref = randomBytes(16).toString("hex");
    assert(!this.entries.has(ref), "Icon references must not overwrite existing artwork");
    const entry: Entry = {
      owner,
      key,
      // Starting in a microtask makes registration observable before any resolver
      // work. The resolver owns the absolute deadline and child reaping, so the
      // registry must not release its slot or initiate a second resolution.
      result: Promise.resolve()
        .then(() => this.resolve(copied, connection))
        .then(
          (icon) => this.complete(ref, entry, icon),
          () => this.complete(ref, entry, null)
        ),
      expiresAt: this.now() + MCP_ICON_LIMITS.deadlineMs,
      bytes: ref.length + key.length,
    };
    this.entries.set(ref, entry);
    owned.set(key, ref);
    this.bytes += entry.bytes;
    this.prune();
    return ref;
  }

  /** Lookup only: unknown, expired, or evicted refs never cause network work. */
  async get(ref: string): Promise<string | null> {
    this.prune();
    const entry = this.entries.get(ref);
    if (!entry) return null;
    this.touch(ref, entry);
    const icon = await entry.result;
    return this.entries.get(ref) === entry && entry.expiresAt > this.now() ? icon : null;
  }

  private complete(ref: string, entry: Entry, value: unknown): string | null {
    // A cancelled/reconfigured generation's completion belongs to its original
    // ref. It can settle existing readers but never reinsert an evicted entry.
    if (this.entries.get(ref) !== entry) return null;
    const icon = isPngDataUrl(value) ? value : null;
    const bytes = icon?.length ?? 0; // Validated data URLs and our keys are ASCII.
    entry.bytes += bytes;
    this.bytes += bytes;
    entry.expiresAt =
      this.now() + (icon === null ? MCP_ICON_LIMITS.failureTtlMs : MCP_ICON_LIMITS.successTtlMs);
    this.prune();
    return this.entries.get(ref) === entry ? icon : null;
  }

  private touch(ref: string, entry: Entry): void {
    this.entries.delete(ref);
    this.entries.set(ref, entry);
  }

  private remove(ref: string, entry: Entry): void {
    this.entries.delete(ref);
    const owned = this.owners.get(entry.owner);
    if (owned?.get(entry.key) === ref) owned.delete(entry.key);
    this.bytes -= entry.bytes;
    assert(this.bytes >= 0, "Icon cache byte accounting must remain non-negative");
  }

  private prune(): void {
    const now = this.now();
    for (const [ref, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(ref, entry);
    }
    for (const [ref, entry] of this.entries) {
      if (
        this.entries.size <= MCP_ICON_LIMITS.registryMaxEntries &&
        this.bytes <= MCP_ICON_LIMITS.registryMaxBytes
      )
        break;
      this.remove(ref, entry);
    }
  }
}
