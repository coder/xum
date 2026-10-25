import React from "react";

import { SIDEBAR_LEADING_SLOT_SIZE_PX } from "@/browser/components/sidebarItemLayout";
import { cn } from "@/common/lib/utils";

// Shared sidebar status language: agent rows and task-group headers render the
// same dot states so grouped rows read as native parts of the agent tree.
// "waiting" = parked but will resume on its own (e.g. armed background bash
// monitor): same pulse and geometry as "active", but in the shared
// "backgrounded" soft blue (the token background-process badges use) so it
// reads as live-but-waiting rather than actively streaming or finished. The
// border must stay a near-background surface tint (like the green dot's) so
// only the small core reads as colored — a colored/translucent border makes
// the whole 12px circle read as the dot.
export type VisualState = "active" | "waiting" | "idle" | "seen" | "hidden" | "error" | "question";

export const LEADING_SLOT_CONTAINER_STYLE = {
  width: SIDEBAR_LEADING_SLOT_SIZE_PX,
  height: SIDEBAR_LEADING_SLOT_SIZE_PX,
} as const;

export const LEADING_SLOT_CONTAINER_CLASSES =
  "relative z-1 flex shrink-0 items-center justify-center self-center";
export const STATUS_DOT_SLOT_CONTAINER_CLASSES =
  "relative z-20 flex shrink-0 items-center justify-center self-center";

export function isStatusDotVisible(
  state: VisualState,
  isDraft?: boolean,
  isSubAgent?: boolean
): boolean {
  if (isDraft) {
    return true;
  }
  if (state === "hidden") {
    return false;
  }
  if (state === "seen") {
    return isSubAgent === true;
  }
  return true;
}

export function StatusDot(props: {
  state: VisualState;
  isDraft?: boolean;
  isSubAgent?: boolean;
  overlay?: React.ReactNode;
}) {
  const hasVisibleDot = isStatusDotVisible(props.state, props.isDraft, props.isSubAgent);
  const usesSubAgentConnectorDot =
    props.isSubAgent === true && (props.state === "idle" || props.state === "seen");
  const dot = props.isDraft ? (
    <span className="border-border-subtle block h-3 w-3 rounded-full border border-dashed" />
  ) : !hasVisibleDot ? (
    <span className="block h-3 w-3 opacity-0" />
  ) : (
    <span
      className={cn(
        "block h-3 w-3",
        props.state === "active" &&
          "bg-content-success border-surface-green workspace-status-dot-active",
        props.state === "waiting" &&
          "bg-backgrounded border-surface-sky workspace-status-dot-active",
        usesSubAgentConnectorDot && "bg-border-light border-border-light h-2 w-2",
        props.state === "idle" &&
          props.isSubAgent !== true &&
          "bg-surface-invert-secondary border-surface-tertiary",
        props.state === "error" && "bg-content-destructive border-surface-destructive",
        props.state === "question" && "bg-border-pending border-surface-sky",
        "rounded-full border-[3.5px]"
      )}
    />
  );

  return (
    // Keep the dot centered relative to the full row height so multi-line rows
    // (for example while streaming) do not pin the icon to the title line.
    <div
      // Keep the status dot above sub-agent connector overlays so branch lines do
      // not draw across the dot when rows are nested.
      className={STATUS_DOT_SLOT_CONTAINER_CLASSES}
      style={LEADING_SLOT_CONTAINER_STYLE}
    >
      {dot}
      {props.overlay && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {props.overlay}
        </span>
      )}
    </div>
  );
}

// The corner dot of a flat-mode project avatar. The wrapper paints the 2px ring in the row's
// background (`--row-bg`, set by the row) so the dot cuts out of the avatar; the pulse runs on
// the inner dot only, so the ring never fades with it.
const AVATAR_DOT_CLASSES: Partial<Record<VisualState, string>> = {
  active: "bg-content-success workspace-status-dot-active",
  waiting: "bg-backgrounded workspace-status-dot-active",
  question: "bg-border-pending",
  error: "bg-content-destructive",
  idle: "bg-surface-invert-secondary",
};

/** Paints a ring in the row's background color (`--row-bg`, set by avatar rows). */
export const AVATAR_RING_STYLE = {
  backgroundColor: "var(--row-bg, var(--color-surface-primary))",
} as const;

const AVATAR_ACTIVE_GLOW = {
  boxShadow: "0 0 8px color-mix(in srgb, var(--color-content-success) 80%, transparent)",
} as const;

export function AvatarStatusDot(props: { state: VisualState; hideIdle?: boolean }) {
  const dotClasses = AVATAR_DOT_CLASSES[props.state];
  if (dotClasses == null || (props.hideIdle === true && props.state === "idle")) {
    return null;
  }
  return (
    <span className="block rounded-full p-[2px]" style={AVATAR_RING_STYLE}>
      <span
        className={cn("block h-[9px] w-[9px] rounded-full", dotClasses)}
        style={props.state === "active" ? AVATAR_ACTIVE_GLOW : undefined}
      />
    </span>
  );
}
