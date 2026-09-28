import { useMemo, useState } from "react";
import type { UserMessageNavigation } from "@/browser/features/Messages/UserMessage";
import {
  computeBashOutputGroupInfos,
  type BashOutputGroupInfo,
} from "@/browser/utils/messages/messageUtils";
import {
  computeTaskReportLinking,
  type TaskReportLinking,
} from "@/browser/utils/messages/taskReportLinking";
import type { DisplayedMessage } from "@/common/types/message";

// Row props ChatPane derives over the whole transcript (bash_output grouping, task report
// linking, prompt navigation), shared with the VS Code webview (#5002) so both render them alike.

const EMPTY_GROUPS: ReadonlySet<string> = new Set();

export interface TranscriptRowDerivations {
  /** Indexed like the full message array. */
  bashOutputGroupInfos: Array<BashOutputGroupInfo | undefined>;
  /** Expanded bash_output groups, keyed by the group's first message ID. */
  expandedBashGroups: ReadonlySet<string>;
  expandBashGroup: (groupKey: string) => void;
  toggleBashOutputGroup: (groupKey: string) => void;
  taskReportLinking: TaskReportLinking;
}

export function useTranscriptRowDerivations(params: {
  workspaceId: string;
  messages: DisplayedMessage[];
}): TranscriptRowDerivations {
  const { workspaceId, messages } = params;

  // Track which bash_output groups are expanded (keyed by first message ID). Expansion choices
  // belong to one workspace's transcript: the set is stored with its workspace and reads as empty
  // for any other, so a switch never renders the previous workspace's choices (forked transcripts
  // share message IDs), not even for the frame an effect-based reset would leave.
  const [bashGroupExpansion, setBashGroupExpansion] = useState<{
    workspaceId: string;
    groups: ReadonlySet<string>;
  }>(() => ({ workspaceId, groups: EMPTY_GROUPS }));
  const expandedBashGroups =
    bashGroupExpansion.workspaceId === workspaceId ? bashGroupExpansion.groups : EMPTY_GROUPS;

  const taskReportLinking = useMemo(() => computeTaskReportLinking(messages), [messages]);

  // Precompute bash_output grouping once per message snapshot so row rendering stays O(n).
  const bashOutputGroupInfos = useMemo(() => computeBashOutputGroupInfos(messages), [messages]);

  const updateBashGroups = (update: (groups: Set<string>) => void) => {
    setBashGroupExpansion((current) => {
      const groups = new Set(current.workspaceId === workspaceId ? current.groups : EMPTY_GROUPS);
      update(groups);
      return { workspaceId, groups };
    });
  };

  const expandBashGroup = (groupKey: string) => {
    updateBashGroups((groups) => groups.add(groupKey));
  };

  const toggleBashOutputGroup = (groupKey: string) => {
    updateBashGroups((groups) => {
      if (!groups.delete(groupKey)) {
        groups.add(groupKey);
      }
    });
  };

  return {
    bashOutputGroupInfos,
    expandedBashGroups,
    expandBashGroup,
    toggleBashOutputGroup,
    taskReportLinking,
  };
}

/**
 * Prev/next navigation between human prompts, keyed by historyId; null with fewer than two.
 * Separate from useTranscriptRowDerivations because ChatPane's navigate handler depends on
 * useAutoScroll, which runs after the reveal that needs the bash_output groups.
 */
export function useUserMessageNavigation(params: {
  messages: DisplayedMessage[];
  onNavigateToMessage: (historyId: string) => void;
}): ReadonlyMap<string, UserMessageNavigation> | null {
  const { messages, onNavigateToMessage } = params;

  // Precompute per-user navigation objects so MessageRenderer rows receive stable prop
  // references across non-message updates (usage bumps, stats updates, etc.).
  return useMemo(() => {
    const userHistoryIds: string[] = [];
    for (const message of messages) {
      // Machine wakes and budget warnings should not interrupt navigation between human prompts.
      if (
        message.type === "user" &&
        message.isPendingSend == null &&
        message.bashMonitorWake == null &&
        message.agentPeerMessageTrigger == null &&
        message.contextBudgetWarning == null
      ) {
        userHistoryIds.push(message.historyId);
      }
    }

    if (userHistoryIds.length < 2) {
      return null;
    }

    const navigationByHistoryId = new Map<string, UserMessageNavigation>();
    for (let index = 0; index < userHistoryIds.length; index++) {
      navigationByHistoryId.set(userHistoryIds[index], {
        prevUserMessageId: index > 0 ? userHistoryIds[index - 1] : undefined,
        nextUserMessageId:
          index < userHistoryIds.length - 1 ? userHistoryIds[index + 1] : undefined,
        onNavigate: onNavigateToMessage,
      });
    }

    return navigationByHistoryId;
  }, [messages, onNavigateToMessage]);
}

/** The mounted row for a historyId (MessageRenderer tags rows with data-message-id). */
export function findTranscriptMessageElement(
  scrollContainer: HTMLElement,
  historyId: string
): HTMLElement | undefined {
  return Array.from(scrollContainer.querySelectorAll<HTMLElement>("[data-message-id]")).find(
    (element) => element.getAttribute("data-message-id") === historyId
  );
}

export interface TranscriptRowProps {
  /** A middle row of a collapsed bash_output group renders nothing. */
  hidden: boolean;
  bashOutputGroup: BashOutputGroupInfo | undefined;
  /** Set when the row belongs to a bash_output group; the first row renders its indicator. */
  bashGroupKey: string | undefined;
  isBashGroupExpanded: boolean;
  taskReportLinking: TaskReportLinking | undefined;
  userMessageNavigation: UserMessageNavigation | undefined;
}

/** Per-row MessageRenderer props from the whole-transcript derivations above. */
export function getTranscriptRowProps(params: {
  derivations: TranscriptRowDerivations;
  userMessageNavigationByHistoryId: ReadonlyMap<string, UserMessageNavigation> | null;
  messages: readonly DisplayedMessage[];
  message: DisplayedMessage;
  index: number;
}): TranscriptRowProps {
  const { derivations, message } = params;
  const bashOutputGroup = derivations.bashOutputGroupInfos[params.index];
  const bashGroupKey = bashOutputGroup
    ? params.messages[bashOutputGroup.firstIndex]?.id
    : undefined;
  const isBashGroupExpanded = bashGroupKey
    ? derivations.expandedBashGroups.has(bashGroupKey)
    : false;

  return {
    hidden: bashOutputGroup?.position === "middle" && !isBashGroupExpanded,
    bashOutputGroup,
    bashGroupKey,
    isBashGroupExpanded,
    taskReportLinking:
      message.type === "tool" && (message.toolName === "task" || message.toolName === "task_await")
        ? derivations.taskReportLinking
        : undefined,
    userMessageNavigation:
      message.type === "user"
        ? params.userMessageNavigationByHistoryId?.get(message.historyId)
        : undefined,
  };
}
