import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { WorkflowPhaseFlow } from "@/browser/features/RightSidebar/Workflows/WorkflowPhaseFlow";
import type { WorkflowPhaseFlowNode } from "@/browser/features/RightSidebar/Workflows/WorkflowPhaseFlow";

// Isolated previews of the workflow phase rail — one export per story in
// WorkflowPhaseFlow.stories.tsx. Mirrors the stories' decorator (sidebar-width bordered card,
// capped at 430px); MobileNarrow pins the width the 390px phone viewport yields (90vw = 351px).

const DECLARED_NODES: WorkflowPhaseFlowNode[] = [
  { name: "scope", label: "Scope", lifecycle: "pending", description: "Pick research angles" },
  { name: "search-fetch", label: "Search & Fetch", lifecycle: "pending", parallel: true },
  { name: "verify", label: "Verify", lifecycle: "pending", parallel: true },
  { name: "synthesize", label: "Synthesize", lifecycle: "pending" },
];

function withLifecycles(
  lifecycles: Array<WorkflowPhaseFlowNode["lifecycle"]>
): WorkflowPhaseFlowNode[] {
  return DECLARED_NODES.map((node, index) => ({
    ...node,
    lifecycle: lifecycles[index] ?? node.lifecycle,
  }));
}

const Frame = (props: { width?: string; children: React.ReactNode }) => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground p-4">
      <div
        className="bg-background text-foreground border-border w-[min(430px,90vw)] rounded-xl border p-4"
        style={props.width ? { width: props.width } : undefined}
      >
        {props.children}
      </div>
    </div>
  </MuxPreviewShell>
);

export const PreRunAllPending = () => (
  <Frame>
    <WorkflowPhaseFlow nodes={DECLARED_NODES} provenance="declared" />
  </Frame>
);

export const MidRunWithDynamicPhase = () => (
  <Frame>
    <WorkflowPhaseFlow
      nodes={[
        { ...DECLARED_NODES[0], lifecycle: "completed" },
        { ...DECLARED_NODES[1], lifecycle: "completed" },
        {
          name: "recover-fetch",
          label: "recover-fetch",
          lifecycle: "completed",
          description: "Observed phase the script did not declare",
        },
        { ...DECLARED_NODES[2], lifecycle: "running" },
        { ...DECLARED_NODES[3], lifecycle: "pending" },
      ]}
      provenance="declared"
      onPhaseSelect={() => undefined}
    />
  </Frame>
);

export const LoopReentry = () => (
  <Frame>
    <WorkflowPhaseFlow
      nodes={withLifecycles(["completed", "running", "completed", "pending"])}
      provenance="declared"
    />
  </Frame>
);

export const CompletedWithSkippedPhase = () => (
  <Frame>
    <WorkflowPhaseFlow
      nodes={withLifecycles(["completed", "completed", "skipped", "completed"])}
      provenance="declared"
    />
  </Frame>
);

export const FailedRun = () => (
  <Frame>
    <WorkflowPhaseFlow
      nodes={withLifecycles(["completed", "failed", "not-reached", "not-reached"])}
      provenance="declared"
    />
  </Frame>
);

export const InterruptedRun = () => (
  <Frame>
    <WorkflowPhaseFlow
      nodes={withLifecycles(["completed", "interrupted", "not-reached", "not-reached"])}
      provenance="declared"
    />
  </Frame>
);

export const InferredRail = () => (
  <Frame>
    <WorkflowPhaseFlow
      nodes={[
        { name: "scope", label: "scope", lifecycle: "completed" },
        { name: "audit", label: "audit", lifecycle: "not-visited" },
        { name: "load-findings", label: "load-findings", lifecycle: "completed" },
        { name: "report", label: "report", lifecycle: "completed" },
      ]}
      provenance="inferred"
    />
  </Frame>
);

export const MobileNarrow = () => (
  <Frame width="351px">
    <WorkflowPhaseFlow
      nodes={[
        { ...DECLARED_NODES[0], lifecycle: "completed" },
        { ...DECLARED_NODES[1], lifecycle: "running" },
        { ...DECLARED_NODES[2], lifecycle: "pending" },
        { ...DECLARED_NODES[3], lifecycle: "pending" },
        {
          name: "long-tail-phase-name-that-truncates",
          label: "long-tail-phase-name-that-truncates",
          lifecycle: "pending",
        },
      ]}
      provenance="declared"
    />
  </Frame>
);
