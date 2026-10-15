import { useEffect, useRef, type RefObject } from "react";

import { getDraftStore, type DraftStoreScope } from "@/browser/stores/DraftStore";

/**
 * #6585: tells DraftStore when the user edits the composer other than by typing at its end, so a
 * send that has not taken its draft yet removes nothing from it. The text alone cannot show this:
 * a select-all paste of "Fix the bug in parser.ts" over "Fix the bug" looks like typing after it.
 * Native `beforeinput`, because only it runs before the edit, with the selection the edit replaces.
 * The listener is on the document so a remounted textarea stays covered. Vim normal-mode commands
 * edit without `beforeinput`: they keep the text-shape rule (DraftStore followSendMark).
 */
export function useSendMarkEditTracking(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  scope: DraftStoreScope
): void {
  // The scope object can change identity on every render: the listener reads the latest one.
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  });
  useEffect(() => {
    const onBeforeInput = (event: Event) => {
      const textarea = inputRef.current;
      if (textarea === null || event.target !== textarea) return;
      if (isInsertAtEnd(event, textarea)) return;
      getDraftStore().markSendEdited(scopeRef.current);
    };
    document.addEventListener("beforeinput", onBeforeInput, true);
    return () => document.removeEventListener("beforeinput", onBeforeInput, true);
  }, [inputRef]);
}

/** An insertion at the end with no selection: the only edit that is typing after the text. */
function isInsertAtEnd(event: Event, textarea: HTMLTextAreaElement): boolean {
  const inputType = (event as InputEvent).inputType ?? "";
  const { selectionStart, selectionEnd, value } = textarea;
  return (
    inputType.startsWith("insert") &&
    selectionStart === selectionEnd &&
    selectionEnd === value.length
  );
}
