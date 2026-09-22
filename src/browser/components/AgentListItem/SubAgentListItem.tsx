import React, { useMemo } from "react";
import { cn } from "@/common/lib/utils";

/**
 * Period of the animated connector dash cycle. Must match the
 * connector-dash-scroll animation duration in globals.css.
 */
export const CONNECTOR_DASH_CYCLE_MS = 400;

interface SubAgentListItemProps {
  connectorPosition: "single" | "middle" | "last";
  sharedTrunkActiveThroughRow: boolean;
  ancestorTrunks: ReadonlyArray<{ left: number; active: boolean }>;
  connectorRailX: number;
  childStatusCenterX: number;
  isSelected: boolean;
  isElbowActive: boolean;
  /**
   * Present when this row is itself a parent of visible sub-agent rows: renders
   * the top of the children's shared trunk from this row's center down to its
   * bottom edge so the child trunk starts at the parent without the child rows
   * reaching up with negative offsets.
   */
  childTrunk?: { left: number; active: boolean };
  children: React.ReactNode;
}

/**
 * The dashed connector pattern is anchored to the viewport (see
 * .subagent-connector-active::before in globals.css), so two segments only
 * render one continuous pattern when their animation clocks also agree. CSS
 * animations start whenever a segment's active class is applied — a different
 * moment for every row mounted as agents spawn — so each segment supplies a
 * negative animation-delay aligned to the shared page clock, making every
 * active segment sample the same global dash phase.
 *
 * The timestamp must be captured once per animation start (keyed on `active`):
 * recomputing it on unrelated re-renders would move animation-delay while the
 * animation runs and visibly jump the phase.
 */
type ConnectorDashSyncStyle = React.CSSProperties & { "--connector-dash-delay": string };

function useConnectorDashSyncStyle(active: boolean): ConnectorDashSyncStyle | undefined {
  return useMemo(() => {
    if (!active) {
      return undefined;
    }
    const style: ConnectorDashSyncStyle = {
      "--connector-dash-delay": `${-(performance.now() % CONNECTOR_DASH_CYCLE_MS)}ms`,
    };
    return style;
  }, [active]);
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
  const dashSyncStyle = useConnectorDashSyncStyle(props.active);
  const segmentStyle: React.CSSProperties & { "--connector-color": string } = {
    "--connector-color": props.isSelected ? "var(--color-border)" : "var(--color-border-light)",
    ...props.style,
    ...dashSyncStyle,
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

function getConnectorElbowPath(opts: {
  bendsRight: boolean;
  width: number;
  height: number;
}): string {
  const maxX = Math.max(0.5, opts.width - 0.5);
  const maxY = Math.max(0.5, opts.height - 0.5);
  const cornerX = Math.min(maxY, maxX);

  if (opts.bendsRight) {
    return `M0.5 0.5 Q0.5 ${maxY} ${cornerX} ${maxY} H${maxX}`;
  }

  const leftCurveEndX = Math.max(0.5, maxX - cornerX);
  return `M${maxX} 0.5 Q${maxX} ${maxY} ${leftCurveEndX} ${maxY} H0.5`;
}

export function SubAgentListItem(props: SubAgentListItemProps) {
  const connectorBorderClass = props.isSelected ? "border-border" : "border-border-light";
  const connectorColor = props.isSelected ? "var(--color-border)" : "var(--color-border-light)";
  const connectorTurnSizePx = 6;

  const elbowLeft = Math.min(props.connectorRailX, props.childStatusCenterX);
  const elbowWidth = Math.max(1, Math.abs(props.childStatusCenterX - props.connectorRailX));
  const elbowBendsRight = props.childStatusCenterX >= props.connectorRailX;
  const elbowDashSyncStyle = useConnectorDashSyncStyle(props.isElbowActive);

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
      {/* The trunk connecting this row back to the parent. Middle rows render
          one uninterrupted full-height trunk (the branch elbow overlays it);
          the last/only child ends the trunk where its elbow curve begins so
          nothing dangles below the branch. */}
      <ConnectorTrunkSegment
        testId="subagent-connector-trunk"
        active={props.sharedTrunkActiveThroughRow}
        isSelected={props.isSelected}
        className={props.connectorPosition === "middle" ? "inset-y-0" : "top-0"}
        style={{
          left: props.connectorRailX,
          ...(props.connectorPosition === "middle"
            ? {}
            : { bottom: `calc(50% + ${connectorTurnSizePx}px)` }),
        }}
      />
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
        style={{ "--connector-color": connectorColor } as React.CSSProperties}
      >
        {props.isElbowActive ? (
          <svg
            aria-hidden
            data-testid="subagent-connector-elbow"
            className="absolute top-1/2 h-[6px] -translate-y-full"
            style={{ left: elbowLeft, width: elbowWidth, ...elbowDashSyncStyle }}
            viewBox={`0 0 ${elbowWidth} ${connectorTurnSizePx}`}
          >
            <path
              // Border dashes cannot animate their offset, so we draw the
              // rounded elbow as an SVG path and animate stroke-dashoffset.
              className="subagent-connector-elbow-active"
              d={getConnectorElbowPath({
                bendsRight: elbowBendsRight,
                width: elbowWidth,
                height: connectorTurnSizePx,
              })}
            />
          </svg>
        ) : (
          <span
            data-testid="subagent-connector-elbow"
            className={cn(
              connectorBorderClass,
              // Draw a rounded elbow instead of a hard 90-degree corner where the
              // vertical connector turns into the sub-agent branch.
              "absolute top-1/2 h-[6px] -translate-y-full border-b",
              elbowBendsRight ? "rounded-bl-[6px] border-l" : "rounded-br-[6px] border-r"
            )}
            style={{ left: elbowLeft, width: elbowWidth }}
          />
        )}
      </div>
      {props.children}
    </div>
  );
}
