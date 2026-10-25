import { useEffect, type RefObject } from "react";
import { isPhoneTouchScreen } from "@/browser/utils/env";

const MAX_FOCUS_FRAMES = 10;

/**
 * Focus the composer when the workspace changes, retrying for a few frames while it mounts, and
 * yield to anything else the user focused meanwhile. `workspaceId` is null for inputs that are
 * not a workspace's composer. Not on phones: focus there opens the software keyboard over the
 * transcript on every workspace switch.
 */
export function useWorkspaceSwitchAutoFocus(params: {
  workspaceId: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  sectionRef: RefObject<HTMLDivElement | null>;
  focusInput: () => void;
  setAutoFocusState: (state: "pending" | "done") => void;
}): void {
  const { workspaceId, inputRef, sectionRef, focusInput, setAutoFocusState } = params;
  useEffect(() => {
    if (workspaceId == null || isPhoneTouchScreen()) return;

    setAutoFocusState("pending");

    let cancelled = false;
    let rafId: number | null = null;
    let attempts = 0;

    const step = () => {
      if (cancelled) return;

      attempts += 1;

      const input = inputRef.current;
      const active = document.activeElement;

      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement
      ) {
        const isWithinChatInput = !!sectionRef.current?.contains(active);
        const isInput = !!input && active === input;
        if (!isWithinChatInput && !isInput) {
          setAutoFocusState("done");
          return;
        }
      }

      focusInput();

      const isFocused = !!input && document.activeElement === input;
      const isDone = isFocused || attempts >= MAX_FOCUS_FRAMES;

      if (isDone) {
        setAutoFocusState("done");
        return;
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      setAutoFocusState("done");
    };
  }, [workspaceId, inputRef, sectionRef, focusInput, setAutoFocusState]);
}
