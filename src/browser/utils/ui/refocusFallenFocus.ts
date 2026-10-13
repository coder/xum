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
  let movingTo: EventTarget | null = null;
  const onFocusOut = (event: FocusEvent) => {
    movingTo = event.relatedTarget;
  };
  const onFocusIn = () => {
    movingTo = null;
  };
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  const observer = new MutationObserver(() => {
    if (movingTo instanceof Node && movingTo.isConnected) return;
    if (document.activeElement == null || document.activeElement === document.body) {
      element.focus();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("focusin", onFocusIn, true);
  };
}
