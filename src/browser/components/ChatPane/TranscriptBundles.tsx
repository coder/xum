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

// Work bundles (compact density: the steps between two things the agent wrote, behind one line)
// and operational bundles (detailed density: runs of routine tool calls), shared by the desktop
// ChatPane and the VS Code webview (#4979) so both fold the same rows.

const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map();
const NO_OPERATIONAL_BUNDLES: Array<OperationalBundleInfo | undefined> = [];

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
  /** Tool calls that wait for the user's approval; their rows never fold (hosts that have any). */
  approvalToolCallIds?: ReadonlySet<string>;
}): TranscriptBundles {
  const { workspaceId, messages, transcriptDensity, isTurnActive, approvalToolCallIds } = params;

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
        ? computeWorkBundleInfos(messages, { isTurnActive, approvalToolCallIds })
        : undefined,
    [approvalToolCallIds, isTurnActive, messages, transcriptDensity]
  );

  const operationalBundleInfos = useMemo(
    // Compact density folds every step behind a work line, and an opened line lists its steps
    // one by one: a second fold inside it would be one more thing to open.
    () =>
      workBundleInfos === undefined
        ? computeOperationalBundleInfos(messages, { isTurnActive })
        : NO_OPERATIONAL_BUNDLES,
    [isTurnActive, messages, workBundleInfos]
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
 * One stretch of folded steps: its line, then the opened steps on a rail under it (so the eye
 * sees where they end and the agent's text begins), or under a closed line the rows that show
 * through. The block bounds where the opened line sticks (see WorkBundleMessage). The agent's
 * text right after it sits close: the line and the text it leads to read as one.
 */
function WorkBlock(props: {
  item: WorkBundleInfo;
  expanded: boolean;
  /** False when the mounted range starts inside the stretch, below its line. */
  showsLine: boolean;
  onToggle: () => void;
  children: React.ReactNode[];
}) {
  return (
    <div data-testid="work-bundle-block" className="my-2 [&+*>[data-message-block]]:mt-2">
      {props.showsLine && (
        <WorkBundleMessage item={props.item} expanded={props.expanded} onToggle={props.onToggle} />
      )}
      {props.expanded ? (
        <div data-testid="work-bundle-steps" className={TOOL_RAIL_CLASS}>
          {props.children}
        </div>
      ) : (
        props.children
      )}
    </div>
  );
}

// Open bundle members hang off the shared rail under the summary line's chevron, like the
// calls under a script header. `flow-root` keeps each row's 8px margins inside its rail
// segment, so the rail is one unbroken line. Neighbouring segments' negative margins collapse
// to one, so `-my-3` overlaps them by 12px: the 4px left between rows is the gap the calls
// under a script have, giving every opened list the same pitch.
const RUN_MEMBER_CLASS = `${TOOL_RAIL_CLASS} flow-root -my-3`;

/** Whether a run of routine calls shows its members: a failed run always does. */
function isRunExpanded(
  operationalBundle: OperationalBundleInfo,
  overrides: ReadonlyMap<string, boolean>
): boolean {
  return (
    operationalBundle.summary.tone !== undefined ||
    (overrides.get(operationalBundle.key) ?? operationalBundle.defaultExpanded)
  );
}

/** A row outside any work line: on its own, or as the head or a member of a run of routine calls. */
function renderRunRow(args: {
  message: DisplayedMessage;
  index: number;
  rowKey: string;
  bundles: TranscriptBundles;
  renderMessageAtIndex: RenderTranscriptMessageAtIndex;
}): React.ReactNode {
  const renderMessage = (className?: string) =>
    args.renderMessageAtIndex(args.message, args.index, {
      key: `${args.rowKey}:message`,
      className,
    });
  const operationalBundle = args.bundles.operationalBundleInfos[args.index];
  if (operationalBundle === undefined) {
    return <React.Fragment key={args.rowKey}>{renderMessage()}</React.Fragment>;
  }

  const isExpanded = isRunExpanded(
    operationalBundle,
    args.bundles.operationalBundleExpansionOverrides
  );
  const member = isExpanded ? renderMessage(RUN_MEMBER_CLASS) : null;
  if (operationalBundle.position === "member") {
    return <React.Fragment key={args.rowKey}>{member}</React.Fragment>;
  }
  return (
    <React.Fragment key={args.rowKey}>
      <OperationalBundleMessage
        item={operationalBundle}
        expanded={isExpanded}
        onToggle={() =>
          args.bundles.setOperationalBundleExpanded(operationalBundle.key, !isExpanded)
        }
      />
      {member}
    </React.Fragment>
  );
}

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
  const { workBundleInfos, workBundleExpansionOverrides, setWorkBundleExpanded } = props.bundles;
  const renderMessageAtIndex = props.renderMessageAtIndex;

  const rows: React.ReactNode[] = [];
  // The stretch being collected. A work line is closed until the user opens it. A live stretch
  // is not opened for them: its line names its latest step instead (see computeWorkBundleInfos).
  let block:
    | { key: string; item: WorkBundleInfo; expanded: boolean; showsLine: boolean }
    | undefined;
  let blockRows: React.ReactNode[] = [];
  const closeBlock = () => {
    if (block === undefined) {
      return;
    }
    const { key, item, expanded, showsLine } = block;
    // Nothing to mount: a range that starts below a closed line shows none of its steps.
    if (showsLine || blockRows.length > 0) {
      rows.push(
        <WorkBlock
          // Keyed by its first row, which holds while a live stretch appends steps after it.
          key={key}
          item={item}
          expanded={expanded}
          showsLine={showsLine}
          onToggle={() => setWorkBundleExpanded(item.key, !expanded)}
        >
          {blockRows}
        </WorkBlock>
      );
    }
    block = undefined;
    blockRows = [];
  };

  props.messages.forEach((message, revealOffset) => {
    const index = props.indexOffset + revealOffset;
    const rowKey = `${props.workspaceId}:${message.id}`;
    const workBundle = workBundleInfos?.[index];
    if (workBundle === undefined) {
      closeBlock();
      rows.push(
        renderRunRow({ message, index, rowKey, bundles: props.bundles, renderMessageAtIndex })
      );
      return;
    }

    if (block?.item.key !== workBundle.key) {
      closeBlock();
      block = {
        key: `${rowKey}:work`,
        item: workBundle,
        expanded: workBundleExpansionOverrides.get(workBundle.key) ?? false,
        // The line sits above the stretch's first row. ChatPane only cuts the tail-first reveal
        // at such a row, so a mounted stretch always has its line.
        showsLine: workBundle.headIndex === index,
      };
    }
    if (block.expanded || workBundle.visibleWhenFolded) {
      blockRows.push(renderMessageAtIndex(message, index, { key: `${rowKey}:message` }));
    }
  });
  closeBlock();

  return <>{rows}</>;
}
