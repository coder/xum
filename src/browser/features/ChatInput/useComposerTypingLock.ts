import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * #6259: whether a send in flight locks typing in the composer. A workspace send locks it only
 * until the send has taken its draft: typed earlier, keys could merge into the text the send
 * removes. Once taken, the textarea stays on through the stream and the reply, so keys typed then
 * are kept. Submission still waits for the send to settle (the caller's canSend). The creation
 * composer keeps its lock for the whole send.
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
  // Workspace sends in flight that have already taken their draft out of the composer.
  const [takenSendCount, setTakenSendCount] = useState(0);
  const isWorkspace = options.variant === "workspace";
  const locksTyping = isWorkspace
    ? options.sendingCount > takenSendCount && !options.isStreamStarting
    : options.creationLocksTyping;
  useRefocusWhenUnlocked(isWorkspace && locksTyping, options.inputRef);

  /** The send took its draft: typing can resume. Call the result once when the send settles. */
  const markDraftTaken = () => {
    setTakenSendCount((count) => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setTakenSendCount((count) => count - 1);
    };
  };

  return { locksTyping, markDraftTaken };
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
