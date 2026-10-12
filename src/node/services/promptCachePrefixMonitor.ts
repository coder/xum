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

/** Workspaces whose latest fingerprints stay in memory; the least recent is dropped first. */
const MAX_TRACKED_WORKSPACES = 128;

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
}

/** Requests compare only within one wire route and effective model. */
export interface PromptCacheRouteIdentity {
  route: string;
  modelString: string;
}

export class PromptCachePrefixMonitor {
  private readonly latest = new Map<
    string,
    { routeKey: string; scope: PromptCacheTurnScope; blocks: PromptCacheBlock[] }
  >();

  createTurnScope(workspaceId: string, recorder: TimelineRecorder): PromptCacheTurnScope {
    let skip = false;
    return {
      workspaceId,
      recorder,
      get skip() {
        return skip;
      },
      markCompaction: () => {
        skip = true;
        this.latest.delete(workspaceId);
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
      const previous = this.latest.get(workspaceId);
      // Re-inserting keeps Map order equal to recency, so eviction drops the oldest.
      this.latest.delete(workspaceId);
      if (scope.skip) return;
      const routeKey = `${identity.route}\0${identity.modelString}`;
      const blocks = fingerprintAnthropicRequest(body);
      this.latest.set(workspaceId, { routeKey, scope, blocks });
      if (this.latest.size > MAX_TRACKED_WORKSPACES) {
        const oldest = this.latest.keys().next().value;
        if (oldest != null) this.latest.delete(oldest);
      }
      if (previous?.routeKey !== routeKey) return;

      const comparison = comparePromptCachePrefix(previous.blocks, blocks);
      if (comparison.kind === "extends") return;
      const { kind: _kind, ...breakData } = comparison;
      const promptCacheBreak = {
        ...breakData,
        boundary: previous.scope === scope ? ("step" as const) : ("turn" as const),
      };
      const description = describePromptCacheBreak(comparison);
      log.info("Prompt cache prefix break", { workspaceId, ...identity, ...promptCacheBreak });
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
