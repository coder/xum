import type React from "react";
import { cn } from "@/common/lib/utils";

interface SubAgentListItemProps {
  connectorPosition: "single" | "middle" | "last";
  sharedTrunkActiveThroughRow: boolean;
  sharedTrunkActiveBelowRow: boolean;
  ancestorTrunks: ReadonlyArray<{ left: number; active: boolean }>;
  connectorRailX: number;
  childStatusCenterX: number;
  isSelected: boolean;
  /**
   * Present when this row is itself a parent of visible sub-agent rows: renders
   * the top of the children's shared trunk from this row's center down to its
   * bottom edge so the child trunk starts at the parent without the child rows
   * reaching up with negative offsets.
   */
  childTrunk?: { left: number; active: boolean };
  children: React.ReactNode;
}

/** One vertical 1px connector segment with the shared dash-phase treatment. */
function ConnectorTrunkSegment(props: {
  testId: string;
  active: boolean;
  isSelected: boolean;
  className?: string;
  style?: React.CSSProperties;
  dataAttributes?: Record<string, string>;
}) {
  const segmentStyle: React.CSSProperties & { "--connector-color": string } = {
    "--connector-color": props.isSelected ? "var(--color-border)" : "var(--color-border-light)",
    ...props.style,
  };
  return (
    <span
      aria-hidden
      data-testid={props.testId}
      {...props.dataAttributes}
      className={cn(
        props.isSelected ? "bg-border" : "bg-border-light",
        "pointer-events-none absolute z-10 w-px",
        props.className,
        props.active && "subagent-connector-active"
      )}
      style={segmentStyle}
    />
  );
}

/**
 * Trunk stub rendered inside a parent row (agent row or task-group header):
 * spans from the row's vertical center (the status-slot center) to its bottom
 * edge, where the first child row's trunk takes over.
 */
export function SubAgentChildTrunk(props: { left: number; active: boolean; isSelected: boolean }) {
  return (
    <ConnectorTrunkSegment
      testId="subagent-child-trunk"
      active={props.active}
      isSelected={props.isSelected}
      className="top-1/2 bottom-0"
      style={{ left: props.left }}
    />
  );
}

export function SubAgentListItem(props: SubAgentListItemProps) {
  const connectorBorderClass = props.isSelected ? "border-border" : "border-border-light";
  const connectorTurnSizePx = 6;

  const elbowLeft = Math.min(props.connectorRailX, props.childStatusCenterX);
  const elbowWidth = Math.max(1, Math.abs(props.childStatusCenterX - props.connectorRailX));
  const elbowBendsRight = props.childStatusCenterX >= props.connectorRailX;
  const endsActivityHere =
    props.connectorPosition === "middle" &&
    props.sharedTrunkActiveThroughRow &&
    !props.sharedTrunkActiveBelowRow;
  const fullHeightTrunk = props.connectorPosition === "middle" && !endsActivityHere;

  return (
    <div className="relative">
      {props.ancestorTrunks.map((trunk, index) => (
        <ConnectorTrunkSegment
          key={`ancestor-trunk-${index}-${trunk.left}`}
          testId="ancestor-trunk"
          dataAttributes={{ "data-trunk-active": String(trunk.active) }}
          active={trunk.active}
          isSelected={props.isSelected}
          // Render one full-height trunk per continuing ancestor depth so
          // nested rows stay visually connected to higher-level siblings.
          className="inset-y-0"
          style={{ left: trunk.left }}
        />
      ))}
      {/* Cover middle rows continuously, splitting only at an active/static
          boundary. The last/only child ends where its elbow curve begins so
          nothing dangles below the branch. */}
      <ConnectorTrunkSegment
        testId="subagent-connector-trunk"
        active={props.sharedTrunkActiveThroughRow}
        isSelected={props.isSelected}
        className={fullHeightTrunk ? "inset-y-0" : "top-0"}
        style={{
          left: props.connectorRailX,
          ...(fullHeightTrunk
            ? {}
            : { bottom: endsActivityHere ? "50%" : `calc(50% + ${connectorTurnSizePx}px)` }),
        }}
      />
      {/* Queued siblings below the last running child retain a solid continuation,
          but must not look active. Adjacent halves keep the rail gap-free. */}
      {endsActivityHere && (
        <ConnectorTrunkSegment
          testId="subagent-connector-inactive-tail"
          active={false}
          isSelected={props.isSelected}
          className="top-1/2 bottom-0"
          style={{ left: props.connectorRailX }}
        />
      )}
      {props.childTrunk && (
        <SubAgentChildTrunk
          left={props.childTrunk.left}
          active={props.childTrunk.active}
          isSelected={props.isSelected}
        />
      )}
      <div
        aria-hidden
        data-testid="subagent-connector"
        // Keep connectors above the row background so lines remain visible for
        // both selected and unselected sub-agent variants.
        className="pointer-events-none absolute inset-y-0 right-0 left-0 z-10"
      >
        {/* Solid joins avoid mixing viewport-anchored trunk dashes with a path-local
            SVG pattern. Only the vertical activity rails animate. */}
        <span
          data-testid="subagent-connector-elbow"
          className={cn(
            connectorBorderClass,
            "absolute top-1/2 h-[6px] -translate-y-full border-b",
            elbowBendsRight ? "rounded-bl-[6px] border-l" : "rounded-br-[6px] border-r"
          )}
          style={{ left: elbowLeft, width: elbowWidth }}
        />
      </div>
      {props.children}
    </div>
  );
}
