import { useEffect, useRef, useState, type RefObject } from "react";

import { parseCommand } from "@/browser/utils/slashCommands/parser";

/**
 * #6259: whether a send in flight locks typing in the composer. Submission still waits for the
 * send to settle (the caller's canSend). The creation composer keeps its lock for the whole send.
 * #6405: a workspace send of a plain message never locks typing: its take removes exactly the sent
 * text (takeSentText), so keys typed from Enter on are kept. A slash command still locks typing
 * until its send took the draft: commands clear or replace the composer text themselves.
 */
export function useComposerTypingLock(options: {
  variant: "workspace" | "creation";
  /** Workspace sends in flight (each counted from Enter until it settles). */
  sendingCount: number;
  isStreamStarting: boolean;
  /** The lock a creation composer keeps for its whole send. */
  creationLocksTyping: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // Workspace sends in flight that do not lock typing: plain messages, and commands that have
  // already taken their draft out of the composer.
  const [freeSendCount, setFreeSendCount] = useState(0);
  const isWorkspace = options.variant === "workspace";
  const locksTyping = isWorkspace
    ? options.sendingCount > freeSendCount && !options.isStreamStarting
    : options.creationLocksTyping;
  useRefocusWhenUnlocked(isWorkspace && locksTyping, options.inputRef);

  /**
   * Enter on `text` (the composer text): a plain message keeps typing on for its whole send. Call
   * the result once when the send attempt ends.
   */
  const keepTypingOn = (text: string) =>
    freeSendWhen(isPlainWorkspaceMessage(options.variant, text), setFreeSendCount);

  /**
   * The send of `text` took its draft: a command's send stops locking typing (a plain message's
   * never locked it). Call the result once when the send settles.
   */
  const markDraftTaken = (text: string) =>
    freeSendWhen(!isPlainWorkspaceMessage(options.variant, text), setFreeSendCount);

  return { locksTyping, keepTypingOn, markDraftTaken };
}

function isPlainWorkspaceMessage(variant: "workspace" | "creation", text: string): boolean {
  return variant === "workspace" && parseCommand(text) === null;
}

/** When `frees`, counts one more free send until the returned release (idempotent) runs. */
function freeSendWhen(
  frees: boolean,
  setFreeSendCount: (update: (count: number) => number) => void
): () => void {
  if (!frees) return () => undefined;
  setFreeSendCount((count) => count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setFreeSendCount((count) => count - 1);
  };
}

/**
 * Disabling the focused textarea drops focus to <body>. When `locked` turns false, focus returns
 * to the composer, unless the user moved it somewhere else meanwhile.
 */
function useRefocusWhenUnlocked(
  locked: boolean,
  inputRef: RefObject<HTMLTextAreaElement | null>
): void {
  const wasLockedRef = useRef(false);
  useEffect(() => {
    const wasLocked = wasLockedRef.current;
    wasLockedRef.current = locked;
    if (!wasLocked || locked) return;
    const active = document.activeElement;
    if (active === null || active === document.body) inputRef.current?.focus();
  }, [locked, inputRef]);
}
