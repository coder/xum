import assert from "@/common/utils/assert";

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useLiveAPI } from "@/browser/contexts/API";
import {
  CLOSED_UNANSWERED_MESSAGES,
  type ClosedUnansweredReason,
  useNonBlockingQuestionAnswers,
} from "@/browser/features/Tools/AskUserQuestion/useNonBlockingQuestionAnswers";
import { useAskUserQuestionPlacement } from "@/browser/features/Tools/AskUserQuestion/askUserQuestionPlacement";
import {
  ASK_USER_QUESTION_HINTS,
  AskUserQuestionForm,
  AskUserQuestionHeader,
} from "@/browser/features/Tools/AskUserQuestion/AskUserQuestionForm";
import {
  buildAnswerSelections,
  buildAnswersRecord,
  createInitialDrafts,
  deleteCachedDraftState,
  type DraftAnswer,
  type DraftAnswers,
  EMPTY_DRAFT,
  getCachedDraftState,
  getDescriptionsForLabels,
  getDraftStateKey,
  setCachedDraftState,
} from "@/browser/features/Tools/AskUserQuestion/askUserQuestionDrafts";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import {
  ErrorBox,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "@/browser/features/Tools/Shared/ToolPrimitives";
import {
  getStatusDisplay,
  useToolExpansion,
  type ToolStatus,
} from "@/browser/features/Tools/Shared/toolUtils";
import type {
  AskUserQuestionQuestion,
  AskUserQuestionToolArgs,
  AskUserQuestionToolResult,
  AskUserQuestionUiOnlyPayload,
  ToolErrorResult,
} from "@/common/types/tools";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { isAsyncAskUserQuestionOutput } from "@/common/utils/tools/askUserQuestionSummary";
import { getErrorMessage } from "@/common/utils/errors";
import { useHostTranscriptMutationCheck } from "@/browser/utils/transcriptBarrier";
import { TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE } from "@/constants/transcriptBarrier";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";

function unwrapJsonContainer(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "json" && "value" in record) {
    return record.value;
  }

  return value;
}

function isAskUserQuestionPayload(val: unknown): val is AskUserQuestionUiOnlyPayload {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  if (!Array.isArray(record.questions)) {
    return false;
  }

  if (!record.answers || typeof record.answers !== "object") {
    return false;
  }

  for (const [, v] of Object.entries(record.answers as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return false;
    }
  }

  return true;
}

function isToolErrorResult(val: unknown): val is ToolErrorResult {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  return record.success === false && typeof record.error === "string";
}

/**
 * A finished question: the submitted answers, one row per question with the picked options'
 * descriptions, or a note when a non-blocking question closed unanswered.
 */
function AnsweredQuestions(props: {
  result: { questions: AskUserQuestionQuestion[]; answers: Record<string, string> } | null;
  closedUnanswered: ClosedUnansweredReason | null;
}): JSX.Element | null {
  const result = props.result;
  if (result == null) {
    return props.closedUnanswered !== null ? (
      <div className="text-muted text-[11px] italic">
        Not answered. {CLOSED_UNANSWERED_MESSAGES[props.closedUnanswered]}
      </div>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-secondary text-[10px] tracking-wide uppercase">User answered</div>
      {Object.entries(result.answers).map(([question, answer]) => {
        const questionDef = result.questions.find((q) => q.question === question);
        // Parse answer labels (could be comma-separated for multi-select)
        const answerLabels = answer.split(",").map((s) => s.trim());
        const descriptions = questionDef ? getDescriptionsForLabels(questionDef, answerLabels) : [];
        const header = questionDef?.header ?? question;

        return (
          <div
            key={question}
            className="bg-code-bg flex flex-col gap-0.5 rounded border border-white/5 px-2.5 py-1.5"
          >
            <div className="text-secondary text-[10px] tracking-wide uppercase">{header}</div>
            <div className="text-foreground text-sm leading-snug">{answer}</div>
            {descriptions.length > 0 && (
              <div className="text-muted-foreground text-[11px] italic">
                {descriptions.join("; ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A docked card stays mounted after its questions close until nothing is left to finish: no
 * submit in flight and no auto-retry rollback waiting on the resumed stream. Then the dock
 * unmounts it, so closed cards do not pile up. Reruns on every workspace update, which is when
 * the rollback settles.
 */
function useReleaseSettledDockCard(args: {
  rowId: string | undefined;
  isAnswering: boolean;
  isSubmitting: boolean;
  rollbackPendingRef: RefObject<boolean>;
  workspaceState: unknown;
}): void {
  const placement = useAskUserQuestionPlacement();
  const release = placement.kind === "dock" ? placement.release : null;
  const { rowId, isAnswering, isSubmitting, rollbackPendingRef, workspaceState } = args;
  useEffect(() => {
    if (
      release === null ||
      rowId == null ||
      isAnswering ||
      isSubmitting ||
      rollbackPendingRef.current
    ) {
      return;
    }
    release(rowId);
  }, [release, rowId, isAnswering, isSubmitting, rollbackPendingRef, workspaceState]);
}

interface AskUserQuestionToolCallProps {
  args: AskUserQuestionToolArgs;
  result: AskUserQuestionToolResult | null;
  status: ToolStatus;
  toolCallId: string;
  workspaceId?: string;
  /** The transcript row's display id: tells apart rows that reuse a tool call id. */
  rowId?: string;
}

/**
 * The transcript row of a question that is open in the dock above the chat input: the form lives
 * there (sticky to the bottom of the chat), so only one copy of it takes answers.
 */
function DockedQuestionStub(props: { status: ToolStatus }): JSX.Element {
  return (
    <ToolContainer expanded={false}>
      <ToolHeader className="cursor-default">
        <ToolIcon toolName="ask_user_question" />
        <div className="flex min-w-0 flex-1 flex-col">
          <ToolName>ask_user_question</ToolName>
          <div className="text-secondary text-[10px] leading-tight">
            Answer in the panel above the chat input.
          </div>
        </div>
        <StatusIndicator status={props.status}>{getStatusDisplay(props.status)}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
}

/** The registered ask_user_question card: the form, or a stub while the dock holds the form. */
export function PlacedAskUserQuestionToolCall(
  props: AskUserQuestionToolCallProps
): JSX.Element | null {
  const placement = useAskUserQuestionPlacement();
  if (
    placement.kind === "transcript" &&
    placement.workspaceId === props.workspaceId &&
    props.rowId != null &&
    placement.dockedRowIds.has(props.rowId)
  ) {
    return <DockedQuestionStub status={props.status} />;
  }
  return <AskUserQuestionToolCall {...props} docked={placement.kind === "dock"} />;
}

export function AskUserQuestionToolCall(
  props: AskUserQuestionToolCallProps & {
    /** Rendered in the dock above the chat input: nothing once the questions close. */
    docked?: boolean;
  }
): JSX.Element | null {
  const draftStateKey = getDraftStateKey(props);

  // Restore from cache if available (survives workspace switches)
  const cachedState = getCachedDraftState(draftStateKey);

  const [activeIndex, setActiveIndex] = useState(() => cachedState?.activeIndex ?? 0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const workspaceStore = useWorkspaceStoreRaw();
  const workspaceState = useSyncExternalStore(
    (listener) => {
      if (!props.workspaceId) {
        return () => undefined;
      }

      return workspaceStore.subscribeKey(props.workspaceId, listener);
    },
    () => {
      if (!props.workspaceId) {
        return null;
      }

      // Some render paths (nested tool rendering) do not have workspace context.
      // Fail-soft so ask_user_question still renders instead of crashing the tree.
      try {
        return workspaceStore.getWorkspaceState(props.workspaceId);
      } catch {
        return null;
      }
    }
  );

  // Codex-style questions (non-plan agents) returned without waiting: the tool is complete, but
  // the questions stay answerable until they are answered from this card or an answer message
  // for this tool call is in history.
  const isAsyncQuestion = isAsyncAskUserQuestionOutput(props.result);
  const nonBlocking = useNonBlockingQuestionAnswers({
    enabled: isAsyncQuestion,
    workspaceId: props.workspaceId,
    toolCallId: props.toolCallId,
    rowId: props.rowId,
    questions: props.args.questions,
    transcript: workspaceState?.messages,
  });
  const isAnswering = props.status === "executing" || nonBlocking.isOpen;
  const answeringHints = isAsyncQuestion
    ? ASK_USER_QUESTION_HINTS.nonBlocking
    : ASK_USER_QUESTION_HINTS.blocking;

  // A question awaiting answers must never be hidden behind a collapsed "tools"
  // preference, so force it open while answerable. forceExpanded only overrides the
  // initial seed; once answered the row follows the sticky preference like any tool.
  const { expanded, toggleExpanded } = useToolExpansion(false, {
    forceExpanded: isAnswering,
  });

  const autoRetryRollbackWorkspaceIdRef = useRef<string | null>(null);
  const autoRetryRollbackPendingRef = useRef(false);
  const autoRetryRollbackArmedRef = useRef(false);
  const autoRetryRollbackBaselineMessageCountRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  // The rollback skips while offline, as it did when useAPI() went null in the gap.
  const liveApi = useLiveAPI();
  const isTranscriptMutationAllowed = useHostTranscriptMutationCheck();
  const apiRef = useRef(liveApi);

  useEffect(() => {
    apiRef.current = liveApi;
  }, [liveApi]);

  const rollbackAutoRetryIfNeeded = useCallback(
    async (options?: { suppressErrors?: boolean }): Promise<void> => {
      if (!autoRetryRollbackPendingRef.current) {
        return;
      }

      const rollbackWorkspaceId = autoRetryRollbackWorkspaceIdRef.current;

      autoRetryRollbackPendingRef.current = false;
      autoRetryRollbackArmedRef.current = false;
      autoRetryRollbackBaselineMessageCountRef.current = null;
      autoRetryRollbackWorkspaceIdRef.current = null;

      const activeApi = apiRef.current;
      if (!activeApi || !rollbackWorkspaceId) {
        return;
      }

      const rollbackResult = await activeApi.workspace.setAutoRetryEnabled?.({
        workspaceId: rollbackWorkspaceId,
        enabled: false,
        persist: false,
      });
      if (rollbackResult && !rollbackResult.success && !options?.suppressErrors) {
        setSubmitError(rollbackResult.error);
      }
    },
    []
  );

  useEffect(() => {
    if (!autoRetryRollbackPendingRef.current) {
      return;
    }

    // If rendering moves away from the workspace that enabled temporary retry,
    // rollback immediately so the prior workspace preference is restored.
    const rollbackWorkspaceId = autoRetryRollbackWorkspaceIdRef.current;
    if (!rollbackWorkspaceId || rollbackWorkspaceId === props.workspaceId) {
      return;
    }

    void rollbackAutoRetryIfNeeded();
  }, [props.workspaceId, rollbackAutoRetryIfNeeded]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (!autoRetryRollbackPendingRef.current) {
        return;
      }

      // Teardown-safe rollback: if the tool component unmounts before stream-state
      // transitions fire (workspace switch/removal/app exit), restore preference now.
      void rollbackAutoRetryIfNeeded({ suppressErrors: true });
    };
  }, [rollbackAutoRetryIfNeeded]);

  useEffect(() => {
    if (!autoRetryRollbackPendingRef.current) {
      return;
    }

    const autoRetryStatusType = workspaceState?.autoRetryStatus?.type;
    const autoRetryActive =
      autoRetryStatusType === "auto-retry-scheduled" ||
      autoRetryStatusType === "auto-retry-starting";
    const streamInFlight =
      workspaceState?.isStreamStarting === true || workspaceState?.canInterrupt === true;

    // Wait until the resumed stream has actually reached an in-flight state before
    // considering rollback. This avoids disabling auto-retry immediately after
    // resumeStream() resolves but before the resumed attempt's outcome is known.
    if (autoRetryActive || streamInFlight) {
      autoRetryRollbackArmedRef.current = true;
      return;
    }

    const baselineMessageCount = autoRetryRollbackBaselineMessageCountRef.current;
    const hasObservedPostResumeMessage =
      baselineMessageCount !== null &&
      (workspaceState?.messages.length ?? 0) > baselineMessageCount;
    if (!autoRetryRollbackArmedRef.current && !hasObservedPostResumeMessage) {
      return;
    }

    void rollbackAutoRetryIfNeeded();
  }, [
    rollbackAutoRetryIfNeeded,
    workspaceState?.autoRetryStatus,
    workspaceState?.isStreamStarting,
    workspaceState?.canInterrupt,
    workspaceState?.messages.length,
  ]);
  // After the rollback effects above, so a rollback that just ran in this commit counts as settled.
  useReleaseSettledDockCard({
    rowId: props.rowId,
    isAnswering,
    isSubmitting,
    rollbackPendingRef: autoRetryRollbackPendingRef,
    workspaceState,
  });

  const [draftAnswers, setDraftAnswers] = useState<DraftAnswers>(
    () => cachedState?.draftAnswers ?? createInitialDrafts(props.args.questions, props.args.answers)
  );

  // Sync draft state to cache so it survives workspace switches
  useEffect(() => {
    if (isAnswering) {
      setCachedDraftState(draftStateKey, { draftAnswers, activeIndex });
    } else {
      // Clean up cache once the questions are answered (or the tool failed)
      deleteCachedDraftState(draftStateKey);
    }
  }, [draftStateKey, isAnswering, draftAnswers, activeIndex]);

  const resultUnwrapped = useMemo(() => {
    if (!props.result) {
      return null;
    }

    return unwrapJsonContainer(props.result);
  }, [props.result]);

  const uiOnlyPayload = getToolOutputUiOnly(resultUnwrapped)?.ask_user_question;

  const toolResultPayload =
    uiOnlyPayload ??
    (resultUnwrapped && isAskUserQuestionPayload(resultUnwrapped) ? resultUnwrapped : null);
  // A non-blocking question's tool result carries no answers; they come from the answer message.
  const successResult = isAsyncQuestion ? nonBlocking.answered : toolResultPayload;

  const errorResult =
    resultUnwrapped && isToolErrorResult(resultUnwrapped) ? resultUnwrapped : null;

  const handleSubmit = (): void => {
    setIsSubmitting(true);
    setSubmitError(null);

    let answers: Record<string, string>;
    let workspaceId: string;

    try {
      answers = buildAnswersRecord(props.args.questions, draftAnswers);

      assert(liveApi, "API not connected");
      assert(props.workspaceId, "workspaceId is required");
      workspaceId = props.workspaceId;
      // The composer's barrier: the dock shows open questions before a replay catches up, and a
      // blocking answer resumes the turn, so never answer from a stale copy of the question.
      assert(isTranscriptMutationAllowed(workspaceId), TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setSubmitError(errorMessage);
      setIsSubmitting(false);
      return;
    }

    if (isAsyncQuestion) {
      nonBlocking
        .send(buildAnswerSelections(props.args.questions, draftAnswers), answers)
        .finally(() => {
          setIsSubmitting(false);
        })
        .then(setSubmitError, (error: unknown) => {
          setSubmitError(getErrorMessage(error));
        });
      return;
    }

    liveApi.workspace
      .answerAskUserQuestion({
        workspaceId,
        toolCallId: props.toolCallId,
        answers,
      })
      .then(async (result) => {
        if (!result.success) {
          setSubmitError(result.error);
          return;
        }

        // If the stream was interrupted (e.g. app restart), explicitly resume using
        // the latest persisted send options for this workspace.
        let sendOptions = getSendOptionsFromStorage(workspaceId);
        const lastUserMessage = [...(workspaceState?.messages ?? [])]
          .reverse()
          .find(
            (message): message is Extract<typeof message, { type: "user" }> =>
              message.type === "user"
          );

        if (lastUserMessage?.compactionRequest) {
          sendOptions = applyCompactionOverrides(
            sendOptions,
            lastUserMessage.compactionRequest.parsed
          );
        }

        const enableResult = await liveApi.workspace.setAutoRetryEnabled?.({
          workspaceId,
          enabled: true,
          persist: false,
        });
        if (enableResult && !enableResult.success) {
          setSubmitError(enableResult.error);
          return;
        }

        if (enableResult?.success && enableResult.data.previousEnabled === false) {
          // Ask-user resume temporarily enables auto-retry for this attempt.
          // Roll back only after the resumed stream reaches a terminal outcome.
          if (!isMountedRef.current) {
            await liveApi.workspace.setAutoRetryEnabled?.({
              workspaceId,
              enabled: false,
              persist: false,
            });
          } else {
            autoRetryRollbackWorkspaceIdRef.current = workspaceId;
            autoRetryRollbackPendingRef.current = true;
            autoRetryRollbackArmedRef.current = false;
            autoRetryRollbackBaselineMessageCountRef.current = workspaceState?.messages.length ?? 0;
          }
        }

        const resumeResult = await liveApi.workspace.resumeStream({
          workspaceId,
          options: sendOptions,
        });
        if (!resumeResult.success) {
          const formatted = formatSendMessageError(resumeResult.error);
          const detail = formatted.resolutionHint
            ? `${formatted.message} ${formatted.resolutionHint}`
            : formatted.message;
          setSubmitError(detail);

          // Keep retry preference consistent when resume fails before stream events.
          await rollbackAutoRetryIfNeeded();
          return;
        }

        if (
          autoRetryRollbackPendingRef.current &&
          !autoRetryRollbackArmedRef.current &&
          resumeResult.data.started === false
        ) {
          await rollbackAutoRetryIfNeeded({ suppressErrors: true });
        }
      })
      .catch(async (error) => {
        const errorMessage = getErrorMessage(error);
        setSubmitError(errorMessage);
        await rollbackAutoRetryIfNeeded();
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };
  // The dock only holds questions that take answers; the transcript row shows the outcome. The
  // dock keeps a closed card mounted (rendering nothing) so the auto-retry rollback above still
  // sees the resumed stream settle, as the transcript card did when it owned the form.
  if (props.docked === true && !isAnswering) {
    return null;
  }

  const changeDraft = (
    _groupKey: string,
    question: string,
    update: (draft: DraftAnswer) => DraftAnswer
  ) => {
    setDraftAnswers((prev) => ({ ...prev, [question]: update(prev[question] ?? EMPTY_DRAFT) }));
  };

  return (
    <ToolContainer expanded={expanded}>
      <AskUserQuestionHeader
        expanded={expanded}
        onToggle={toggleExpanded}
        hint={isAnswering ? answeringHints.header : null}
        status={props.status}
      />

      {expanded && (
        <ToolDetails>
          <div className="flex flex-col gap-3">
            {isAnswering ? (
              <AskUserQuestionForm
                groups={[
                  { key: "questions", questions: props.args.questions, drafts: draftAnswers },
                ]}
                activeIndex={activeIndex}
                onActivate={setActiveIndex}
                onDraftChange={changeDraft}
                onSubmit={handleSubmit}
                isSubmitting={isSubmitting}
                submitError={submitError}
                footerHint={answeringHints.footer}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <AnsweredQuestions
                  result={successResult}
                  closedUnanswered={nonBlocking.closedUnanswered}
                />

                {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}
              </div>
            )}
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
