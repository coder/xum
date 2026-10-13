import React, { useRef, useState } from "react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { PopoverError } from "../PopoverError/PopoverError";

interface WorkspaceHeaderTitleInputProps {
  /** The workspace whose title this edit renames, fixed when the edit starts. */
  workspaceId: string;
  initialTitle: string;
  /** The edit is over. `hadFocus`: the input still had focus, so focus must go back. */
  onDone: (hadFocus: boolean) => void;
}

/**
 * The header's inline title edit (#6328). The sidebar row's edit needs that row on screen; this
 * one also works with the sidebar collapsed or the row hidden by a collapsed project or section.
 * Enter or leaving the field saves, Escape cancels. A failed save keeps the edit open and shows
 * the error under the field.
 */
export function WorkspaceHeaderTitleInput(props: WorkspaceHeaderTitleInputProps) {
  const { updateWorkspaceTitle } = useWorkspaceContext();
  const [draft, setDraft] = useState(props.initialTitle);
  const titleError = usePopoverError();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter saves, and so does the blur that follows when focus moves: save once.
  const savingRef = useRef(false);
  // onDone moves focus away, and the blur that follows must not save a cancelled draft.
  const doneRef = useRef(false);

  const finish = () => {
    doneRef.current = true;
    props.onDone(document.activeElement === inputRef.current);
  };

  const showError = (error: string) => {
    const rect = inputRef.current?.getBoundingClientRect();
    titleError.showError(
      props.workspaceId,
      error,
      rect ? { top: rect.bottom + window.scrollY + 4, left: rect.left } : undefined
    );
  };

  const save = async () => {
    if (savingRef.current || doneRef.current) return;
    const title = draft.trim();
    if (title === props.initialTitle.trim()) return finish();
    if (!title) return showError("Title cannot be empty");
    savingRef.current = true;
    try {
      const result = await updateWorkspaceTitle(props.workspaceId, title);
      if (result.success) finish();
      else showError(result.error ?? "Failed to update title");
    } finally {
      savingRef.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Typing in the field must not reach the window shortcuts.
    stopKeyboardPropagation(e);
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish();
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        autoFocus
        className="bg-input-bg text-input-text border-input-border focus:border-input-border-focus min-w-0 flex-1 rounded-sm border px-1 text-sm outline-none select-text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => void save()}
        aria-label="Edit workspace title"
        data-testid="workspace-title-input"
      />
      <PopoverError
        error={titleError.error}
        prefix="Failed to update title"
        onDismiss={titleError.clearError}
      />
    </>
  );
}
