/**
 * Loop protection for instance-wide agent peer messaging: task_send_message sends whose target is
 * NOT the sender's descendant (siblings/cousins, ancestors, or unrelated workspaces).
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
 * Queue dedupe-key prefix for incremental `agent_report` updates queued behind a busy parent.
 * Full key: `agent-report:<child>:<toolCallId>` for a child's original run, or
 * `agent-report:<child>:<executionId>:<toolCallId>` while a reawakened child runs as a
 * workspace-turn continuation, so a terminal settlement can drop exactly the updates that
 * execution superseded (a successor execution's updates keep their own prefix).
 */
export const AGENT_REPORT_PROGRESS_DEDUPE_PREFIX = "agent-report:";

/** Prefix matching every queued incremental update from one child (optionally one execution). */
export function agentReportProgressDedupePrefix(
  childWorkspaceId: string,
  executionId?: string
): string {
  return executionId == null
    ? `${AGENT_REPORT_PROGRESS_DEDUPE_PREFIX}${childWorkspaceId}:`
    : `${AGENT_REPORT_PROGRESS_DEDUPE_PREFIX}${childWorkspaceId}:${executionId}:`;
}

/** onCanceled reason for queued incremental updates dropped by the child's terminal outcome. */
export const AGENT_REPORT_PROGRESS_SUPERSEDED_REASON =
  "Incremental sub-agent update superseded by the terminal report.";

/**
 * Queue dedupe-key prefix for synthetic prompts that ask a child task to finish
 * (`task-recovery-prompt:<taskId>:<kind>`). Prompts queue with turn-end dispatch so they never
 * cut the child's live turn, and a terminal transition removes them by the task prefix so a
 * queued prompt cannot outlive the task it was meant to recover.
 */
export const TASK_RECOVERY_PROMPT_DEDUPE_PREFIX = "task-recovery-prompt:";

/** Longest structured-output validator excerpt echoed into a task recovery prompt. */
export const TASK_RECOVERY_DIAGNOSTIC_MAX_CHARS = 400;

export type TaskRecoveryPromptKind = "completion" | "timeout-finalization";

/** Prefix matching every queued recovery prompt for one child task. */
export function taskRecoveryPromptDedupePrefix(taskId: string): string {
  return `${TASK_RECOVERY_PROMPT_DEDUPE_PREFIX}${taskId}:`;
}

/** One queued prompt per kind per task; a duplicate send coalesces onto the queued one. */
export function taskRecoveryPromptDedupeKey(taskId: string, kind: TaskRecoveryPromptKind): string {
  return `${taskRecoveryPromptDedupePrefix(taskId)}${kind}`;
}

/**
 * Max peer messages admitted for a target without any user-authored input or parent guidance in
 * between; at the cap the target is deemed to need user attention. Charged when a send is
 * admitted (queued or delivered), so dispatch timing cannot exceed the advertised turn count.
 */
export const MAX_CONSECUTIVE_PEER_WAKES = 3;

/**
 * Single retryable refusal for every admission path (direct/automatic sends, queued dispatch,
 * task resume, recovery, queued launch) while a stop cascade holds a workspace's latch. The
 * latch drops once the stopped execution has settled; callers may simply retry afterwards.
 */
export const WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE =
  "A stop is in progress for this workspace; retry once it has settled.";

/**
 * Refusal for a send that would continue an agent-task attempt whose settlement has begun or
 * completed (idle stop, terminal failure, launch failure). Not retryable as a continuation: an
 * intentional resume is a new attempt (user resume, task_send_message reawaken), which mints a
 * fresh attempt id and is admitted on its own.
 */
export const TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE =
  "This sub-agent's current attempt has settled; resume it explicitly to start a new attempt.";

/**
 * Stable refusal for every admission of an attempt a workflow retired (taskAttemptRetiredBy):
 * reawaken, reactivation, startup re-drive and queue launch all surface exactly this text.
 */
export function retiredAttemptMessage(claim: { runId: string; stepId: string }): string {
  return `This sub-agent's attempt was retired by workflow run ${claim.runId} (step ${claim.stepId}); start a new task instead.`;
}

/** Returned when a caller-supplied admission probe (internal.admissionStale) flips mid-send. */
export const SEND_ADMISSION_STALE_MESSAGE =
  "Send refused: the target was stopped or interrupted while the message was being admitted.";

/**
 * A manual send whose reawaken of a stopped or reported sub-agent lost its identity CAS: another
 * send (another backend's resume) reawakened it first. Nothing was sent.
 */
export const TASK_REAWAKEN_LOST_SEND_BLOCKED_MESSAGE =
  "Send refused: this sub-agent was resumed by another send at the same time; nothing was sent. Try again.";

/**
 * A message queued into a sub-agent while its last turn streamed, refused at dispatch because
 * that turn turned out to be the task's terminal report. The text is handed back to the composer
 * as unsent input; sending it again is a new, normally admitted send that starts a fresh attempt.
 */
export const TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE =
  "The sub-agent completed its report before this queued message could run; it was not sent and is back in the composer.";

/** As above, when the report's outcome could not be established (handler failure, partial artifact). */
export const TASK_REPORT_OUTCOME_INDETERMINATE_UNSENT_MESSAGE =
  "The sub-agent's report outcome could not be determined; this queued message was not sent and is back in the composer.";

/** Bound on-demand instance discovery without growing the default task list. */
export const INSTANCE_DISCOVERY_DEFAULT_LIMIT = 20;
export const INSTANCE_DISCOVERY_MAX_LIMIT = 100;
