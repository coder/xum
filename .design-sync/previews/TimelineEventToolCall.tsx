import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { TimelineEventToolCall } from "@/browser/features/Tools/TimelineEventToolCall";

// Isolated previews of the timeline_event tool-call card — one export per story in
// TimelineEventToolCall.stories.tsx, same inline args/result/status. Mirrors the stories'
// decorator (bg-background p-6, max-w-2xl); `width` reproduces NarrowContainer's 375px wrapper.

// Fixed instant so the preview's day header and time cell are deterministic.
const RECORDED_AT = new Date("2026-07-28T09:42:00").getTime();
const LANDED = "Landed the session-token refactor on main and opened PR #412 for review.";

const Shell = (props: { width?: string; children: React.ReactNode }) => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground p-6">
      <div className="w-full max-w-2xl">
        {props.width ? <div style={{ width: props.width }}>{props.children}</div> : props.children}
      </div>
    </div>
  </MuxPreviewShell>
);

export const MilestoneExpanded = () => (
  <Shell>
    <TimelineEventToolCall
      args={{ description: LANDED, category: "milestone" }}
      status="completed"
      defaultExpanded
      result={{ success: true, recorded: true }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);

export const PickedUpCollapsed = () => (
  <Shell>
    <TimelineEventToolCall
      args={{
        description:
          "Picked up a review comment on PR #412 asking to gate the new token path behind a flag.",
        category: "picked_up",
      }}
      status="completed"
      result={{ success: true, recorded: true }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);

export const DecisionExpanded = () => (
  <Shell>
    <TimelineEventToolCall
      args={{
        description:
          "Switched workspace status updates from polling to SSE — polling starved the renderer past ~200 workspaces.",
        category: "decision",
      }}
      status="completed"
      defaultExpanded
      result={{ success: true, recorded: true }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);

export const Blocker = () => (
  <Shell>
    <TimelineEventToolCall
      args={{
        description:
          "Blocked on staging migrations — the deploy role lacks ALTER TABLE and needs an infra approval.",
        category: "blocker",
      }}
      status="completed"
      result={{ success: true, recorded: true }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);

export const Handoff = () => (
  <Shell>
    <TimelineEventToolCall
      args={{
        description:
          "Handed flaky-test triage to the infra workspace with a repro script and the failing seeds.",
        category: "handoff",
      }}
      status="completed"
      result={{ success: true, recorded: true }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);

export const NoCategory = () => (
  <Shell>
    <TimelineEventToolCall
      args={{ description: "Rebased the feature branch onto main after the v0.27.0 release tag." }}
      status="completed"
      defaultExpanded
      result={{ success: true, recorded: true }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);

export const Throttled = () => (
  <Shell>
    <TimelineEventToolCall
      args={{ description: LANDED, category: "milestone" }}
      status="completed"
      defaultExpanded
      result={{ success: true, recorded: false }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);

export const Executing = () => (
  <Shell>
    <TimelineEventToolCall
      args={{ description: LANDED, category: "milestone" }}
      status="executing"
      defaultExpanded
    />
  </Shell>
);

export const ErrorEmptyDescription = () => (
  <Shell>
    <TimelineEventToolCall
      args={{ description: "   ", category: "milestone" }}
      status="failed"
      defaultExpanded
      result={{ success: false, error: "timeline_event requires a non-empty description" }}
    />
  </Shell>
);

export const NarrowContainer = () => (
  <Shell width="375px">
    <TimelineEventToolCall
      args={{
        description:
          "Deployed preview build https://ci.example.com/runs/0123456789abcdef0123456789abcdef/artifacts/mux-nightly-darwin-arm64.dmg for QA.",
        category: "milestone",
      }}
      status="completed"
      defaultExpanded
      result={{ success: true, recorded: true }}
      toolCallTimestamp={RECORDED_AT}
    />
  </Shell>
);
