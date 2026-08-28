/**
 * Loop protection for intra-tree agent peer messaging: task_send_message sends whose target is
 * NOT the sender's descendant (siblings/cousins and ancestors, including the root workspace).
 * Parent→descendant guidance is unthrottled and unaffected by these constants.
 *
 * All counters live in-memory on TaskService (mirroring consecutiveAutoResumes): a restart clears
 * them, which is an accepted tradeoff — peer messages have no durable crash replay either.
 */

/** Max peer/ancestor sends per sender→target pair within PEER_MESSAGE_RATE_WINDOW_MS. */
export const PEER_MESSAGE_RATE_LIMIT_MAX = 5;
export const PEER_MESSAGE_RATE_WINDOW_MS = 60_000;

/** Max peer/ancestor sends per target across all senders (catches many-sender flooding). */
export const PEER_MESSAGE_TARGET_RATE_LIMIT_MAX = 10;

/** Identical (sender, target, trimmed text) within this window is refused as a duplicate. */
export const PEER_MESSAGE_DEDUPE_WINDOW_MS = 120_000;

/** Max peer messages queued (not yet dispatched) behind one busy target. */
export const MAX_QUEUED_PEER_MESSAGES_PER_TARGET = 10;

/**
 * Queue dedupe-key prefix for peer-message wake triggers (`agent-msg:<sender>:<uuid>`). The
 * unique suffix prevents coalescing; the prefix lets the queue count peer entries even when a
 * trigger's muxMetadata carries a workspace-turn correlation instead of peer attribution.
 */
export const AGENT_PEER_MESSAGE_DEDUPE_PREFIX = "agent-msg:";

/**
 * Max peer messages admitted for a target without any user-authored input or parent guidance in
 * between; at the cap the target is deemed to need user attention. Charged when a send is
 * admitted (queued or delivered), so dispatch timing cannot exceed the advertised turn count.
 */
export const MAX_CONSECUTIVE_PEER_WAKES = 3;
