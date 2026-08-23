/**
 * Bounds for the /refine trajectory-distillation pass (RLM track, phase r11).
 *
 * The pass is deliberately small: it reads the recent workspace trajectory,
 * distills at most a handful of durable lessons, and applies the smallest
 * evidence-backed edits. Reuses the dream-agent bounding pattern (step
 * ceiling + mutation budget + hard timeout) from memory consolidation.
 */

/** Step ceiling for the headless refine agent loop. */
export const REFINE_MAX_STEPS = 16;

/** Mutation budget shared across memory + skill edits ("a handful"). */
export const REFINE_OP_BUDGET = 5;

/** Hard timeout so a wedged provider stream cannot hold the run lock forever. */
export const REFINE_TIMEOUT_MS = 3 * 60 * 1000;

/** Newest chat messages considered by one pass (transcript is char-bounded on top). */
export const REFINE_MAX_MESSAGES = 200;

/** Newest timeline events included when the Timeline experiment is on. */
export const REFINE_TIMELINE_EVENT_LIMIT = 50;

/** Human-readable marker prefixed to the durable refine summary chat row. */
export const REFINE_SUMMARY_LABEL = "Refine pass applied durable lessons:";

/**
 * Acquisition timeout for the cross-process /refine apply lock. A held lock
 * means another process is mid-apply; callers reject quickly (mirroring the
 * in-process "already running" rejection) instead of queueing user commands.
 */
export const REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS = 10_000;

/**
 * Session-dir lockfile serializing refine staging/apply with context-
 * discarding history mutations (reset, clear, destructive replace) across
 * processes. One shared spelling (r57): WorkspaceService and both refine
 * paths must hold the SAME file or the publish-after-reset and double-apply
 * races these locks close would silently reopen.
 */
export const REFINE_APPLY_LOCK_FILENAME = "refine-apply.lock";
