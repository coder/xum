import type { DisplayedMessage } from "@/common/types/message";

/**
 * Upper bound for distinct hidden-gap rows.
 *
 * In transcripts with many tiny omission runs (e.g. alternating user/assistant history),
 * rendering one marker per run can recreate large DOM row counts. We keep locality for
 * recent runs while merging older runs into a single earlier marker when this cap is exceeded.
 */
export const MAX_HISTORY_HIDDEN_SEGMENTS = 8;

interface OmittedMessageCounts {
  tool: number;
  reasoning: number;
}

export interface OmissionSegment {
  insertAtKeptIndex: number;
  hiddenCount: number;
  omittedMessageCounts: OmittedMessageCounts;
}

export interface TranscriptTruncationPlan {
  rows: DisplayedMessage[];
  hiddenCount: number;
  segments: OmissionSegment[];
}

export interface BuildTranscriptTruncationPlanArgs {
  displayedMessages: DisplayedMessage[];
  maxDisplayedMessages: number;
  alwaysKeepMessageTypes: Set<DisplayedMessage["type"]>;
  /** Preserve a specific old row (for example a Timeline reveal) without disabling the DOM cap. */
  shouldAlwaysKeepMessage?: (message: DisplayedMessage) => boolean;
  maxHiddenSegments?: number;
}

interface CollectedOmissions {
  keptOldMessages: DisplayedMessage[];
  segments: OmissionSegment[];
  hiddenCount: number;
}

interface OmissionRunState {
  insertAtKeptIndex: number;
  hiddenCount: number;
  omittedMessageCounts: OmittedMessageCounts;
}

function collectOmissions(
  oldMessages: DisplayedMessage[],
  alwaysKeepMessageTypes: Set<DisplayedMessage["type"]>,
  shouldAlwaysKeepMessage?: (message: DisplayedMessage) => boolean
): CollectedOmissions {
  const keptOldMessages: DisplayedMessage[] = [];
  const segments: OmissionSegment[] = [];
  let hiddenCount = 0;
  let activeRun: OmissionRunState | null = null;

  for (const message of oldMessages) {
    if (alwaysKeepMessageTypes.has(message.type) || shouldAlwaysKeepMessage?.(message) === true) {
      if (activeRun !== null) {
        segments.push(activeRun);
        activeRun = null;
      }
      keptOldMessages.push(message);
      continue;
    }

    activeRun ??= {
      insertAtKeptIndex: keptOldMessages.length,
      hiddenCount: 0,
      omittedMessageCounts: { tool: 0, reasoning: 0 },
    };

    activeRun.hiddenCount += 1;
    hiddenCount += 1;

    if (message.type === "tool") {
      activeRun.omittedMessageCounts.tool += 1;
    } else if (message.type === "reasoning") {
      activeRun.omittedMessageCounts.reasoning += 1;
    }
  }

  if (activeRun !== null) {
    segments.push(activeRun);
  }

  return { keptOldMessages, segments, hiddenCount };
}

function mergeOmissionSegments(segments: OmissionSegment[]): OmissionSegment {
  const first = segments[0];
  let hiddenCount = 0;
  let toolCount = 0;
  let reasoningCount = 0;

  for (const segment of segments) {
    hiddenCount += segment.hiddenCount;
    toolCount += segment.omittedMessageCounts.tool;
    reasoningCount += segment.omittedMessageCounts.reasoning;
  }

  return {
    insertAtKeptIndex: first?.insertAtKeptIndex ?? 0,
    hiddenCount,
    omittedMessageCounts: {
      tool: toolCount,
      reasoning: reasoningCount,
    },
  };
}

function capOmissionSegments(
  segments: OmissionSegment[],
  maxHiddenSegments: number
): OmissionSegment[] {
  const normalizedMax = Number.isFinite(maxHiddenSegments)
    ? Math.max(1, Math.trunc(maxHiddenSegments))
    : 1;
  if (segments.length <= normalizedMax) {
    return segments;
  }

  const mergedPrefixCount = segments.length - normalizedMax + 1;
  const mergedPrefix = mergeOmissionSegments(segments.slice(0, mergedPrefixCount));
  return [mergedPrefix, ...segments.slice(mergedPrefixCount)];
}

function renderKeptRowsWithMarkers(
  keptOldMessages: DisplayedMessage[],
  segments: OmissionSegment[]
): DisplayedMessage[] {
  if (segments.length === 0) {
    return [...keptOldMessages];
  }

  const rows: DisplayedMessage[] = [];
  let segmentIndex = 0;

  for (let keptIndex = 0; keptIndex <= keptOldMessages.length; keptIndex++) {
    while (
      segmentIndex < segments.length &&
      segments[segmentIndex]?.insertAtKeptIndex === keptIndex
    ) {
      const segment = segments[segmentIndex];
      const omittedMessageCounts =
        segment.omittedMessageCounts.tool > 0 || segment.omittedMessageCounts.reasoning > 0
          ? segment.omittedMessageCounts
          : undefined;

      rows.push({
        type: "history-hidden",
        id: `history-hidden-${segmentIndex + 1}`,
        hiddenCount: segment.hiddenCount,
        historySequence: -1,
        omittedMessageCounts,
      });

      segmentIndex += 1;
    }

    if (keptIndex < keptOldMessages.length) {
      rows.push(keptOldMessages[keptIndex]);
    }
  }

  return rows;
}

/**
 * Build displayed transcript rows for truncated history.
 *
 * Strategy:
 * - Keep recent rows intact (last N rows)
 * - In older rows, preserve only always-keep message types
 * - Replace each omitted run with an explicit history-hidden marker row
 * - Cap marker count to avoid re-creating huge DOM row counts for tiny alternating runs
 */
export function buildTranscriptTruncationPlan(
  args: BuildTranscriptTruncationPlanArgs
): TranscriptTruncationPlan {
  if (
    args.maxDisplayedMessages <= 0 ||
    args.displayedMessages.length <= args.maxDisplayedMessages
  ) {
    return {
      rows: args.displayedMessages,
      hiddenCount: 0,
      segments: [],
    };
  }

  const recentMessages = args.displayedMessages.slice(-args.maxDisplayedMessages);
  const oldMessages = args.displayedMessages.slice(0, -args.maxDisplayedMessages);

  const omissionCollection = collectOmissions(
    oldMessages,
    args.alwaysKeepMessageTypes,
    args.shouldAlwaysKeepMessage
  );
  if (omissionCollection.hiddenCount === 0) {
    return {
      rows: [...omissionCollection.keptOldMessages, ...recentMessages],
      hiddenCount: 0,
      segments: [],
    };
  }

  const cappedSegments = capOmissionSegments(
    omissionCollection.segments,
    args.maxHiddenSegments ?? MAX_HISTORY_HIDDEN_SEGMENTS
  );

  const rows = [
    ...renderKeptRowsWithMarkers(omissionCollection.keptOldMessages, cappedSegments),
    ...recentMessages,
  ];

  return {
    rows,
    hiddenCount: omissionCollection.hiddenCount,
    segments: cappedSegments,
  };
}
