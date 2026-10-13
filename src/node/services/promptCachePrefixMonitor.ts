/**
 * Runtime prompt-cache prefix-break detector for Anthropic requests.
 *
 * Within a turn the AI SDK extends each request from in-memory step results,
 * but the next turn's first request is rebuilt from chat.jsonl, and any byte
 * difference re-processes the conversation uncached. This compares every
 * chat-turn request with the previous request of its workspace and records
 * the first block that broke the prefix. It keeps hashes only, in memory, for
 * a bounded set of workspaces.
 */

import { log } from "@/node/services/log";
import {
  comparePromptCachePrefix,
  describePromptCacheBreak,
  fingerprintAnthropicRequest,
  type PromptCacheBlock,
} from "@/node/services/promptCachePrefix";
import type { TimelineRecorder } from "@/node/services/timelineRecorder";

/**
 * Baselines kept in memory, one per workspace and route/endpoint/model identity; the least recently
 * observed is dropped first.
 */
const MAX_TRACKED_BASELINES = 128;

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The marker of one block: wire `cache_control`, or the prompt form's `providerOptions.anthropic.cacheControl`. */
function markerTtl(block: unknown): unknown {
  if (!isRecord(block)) return undefined;
  const providerOptions = isRecord(block.providerOptions) ? block.providerOptions : {};
  const anthropic = isRecord(providerOptions.anthropic) ? providerOptions.anthropic : {};
  const marker = block.cache_control ?? anthropic.cacheControl;
  return isRecord(marker) ? marker.ttl : undefined;
}

/**
 * The cache lifetime the request asked for: 1h when any cache marker sets `ttl: "1h"`, else
 * Anthropic's 5-minute default. After that, the baseline's cache entry is gone, so a later
 * request is cold by expiry and a difference is not reported as a prefix break. Only the
 * places a marker can sit are read (tools, system blocks, messages, their content blocks and
 * the blocks inside a tool_result): a `ttl` field in a tool schema or tool input is data.
 */
function requestCacheTtlMs(body: Record<string, unknown>): number {
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const messages = [...asArray(body.messages), ...asArray(body.prompt)];
  const contentBlocks = messages.flatMap((message) =>
    isRecord(message) ? asArray(message.content) : []
  );
  const markable = [
    ...asArray(body.tools),
    ...asArray(body.system),
    ...messages,
    ...contentBlocks,
    ...contentBlocks.flatMap((block) =>
      isRecord(block) && block.type === "tool_result" ? asArray(block.content) : []
    ),
  ];
  return markable.some((block) => markerTtl(block) === "1h") ? ONE_HOUR_MS : FIVE_MINUTES_MS;
}

/**
 * One chat turn's requests. TurnRequestBuilder creates one per built turn
 * through {@link PromptCachePrefixMonitor.createTurnScope}; side calls
 * (titles, status, memory, refine) create models without one and are never
 * tracked.
 */
export interface PromptCacheTurnScope {
  readonly workspaceId: string;
  readonly recorder: TimelineRecorder;
  /** True after {@link markCompaction}: this turn's requests record nothing. */
  readonly skip: boolean;
  /**
   * Compaction rebuilds the prompt by design (another system prompt, then a
   * summary instead of history). TurnRequestBuilder calls this before any
   * request is sent. It also clears the workspace baseline at once, whatever
   * model or route the compaction uses: only Anthropic routes observe, so a
   * non-Anthropic compaction would otherwise leave the pre-compaction
   * baseline in place and the next Anthropic turn would report a break.
   */
  markCompaction(): void;
  /**
   * Identifies the context the turn was built from (the first history row of the request).
   * `/clear`, "start here" and context rollovers replace that row, and the next request is
   * meant to differ from the old baseline, so a different epoch resets the baseline silently.
   */
  readonly contextEpoch: string | undefined;
  setContextEpoch(epoch: string | undefined): void;
}

/** Requests compare only within one wire route, endpoint and effective model. */
export interface PromptCacheRouteIdentity {
  route: string;
  modelString: string;
  /** Origin and path of the request URL: another base URL reaches another cache. */
  endpoint: string;
}

export class PromptCachePrefixMonitor {
  /**
   * Keyed by workspace and route/model identity: each identity has its own cache entry, so
   * switching Sonnet -> Opus -> Sonnet within the TTL still compares the second Sonnet request
   * with the first.
   */
  private readonly latest = new Map<
    string,
    {
      workspaceId: string;
      scope: PromptCacheTurnScope;
      blocks: PromptCacheBlock[];
      observedAt: number;
      ttlMs: number;
    }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  createTurnScope(workspaceId: string, recorder: TimelineRecorder): PromptCacheTurnScope {
    let skip = false;
    let contextEpoch: string | undefined;
    return {
      workspaceId,
      recorder,
      get skip() {
        return skip;
      },
      get contextEpoch() {
        return contextEpoch;
      },
      setContextEpoch: (epoch) => {
        contextEpoch = epoch;
      },
      markCompaction: () => {
        skip = true;
        // Every identity's baseline: the compaction replaced the history all of them hold.
        for (const [key, entry] of this.latest) {
          if (entry.workspaceId === workspaceId) this.latest.delete(key);
        }
      },
    };
  }

  /**
   * Call only after the request was dispatched: a request that never reached
   * Anthropic cannot create or break a cache entry. Never throws: a detector
   * failure must not affect the request.
   */
  observe(
    scope: PromptCacheTurnScope,
    identity: PromptCacheRouteIdentity,
    body: Record<string, unknown>
  ): void {
    try {
      const workspaceId = scope.workspaceId;
      const key = [workspaceId, identity.route, identity.endpoint, identity.modelString].join("\0");
      const previous = this.latest.get(key);
      // Re-inserting keeps Map order equal to recency, so eviction drops the oldest.
      this.latest.delete(key);
      if (scope.skip) return;
      const blocks = fingerprintAnthropicRequest(body);
      const observedAt = this.now();
      this.latest.set(key, {
        workspaceId,
        scope,
        blocks,
        observedAt,
        ttlMs: requestCacheTtlMs(body),
      });
      if (this.latest.size > MAX_TRACKED_BASELINES) {
        const oldest = this.latest.keys().next().value;
        if (oldest != null) this.latest.delete(oldest);
      }
      if (previous == null) return;
      // A new context (clear, start here, rollover) or an expired cache entry makes this
      // request cold on purpose or by time: start a new baseline without reporting a break.
      if (previous.scope.contextEpoch !== scope.contextEpoch) return;
      if (observedAt - previous.observedAt > previous.ttlMs) return;

      const comparison = comparePromptCachePrefix(previous.blocks, blocks);
      // "unsupported" (context editing on either side): the fingerprint cannot tell, so record
      // nothing. The request above already replaced the baseline.
      if (comparison.kind !== "break") return;
      const { kind: _kind, ...breakData } = comparison;
      const promptCacheBreak = {
        ...breakData,
        boundary: previous.scope === scope ? ("step" as const) : ("turn" as const),
      };
      const description = describePromptCacheBreak(comparison);
      log.info("Prompt cache prefix break", {
        workspaceId,
        route: identity.route,
        modelString: identity.modelString,
        ...promptCacheBreak,
      });
      scope.recorder.record(workspaceId, {
        kind: "cache.prefix_break",
        source: { system: "chat" },
        data: { model: identity.modelString, description, promptCacheBreak },
      });
    } catch (error) {
      log.debug("Prompt cache prefix detector failed", {
        workspaceId: scope.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
