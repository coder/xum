/**
 * RLM family messaging bounds (task_message_parent / task_message_sibling).
 *
 * A kernel guest can synthesize a multi-megabyte string in code_execution
 * without spending equivalent output tokens; without a cap the whole value
 * would be queued into a parent/sibling transcript, persisted, and sent to
 * that workspace's provider. 16K chars is generous for a status/handoff
 * message while keeping the receiving transcript bounded.
 *
 * There is no per-session aggregate budget: a lifetime cap refused
 * long-running conversations until restart. The family helpers share
 * task_send_message's peer throttles in agentMessaging.ts (rate limits,
 * duplicate suppression, queue cap), which bound how fast a code_execution
 * loop can push max-size messages into another workspace.
 */
export const TASK_FAMILY_MESSAGE_MAX_CHARS = 16 * 1024;

/**
 * Cap on the sender title interpolated into a family-message payload row's
 * attribution. Titles are attacker-influenced (auto-titling derives them from
 * child content; spawn/retitle impose no cap), and the attribution framing is
 * rendered on EVERY send — an unbounded title would multiply through every
 * delivered payload.
 */
export const TASK_FAMILY_MESSAGE_MAX_TITLE_CHARS = 256;

/**
 * Upper bound for reading a sub-agent's definition chain before an ancestor
 * reawakens it. The read runs outside the task locks; on timeout the read is
 * aborted (cancelling runtime work where supported) and the reawakening
 * resolves AI settings without definition layers (best effort).
 */
export const REAWAKEN_DEFINITION_READ_TIMEOUT_MS = 5_000;

/**
 * Retryable refusal when a reawakening's inputs changed BEFORE the child accepted the
 * turn: nothing was written, so resending the same message is safe.
 */
export function formatReawakenChangedMessage(taskId: string): string {
  return `Sub-agent ${taskId} changed while it was being reawakened; send the message again.`;
}

/**
 * Retryable refusal at the commit point (turn acceptance): the child already made the
 * prompt row durable, so resending the same message would duplicate it. Ask for a short
 * follow-up that resumes the child instead.
 */
export function formatReawakenCommitRefusedMessage(taskId: string): string {
  return `Sub-agent ${taskId}'s settings changed while it was starting. Your message may already be in its history; send a short follow-up to resume it instead of repeating the message.`;
}
