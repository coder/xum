import React from "react";
import type {
  ChatInputDecorationStackItem,
  LayoutStackLaneKind,
  TranscriptTailStackItem,
} from "./layoutStack";

interface LayoutStackLaneConfig {
  dataComponent: string;
  overflowAnchor?: "none";
}

const LAYOUT_STACK_LANE_CONFIG: Record<LayoutStackLaneKind, LayoutStackLaneConfig> = {
  "transcript-tail": {
    dataComponent: "TranscriptTailStack",
    overflowAnchor: "none",
  },
  "composer-decoration": {
    dataComponent: "ChatInputDecorationStack",
  },
};

const NO_ANCHOR_STYLE: React.CSSProperties = { overflowAnchor: "none" };

interface TranscriptTailStackLaneProps {
  items: readonly TranscriptTailStackItem[];
}

interface ChatInputDecorationStackLaneProps {
  items: readonly ChatInputDecorationStackItem[];
}

type LayoutStackLaneProps =
  | (TranscriptTailStackLaneProps & { lane: "transcript-tail" })
  | (ChatInputDecorationStackLaneProps & { lane: "composer-decoration" });

/**
 * Shared implementation for layout-affecting chat chrome. Public callers choose a
 * semantic lane through the wrappers below instead of passing low-level layout knobs.
 *
 * Lane semantics are intentionally centralized here:
 *  - transcript tail: content that belongs in the scrollport after messages and
 *    must opt out of browser scroll anchoring (so the bottom sentinel stays the
 *    sole anchor while the transcript is locked to the bottom).
 *  - composer decoration: persistent workspace chrome above the textarea, inside
 *    the in-flow sticky composer dock. Because the dock is normal scroll content,
 *    a decoration mounting/unmounting reflows the transcript clearance in the
 *    same layout pass — no height measurement or reservation is needed.
 *
 * This keeps future warnings/banners from accidentally reintroducing the class of
 * flash where appending a message moves a live tail row before bottom-lock settles.
 */
const LayoutStackLane: React.FC<LayoutStackLaneProps> = (props) => {
  if (props.items.length === 0) {
    return null;
  }

  const laneConfig = LAYOUT_STACK_LANE_CONFIG[props.lane];
  return (
    <div
      data-component={laneConfig.dataComponent}
      style={laneConfig.overflowAnchor === "none" ? NO_ANCHOR_STYLE : undefined}
    >
      {props.items.map((item) => (
        <React.Fragment key={item.key}>{item.node}</React.Fragment>
      ))}
    </div>
  );
};

export const TranscriptTailStackLane: React.FC<TranscriptTailStackLaneProps> = (props) => {
  return <LayoutStackLane {...props} lane="transcript-tail" />;
};

export const ChatInputDecorationStackLane: React.FC<ChatInputDecorationStackLaneProps> = (
  props
) => {
  return <LayoutStackLane {...props} lane="composer-decoration" />;
};
