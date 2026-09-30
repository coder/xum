interface ResponseNotificationPolicy {
  /** Suppress notify-on-response for synthetic implementation-detail turns. */
  suppressNotification?: boolean;
}

export type ResponseCompleteMetadata =
  | ({
      kind: "response";
      // Notification policy should follow the user-visible terminal turn rather than every
      // intermediate stream boundary. Another queued/auto-dispatched follow-up means this
      // completion is only a handoff, so it should not notify on its own.
      hasAutoFollowUp: boolean;
    } & ResponseNotificationPolicy)
  | ({
      kind: "compaction";
      // Only used to carry synthetic follow-up suppression across background
      // generation handoffs; compaction itself is never notify-eligible.
    } & ResponseNotificationPolicy);

export interface ResponseCompleteEvent {
  workspaceId: string;
  isFinal: boolean;
  finalText?: string;
  messageId?: string;
  completion?: ResponseCompleteMetadata;
  completedAt?: number | null;
}

export type ResponseCompleteHandler = (event: ResponseCompleteEvent) => void;

export interface ResponseCompletionState {
  isCompacting: boolean;
  hasQueuedFollowUp: boolean;
  /** This stream is a synthetic implementation-detail turn and should not alert. */
  suppressNotification?: boolean;
}

export function buildResponseCompleteMetadata(
  state: ResponseCompletionState
): ResponseCompleteMetadata | undefined {
  const suppressNotification = state.suppressNotification === true;
  if (state.isCompacting) {
    // Compaction is context-management, not an assistant response. Treat every
    // compaction boundary as non-notifiable so notification correctness never
    // depends on racing follow-up/queue metadata.
    return {
      kind: "compaction",
      ...(suppressNotification ? { suppressNotification: true } : {}),
    };
  }

  const hasAutoFollowUp = state.hasQueuedFollowUp;
  if (!hasAutoFollowUp && !suppressNotification) {
    return undefined;
  }

  return {
    kind: "response",
    hasAutoFollowUp,
    ...(suppressNotification ? { suppressNotification: true } : {}),
  };
}

export function buildAggregateResponseCompleteMetadata(
  states: Iterable<ResponseCompletionState>
): ResponseCompleteMetadata | undefined {
  let isCompacting = false;
  let hasQueuedFollowUp = false;
  let suppressNotification = false;

  for (const state of states) {
    isCompacting ||= state.isCompacting;
    hasQueuedFollowUp ||= state.hasQueuedFollowUp;
    suppressNotification ||= state.suppressNotification === true;
  }

  return buildResponseCompleteMetadata({
    isCompacting,
    hasQueuedFollowUp,
    suppressNotification,
  });
}

export function createCompactionCompletion(): ResponseCompleteMetadata {
  return { kind: "compaction" };
}

export function shouldNotifyOnResponseComplete(
  completion: ResponseCompleteMetadata | undefined
): boolean {
  if (completion === undefined) {
    return true;
  }

  if (completion.kind === "compaction") {
    return false;
  }

  if (completion.suppressNotification === true) {
    return false;
  }

  return !completion.hasAutoFollowUp;
}

export function getResponseCompleteNotificationBody(
  finalText: string | undefined,
  completion: ResponseCompleteMetadata | undefined
): string {
  if (completion?.kind === "compaction") {
    return "Compaction complete";
  }

  if (!finalText) {
    return "Response complete";
  }

  return finalText.length > 200 ? `${finalText.slice(0, 197)}…` : finalText;
}
