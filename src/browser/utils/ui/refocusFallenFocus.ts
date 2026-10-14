/** Focuses `element` when focus sits on <body> (or nowhere). */
function refocusIfFallen(element: HTMLElement) {
  if (document.activeElement == null || document.activeElement === document.body) {
    element.focus();
  }
}

/**
 * Focuses `element` whenever focus falls to <body> while it is shown, e.g. with a removed node:
 * a control that unmounts while focused (a viewer swapped for a new version, a closing comment
 * box), or a portaled menu outside it (#5715). Watches all of <body> for that. Returns the undo.
 *
 * Used by Artifacts fullscreen, which covers the window without a dialog's focus scope.
 */
export function refocusFallenFocus(element: HTMLElement): () => void {
  // Not while focus is moving: Tab blurs one control before it focuses the next, and in between
  // focus sits on <body>. The blurred button's tooltip closes then (a mutation), and taking focus
  // back there cancelled the move, so Tab never got past a button with a tooltip (#6200).
  // The browser fires the move's focusout and focusin in one task, so the guard lasts at most that
  // task: a target that never takes focus (made inert in a focusout handler) gets no focusin, and
  // the recovery must not stay off until the user's next click (#6291). A guard that expires
  // without its focusin is a move that failed, so the expiry checks focus itself: making the target
  // inert or hidden changes only attributes, and the observer below sees no mutation for it.
  let movingTo: EventTarget | null = null;
  let moveEnd: ReturnType<typeof setTimeout> | undefined;
  const endMove = () => {
    clearTimeout(moveEnd);
    movingTo = null;
  };
  const onFocusOut = (event: FocusEvent) => {
    endMove();
    // Only a move to a named target is guarded. Focus that leaves to nowhere (relatedTarget null)
    // still waits for a mutation, as before #6291.
    if (!(event.relatedTarget instanceof Node)) return;
    movingTo = event.relatedTarget;
    moveEnd = setTimeout(() => {
      endMove();
      refocusIfFallen(element);
    }, 0);
  };
  const onFocusIn = endMove;
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  const observer = new MutationObserver(() => {
    if (movingTo instanceof Node && movingTo.isConnected) return;
    refocusIfFallen(element);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    clearTimeout(moveEnd);
    observer.disconnect();
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("focusin", onFocusIn, true);
  };
}
