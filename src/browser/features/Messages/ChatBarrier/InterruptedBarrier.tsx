import React from "react";
import { BaseBarrier } from "./BaseBarrier";

interface InterruptedBarrierProps {
  /** True on the writable resume target (history tail); only then is the label clickable. */
  resumable?: boolean;
  /** Resume handler (owned by ChatPane); used only when `resumable`. */
  onResume?: () => void;
  /** Last resume failure, surfaced inline so a click/keybind isn't a silent no-op. */
  error?: string | null;
  className?: string;
}

/**
 * "interrupted" divider on a partial assistant turn. On the resumable tail the
 * label continues the stream (the only continue affordance for Esc interrupts,
 * where RetryBarrier is suppressed).
 */
export const InterruptedBarrier: React.FC<InterruptedBarrierProps> = (props) => {
  return (
    <>
      <BaseBarrier
        text="interrupted"
        color="var(--color-interrupted)"
        className={props.className}
        onClick={props.resumable ? props.onResume : undefined}
        ariaLabel={props.resumable ? "Continue interrupted response" : undefined}
      />
      {props.resumable && props.error && (
        // Surface failures: this is the only continue affordance for an Esc interrupt.
        <div className="font-primary text-foreground/80 text-center text-[12px]">
          <span className="text-warning font-semibold">Couldn&apos;t continue:</span> {props.error}
        </div>
      )}
    </>
  );
};
