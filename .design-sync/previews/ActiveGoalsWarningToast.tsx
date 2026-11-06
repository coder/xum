import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ActiveGoalsWarningToast } from "@/browser/components/ActiveGoalsWarningToast/ActiveGoalsWarningToast";

// Fixed top-right warning toast — mirrors the AboveThreshold story (activeGoalCount: 4, above
// the threshold of 3). The toast auto-dismisses 5 s after its rising edge; so the card does not
// go blank, the preview remounts it every 4 s (each mount is a fresh rising edge).
// Fixed-position overlay → cardMode "single".
function KeepShowing(props: { children: React.ReactNode }) {
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setGeneration((g) => g + 1), 4_000);
    return () => window.clearInterval(timer);
  }, []);
  return <React.Fragment key={generation}>{props.children}</React.Fragment>;
}

export const AboveThreshold = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground min-h-[160px]">
      <KeepShowing>
        <ActiveGoalsWarningToast activeGoalCount={4} />
      </KeepShowing>
    </div>
  </MuxPreviewShell>
);
