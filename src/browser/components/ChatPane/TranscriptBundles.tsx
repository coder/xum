import React, { useMemo, useState } from "react";
import { WorkBundleMessage } from "@/browser/features/Messages/WorkBundleMessage";
import { OperationalBundleMessage } from "@/browser/features/Messages/OperationalBundleMessage";
import { TOOL_RAIL_CLASS } from "@/browser/features/Tools/Shared/ToolPrimitives";
import {
  computeOperationalBundleInfos,
  computeWorkBundleInfos,
  type OperationalBundleInfo,
  type WorkBundleInfo,
} from "@/browser/utils/messages/transcriptRenderProjection";
import type { TranscriptDensity } from "@/common/constants/storage";
import type { DisplayedMessage } from "@/common/types/message";

// Work bundles (compact density: a turn's work behind one line) and operational bundles (runs of
// routine tool calls), shared by the desktop ChatPane and the VS Code webview (#4979) so both
// fold the same rows.

const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

interface BundleExpansionOverrides {
  workspaceId: string;
  work: ReadonlyMap<string, boolean>;
  operational: ReadonlyMap<string, boolean>;
}

export interface TranscriptBundles {
  /** Indexed like the full message array; undefined in detailed density. */
  workBundleInfos: Array<WorkBundleInfo | undefined> | undefined;
  /** Indexed like the full message array. */
  operationalBundleInfos: Array<OperationalBundleInfo | undefined>;
  workBundleExpansionOverrides: ReadonlyMap<string, boolean>;
  operationalBundleExpansionOverrides: ReadonlyMap<string, boolean>;
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

  // The stored value "hyper" is the compact density (see TRANSCRIPT_DENSITIES).
  const workBundleInfos = useMemo(
    () =>
      transcriptDensity === "hyper"
        ? computeWorkBundleInfos(messages, { isTurnActive })
        : undefined,
    [isTurnActive, messages, transcriptDensity]
  );

  const operationalBundleInfos = useMemo(
    () => computeOperationalBundleInfos(messages, { isTurnActive }),
    [isTurnActive, messages]
  );

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
    setWorkBundleExpanded,
    setOperationalBundleExpanded,
  } = props.bundles;
  const workspaceId = props.workspaceId;
  const renderMessageAtIndex = props.renderMessageAtIndex;

  // The steps of an opened work line hang off one rail, like the members of an opened run, so
  // the eye can see where the turn's work ends and its reply begins. Consecutive steps share
  // one container (not a rail segment each): their margins then collapse as they do outside
  // it, and the rail is one unbroken line.
  const rows: React.ReactNode[] = [];
  let openSteps: { key: string; bundleKey: string; nodes: React.ReactNode[] } | undefined;
  const closeSteps = () => {
    if (openSteps !== undefined) {
      rows.push(
        <div key={openSteps.key} data-testid="work-bundle-steps" className={TOOL_RAIL_CLASS}>
          {openSteps.nodes}
        </div>
      );
      openSteps = undefined;
    }
  };

  props.messages.forEach((msg, revealOffset) => {
    const index = props.indexOffset + revealOffset;
    const rowKey = `${workspaceId}:${msg.id}`;
    const workBundle = workBundleInfos?.[index];
    // A work line is closed until the user opens it. A live turn is not opened for them: it
    // shows its latest step through the fold instead (see computeWorkBundleInfos).
    const isWorkBundleExpanded =
      workBundle !== undefined && (workBundleExpansionOverrides.get(workBundle.key) ?? false);
    // The work line sits above the stretch's first row. ChatPane only cuts the tail-first reveal
    // at such a row, so a mounted stretch always has its line.
    if (workBundle?.headIndex === index) {
      closeSteps();
      rows.push(
        <WorkBundleMessage
          key={`${rowKey}:work-line`}
          item={workBundle}
          expanded={isWorkBundleExpanded}
          onToggle={() => setWorkBundleExpanded(workBundle.key, !isWorkBundleExpanded)}
        />
      );
    }
    const showsThroughFold = workBundle !== undefined && !isWorkBundleExpanded;
    if (showsThroughFold && !workBundle.visibleWhenFolded) {
      return;
    }

    // A work row that shows through a closed work line stands alone: the run of routine calls
    // it belongs to is folded away with the rest of the work.
    const operationalBundle =
      showsThroughFold && workBundle.role === "work" ? undefined : operationalBundleInfos?.[index];
    const operationalBundleOverride = operationalBundle
      ? operationalBundleExpansionOverrides.get(operationalBundle.key)
      : undefined;
    const isOperationalBundleExpanded = operationalBundle
      ? operationalBundle.summary.tone !== undefined ||
        (operationalBundleOverride ?? operationalBundle.defaultExpanded)
      : false;

    if (operationalBundle?.position === "member" && !isOperationalBundleExpanded) {
      return;
    }

    const renderOperationalBundle = operationalBundle?.position === "head";
    const row = (
      <React.Fragment key={rowKey}>
        {renderOperationalBundle && operationalBundle && (
          <OperationalBundleMessage
            item={operationalBundle}
            expanded={isOperationalBundleExpanded}
            onToggle={() =>
              setOperationalBundleExpanded(operationalBundle.key, !isOperationalBundleExpanded)
            }
          />
        )}
        {(!renderOperationalBundle || isOperationalBundleExpanded) &&
          renderMessageAtIndex(msg, index, {
            key: `${rowKey}:message`,
            // Open bundle members hang off the shared rail under the summary line's chevron,
            // like the calls under a script header.
            // `flow-root` keeps each row's 8px margins inside its rail segment, so the rail is
            // one unbroken line. Neighbouring segments' negative margins collapse to one, so
            // `-my-3` overlaps them by 12px: the 4px left between rows is the gap the calls
            // under a script have, giving every opened list the same pitch.
            className: operationalBundle ? `${TOOL_RAIL_CLASS} flow-root -my-3` : undefined,
          })}
      </React.Fragment>
    );

    if (!isWorkBundleExpanded || workBundle?.role !== "work") {
      closeSteps();
      rows.push(row);
      return;
    }
    if (openSteps?.bundleKey !== workBundle.key) {
      closeSteps();
      // Keyed by its first step, which holds while a live turn appends steps after it.
      openSteps = { key: `${rowKey}:steps`, bundleKey: workBundle.key, nodes: [] };
    }
    openSteps.nodes.push(row);
  });
  closeSteps();

  return <>{rows}</>;
}
