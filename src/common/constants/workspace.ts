import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Default runtime configuration for worktree workspaces.
 * Uses git worktrees for workspace isolation.
 * Used when no runtime config is specified.
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  type: "worktree",
  srcBaseDir: "~/.xum/src",
} as const;

/**
 * Returned by `workspace.interruptStream` for a user Stop whose stream did stop but whose startup
 * abandon marker or monitor-attention retirement could not be written.
 */
export const STOP_UNRECORDED_MESSAGE =
  "Stop could not be recorded on disk, so the stopped work may resume on restart.";

/**
 * Bound on the checkout existence probe behind transcript-only classification. Every workspace
 * metadata publication awaits it, and fs.access on a stalled mount never settles. Far above a
 * healthy local access (sub-millisecond).
 */
export const WORKSPACE_CHECKOUT_PROBE_TIMEOUT_MS = 2_000;
