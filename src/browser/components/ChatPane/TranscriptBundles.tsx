import React, { useMemo, useState } from "react";
import { WorkBundleMessage } from "@/browser/features/Messages/WorkBundleMessage";
import { OperationalBundleMessage } from "@/browser/features/Messages/OperationalBundleMessage";
import {
  computeOperationalBundleInfos,
  computeWorkBundleInfos,
  type OperationalBundleInfo,
  type WorkBundleInfo,
} from "@/browser/utils/messages/transcriptRenderProjection";
import type { TranscriptDensity } from "@/common/constants/storage";
import type { DisplayedMessage } from "@/common/types/message";

// Work bundles (hyper density) and operational bundles (e.g. collapsed task_await polls),
// shared by the desktop ChatPane and the VS Code webview (#4979) so both collapse the same rows.

function findTailProposePlanToolId(messages: readonly DisplayedMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== "tool") {
      continue;
    }
    return message.toolName === "propose_plan" ? message.id : null;
  }

  return null;
}

const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

interface BundleExpansionOverrides {
  workspaceId: string;
  work: ReadonlyMap<string, boolean>;
  operational: ReadonlyMap<string, boolean>;
}

export interface TranscriptBundles {
  /** Indexed like the full message array; undefined outside hyper density. */
  workBundleInfos: Array<WorkBundleInfo | undefined> | undefined;
  /** Indexed like the full message array. */
  operationalBundleInfos: Array<OperationalBundleInfo | undefined>;
  workBundleExpansionOverrides: ReadonlyMap<string, boolean>;
  operationalBundleExpansionOverrides: ReadonlyMap<string, boolean>;
  tailProposePlanWorkBundleKey: string | null;
  tailProposePlanOperationalBundleKey: string | null;
  setWorkBundleExpanded: (key: string, expanded: boolean) => void;
  setOperationalBundleExpanded: (key: string, expanded: boolean) => void;
}

export function useTranscriptBundles(params: {
  workspaceId: string;
  messages: DisplayedMessage[];
  transcriptDensity: TranscriptDensity;
  isTurnActive: boolean;
}): TranscriptBundles {
  const { workspaceId, messages, transcriptDensity, isTurnActive } = params;

  // Expansion choices belong to one workspace's transcript: the overrides are stored with their
  // workspace and read as empty for any other, so a switch never renders the previous
  // workspace's choices (forked transcripts share bundle keys), not even for the frame an
  // effect-based reset would leave.
  const [bundleExpansion, setBundleExpansion] = useState<BundleExpansionOverrides>(() => ({
    workspaceId,
    work: EMPTY_OVERRIDES,
    operational: EMPTY_OVERRIDES,
  }));
  const isCurrentWorkspace = bundleExpansion.workspaceId === workspaceId;
  if (!isCurrentWorkspace) {
    // Choices are per visit: drop the stored overrides on switch (render-phase update, React
    // re-renders before committing), else returning to the earlier workspace would restore them.
    setBundleExpansion({ workspaceId, work: EMPTY_OVERRIDES, operational: EMPTY_OVERRIDES });
  }
  const workBundleExpansionOverrides = isCurrentWorkspace ? bundleExpansion.work : EMPTY_OVERRIDES;
  const operationalBundleExpansionOverrides = isCurrentWorkspace
    ? bundleExpansion.operational
    : EMPTY_OVERRIDES;

  const workBundleInfos = useMemo(
    () => (transcriptDensity === "hyper" ? computeWorkBundleInfos(messages) : undefined),
    [messages, transcriptDensity]
  );

  const operationalBundleInfos = useMemo(
    () =>
      computeOperationalBundleInfos(messages, {
        isTurnActive,
        taskAwaitPollsOnly: transcriptDensity !== "hyper",
      }),
    [isTurnActive, messages, transcriptDensity]
  );

  // A tail propose_plan usually means the agent paused for user review; reveal only the
  // containing hyper-density bundles by default so historical plans stay collapsed.
  const tailProposePlanToolId =
    transcriptDensity === "hyper" ? findTailProposePlanToolId(messages) : null;
  const tailProposePlanIndex =
    tailProposePlanToolId === null
      ? -1
      : messages.findIndex((message) => message.id === tailProposePlanToolId);
  const tailProposePlanWorkBundleKey =
    tailProposePlanIndex === -1 ? null : (workBundleInfos?.[tailProposePlanIndex]?.key ?? null);
  const tailProposePlanOperationalBundleKey =
    tailProposePlanIndex === -1
      ? null
      : (operationalBundleInfos?.[tailProposePlanIndex]?.key ?? null);

  const updateBundleExpansion = (kind: "work" | "operational", key: string, expanded: boolean) => {
    setBundleExpansion((current) => {
      const base: BundleExpansionOverrides =
        current.workspaceId === workspaceId
          ? current
          : { workspaceId, work: EMPTY_OVERRIDES, operational: EMPTY_OVERRIDES };
      const overrides = new Map(base[kind]).set(key, expanded);
      return kind === "work" ? { ...base, work: overrides } : { ...base, operational: overrides };
    });
  };

  const setWorkBundleExpanded = (key: string, expanded: boolean) => {
    updateBundleExpansion("work", key, expanded);
  };

  const setOperationalBundleExpanded = (key: string, expanded: boolean) => {
    updateBundleExpansion("operational", key, expanded);
  };

  return {
    workBundleInfos,
    operationalBundleInfos,
    workBundleExpansionOverrides,
    operationalBundleExpansionOverrides,
    tailProposePlanWorkBundleKey,
    tailProposePlanOperationalBundleKey,
    setWorkBundleExpanded,
    setOperationalBundleExpanded,
  };
}

export type RenderTranscriptMessageAtIndex = (
  message: DisplayedMessage,
  index: number,
  options: { key: string; className?: string }
) => React.ReactNode;

/**
 * Renders a contiguous range of transcript rows with their bundles. `messages` starts at
 * `indexOffset` of the array the bundle infos were computed over; the host renders each row.
 */
export function TranscriptBundleRows(props: {
  workspaceId: string;
  messages: readonly DisplayedMessage[];
  indexOffset: number;
  bundles: TranscriptBundles;
  renderMessageAtIndex: RenderTranscriptMessageAtIndex;
}) {
  const {
    workBundleInfos,
    operationalBundleInfos,
    workBundleExpansionOverrides,
    operationalBundleExpansionOverrides,
    tailProposePlanWorkBundleKey,
    tailProposePlanOperationalBundleKey,
    setWorkBundleExpanded,
    setOperationalBundleExpanded,
  } = props.bundles;
  const workspaceId = props.workspaceId;
  const renderMessageAtIndex = props.renderMessageAtIndex;

  const rows = props.messages.map((msg, revealOffset) => {
    const index = props.indexOffset + revealOffset;
    const workBundle = workBundleInfos?.[index];
    const operationalBundle = workBundle ? undefined : operationalBundleInfos?.[index];
    const workBundleOverride = workBundle
      ? workBundleExpansionOverrides.get(workBundle.key)
      : undefined;
    const defaultRevealTailPlanWorkBundle =
      tailProposePlanWorkBundleKey !== null && workBundle?.key === tailProposePlanWorkBundleKey;
    const isWorkBundleExpanded = workBundle
      ? (workBundleOverride ?? (defaultRevealTailPlanWorkBundle || workBundle.defaultExpanded))
      : false;

    const keepCollapsedWorkBundleMemberVisible =
      msg.type === "user" || (msg.type === "assistant" && workBundle?.position === "final");
    if (
      (workBundle?.position === "member" || workBundle?.position === "final") &&
      (isWorkBundleExpanded || !keepCollapsedWorkBundleMemberVisible)
    ) {
      return null;
    }

    const renderWorkBundle = workBundle?.position === "head";
    const renderMessageBeforeWorkBundle = renderWorkBundle && msg.type === "user";
    const renderMessageAfterWorkBundle = !renderWorkBundle;
    const operationalBundleOverride = operationalBundle
      ? operationalBundleExpansionOverrides.get(operationalBundle.key)
      : undefined;
    const defaultRevealTailPlanOperationalBundle =
      tailProposePlanOperationalBundleKey !== null &&
      operationalBundle?.key === tailProposePlanOperationalBundleKey;
    const isOperationalBundleExpanded = operationalBundle
      ? operationalBundle.summary.tone !== undefined ||
        (operationalBundleOverride ??
          (defaultRevealTailPlanOperationalBundle || operationalBundle.defaultExpanded))
      : false;

    if (operationalBundle?.position === "member" && !isOperationalBundleExpanded) {
      return null;
    }

    const renderOperationalBundle = operationalBundle?.position === "head";
    const renderMessageAfterOperationalBundle =
      renderMessageAfterWorkBundle && (!renderOperationalBundle || isOperationalBundleExpanded);

    return (
      <React.Fragment key={`${workspaceId}:${msg.id}`}>
        {renderMessageBeforeWorkBundle &&
          renderMessageAtIndex(msg, index, {
            key: `${workspaceId}:${msg.id}:message`,
          })}
        {renderWorkBundle && workBundle && (
          <WorkBundleMessage
            item={workBundle}
            expanded={isWorkBundleExpanded}
            onToggle={() => setWorkBundleExpanded(workBundle.key, !isWorkBundleExpanded)}
          />
        )}
        {renderWorkBundle &&
          workBundle &&
          isWorkBundleExpanded &&
          workBundle.entries.map((entry) => {
            const nestedOperationalBundle = operationalBundleInfos?.[entry.originalIndex];
            const nestedOverride = nestedOperationalBundle
              ? operationalBundleExpansionOverrides.get(nestedOperationalBundle.key)
              : undefined;
            const defaultRevealTailPlanNestedBundle =
              tailProposePlanOperationalBundleKey !== null &&
              nestedOperationalBundle?.key === tailProposePlanOperationalBundleKey;
            const isNestedExpanded = nestedOperationalBundle
              ? nestedOperationalBundle.summary.tone !== undefined ||
                (nestedOverride ??
                  (defaultRevealTailPlanNestedBundle || nestedOperationalBundle.defaultExpanded))
              : false;

            if (nestedOperationalBundle?.position === "member" && !isNestedExpanded) {
              return null;
            }

            const renderNestedBundle = nestedOperationalBundle?.position === "head";
            const renderNestedMessage = !renderNestedBundle || isNestedExpanded;

            return (
              <React.Fragment key={`${workspaceId}:${workBundle.key}:${entry.message.id}`}>
                {renderNestedBundle && nestedOperationalBundle && (
                  <OperationalBundleMessage
                    item={nestedOperationalBundle}
                    expanded={isNestedExpanded}
                    onToggle={() =>
                      setOperationalBundleExpanded(nestedOperationalBundle.key, !isNestedExpanded)
                    }
                  />
                )}
                {renderNestedMessage &&
                  renderMessageAtIndex(entry.message, entry.originalIndex, {
                    key: `${workspaceId}:${workBundle.key}:${entry.message.id}:message`,
                  })}
              </React.Fragment>
            );
          })}
        {renderOperationalBundle && operationalBundle && (
          <OperationalBundleMessage
            item={operationalBundle}
            expanded={isOperationalBundleExpanded}
            onToggle={() =>
              setOperationalBundleExpanded(operationalBundle.key, !isOperationalBundleExpanded)
            }
          />
        )}
        {renderMessageAfterOperationalBundle &&
          renderMessageAtIndex(msg, index, {
            key: `${workspaceId}:${msg.id}:message`,
            className: operationalBundle ? "ml-4" : undefined,
          })}
      </React.Fragment>
    );
  });

  return <>{rows}</>;
}
