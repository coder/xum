import { useEffect, useRef, useState } from "react";

/**
 * How long a host confirm strip (artifact send, MCP Apps consent) keeps its confirm button
 * disabled after it appears. The frame loses focus on the host's pointerdown, so a hostile frame
 * could otherwise swap what a strip shows between the user's pointerdown and click; strips also
 * refuse new requests while shown, and this delay covers a strip that just appeared under the
 * pointer.
 */
export const CONFIRM_ARM_DELAY_MS = 750;

/**
 * Arming for the strip identified by `promptId`. `armed` turns true once the strip has been shown
 * for CONFIRM_ARM_DELAY_MS. Elapsed time alone is not enough: a press that started before the
 * strip armed (held through the delay) must not confirm it. So the confirm button passes
 * `onPointerDown`, which records a press only once armed, and wraps its action in `guardClick`,
 * which runs it only for a click that follows such a press, or for keyboard activation
 * (`detail === 0`: Enter or Space on the focused button).
 */
export function useConfirmArmed(promptId: number | null): {
  armed: boolean;
  onPointerDown: () => void;
  guardClick: (event: { detail: number }, action: () => void) => void;
} {
  const [armedId, setArmedId] = useState<number | null>(null);
  // The prompt an armed press started on; one press confirms at most once.
  const pressedIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (promptId == null) return;
    const timer = setTimeout(() => setArmedId(promptId), CONFIRM_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [promptId]);
  const armed = promptId != null && armedId === promptId;
  return {
    armed,
    onPointerDown: () => {
      pressedIdRef.current = armed ? promptId : null;
    },
    guardClick: (event, action) => {
      const pressed = pressedIdRef.current === promptId;
      pressedIdRef.current = null;
      if (!armed || (event.detail !== 0 && !pressed)) return;
      action();
    },
  };
}

let nextPromptId = 1;
/** Unique per shown prompt, so re-showing identical content re-arms the delay. */
export function newConfirmPromptId(): number {
  return nextPromptId++;
}
