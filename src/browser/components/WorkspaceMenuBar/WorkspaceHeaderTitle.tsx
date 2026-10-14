import React, { useEffect, useRef, useState } from "react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { showFeedbackToast } from "@/browser/utils/feedbackToast";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { isWorkspaceRowRendered } from "@/browser/utils/ui/workspaceDomNav";
import { PopoverError } from "../PopoverError/PopoverError";

// The header's inline title edit (#6328). The sidebar row's edit needs that row on screen; this
// one also works with the sidebar collapsed or the row hidden by a collapsed project or section.

/** Where focus goes when the edit ends: the control that had it, or the fallback when it is gone. */
export function pickReturnFocusTarget(
  previous: Element | null,
  fallback: HTMLElement | null
): HTMLElement | null {
  const usable = previous instanceof HTMLElement && previous.isConnected;
  return usable && previous !== previous.ownerDocument.body ? previous : fallback;
}

/**
 * F2 when the sidebar does not render this workspace's row (sidebar collapsed, or a collapsed
 * project or section hides it). SidebarTitleEditKeybinds edits it in the row otherwise. Both read
 * the same DOM check, so exactly one of them takes the key.
 */
function useHeaderEditTitleKey(
  workspaceId: string,
  start: (workspaceId: string, returnFocusTo: Element | null) => void
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.EDIT_WORKSPACE_TITLE) || isEditableElement(e.target)) return;
      if (isWorkspaceRowRendered(workspaceId)) return;
      e.preventDefault();
      start(workspaceId, document.activeElement);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspaceId, start]);
}

export interface HeaderTitleEdit {
  /** The workspace being edited, or null. */
  editingWorkspaceId: string | null;
  start: () => void;
  /** The edit for `editWorkspaceId` is over; `hadFocus`: its field still had focus. */
  end: (editWorkspaceId: string, hadFocus: boolean) => void;
  /** The menu that started the edit closes: keep focus in the field, not on the trigger. */
  onMenuCloseAutoFocus: (event: Event) => void;
  fieldRef: React.RefObject<HTMLSpanElement>;
}

/**
 * The header's title edit, keyed by workspace: the menu bar is reused across workspaces, and an
 * edit must rename the workspace it started for, never the one now in view.
 */
export function useHeaderTitleEdit(
  workspaceId: string,
  menuTriggerRef: React.RefObject<HTMLElement | null>
): HeaderTitleEdit {
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  if (editingWorkspaceId !== null && editingWorkspaceId !== workspaceId) {
    setEditingWorkspaceId(null);
  }
  const fieldRef = useRef<HTMLSpanElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  // Uses a setter and a ref only, so React Compiler keeps it stable for the key listener.
  const start = (id: string, returnFocusTo: Element | null) => {
    returnFocusRef.current = returnFocusTo;
    setEditingWorkspaceId(id);
  };
  useHeaderEditTitleKey(workspaceId, start);
  return {
    editingWorkspaceId,
    start: () => start(workspaceId, document.activeElement),
    end: (editWorkspaceId, hadFocus) => {
      // A save that settles after a switch to another workspace must not close that one's edit.
      setEditingWorkspaceId((current) => (current === editWorkspaceId ? null : current));
      // The menu row that started the edit unmounts with its menu: then focus the trigger.
      if (hadFocus) pickReturnFocusTarget(returnFocusRef.current, menuTriggerRef.current)?.focus();
    },
    onMenuCloseAutoFocus: (event) => {
      if (fieldRef.current?.contains(document.activeElement)) event.preventDefault();
    },
    fieldRef,
  };
}

/** The header title, or its edit field while the edit for this workspace is open. */
export function WorkspaceHeaderTitle(props: {
  workspaceId: string;
  title: string;
  edit: HeaderTitleEdit;
}) {
  if (props.edit.editingWorkspaceId !== props.workspaceId) {
    return (
      <span className="min-w-0 truncate text-sm" data-testid="workspace-title">
        {props.title}
      </span>
    );
  }
  return (
    <span ref={props.edit.fieldRef} className="flex min-w-0 flex-1">
      <WorkspaceHeaderTitleInput
        key={props.workspaceId}
        workspaceId={props.workspaceId}
        initialTitle={props.title}
        onDone={(hadFocus) => props.edit.end(props.workspaceId, hadFocus)}
      />
    </span>
  );
}

/** Just under the element, so the error does not cover the field. */
function getErrorAnchorBelow(
  element: HTMLElement | null
): { top: number; left: number } | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { top: rect.bottom + window.scrollY + 4, left: rect.left };
}

interface WorkspaceHeaderTitleInputProps {
  /** The workspace whose title this edit renames, fixed when the edit starts. */
  workspaceId: string;
  initialTitle: string;
  /** The edit is over. `hadFocus`: the input still had focus, so focus must go back. */
  onDone: (hadFocus: boolean) => void;
}

/**
 * Enter or leaving the field saves, Escape cancels. A failed save keeps the edit open and shows
 * the error under the field.
 */
/**
 * A save whose field is gone reports in the shared toast: its error popover unmounted with the
 * field, and the workspace keeps its old title (#6434).
 */
function reportSaveError(fieldMounted: boolean, error: string, showError: (error: string) => void) {
  if (fieldMounted) showError(error);
  else
    showFeedbackToast({ type: "error", title: "Could not rename the workspace", message: error });
}

/**
 * The field unmounts with the edit still open when the selected workspace changes under it: the
 * header is reused across workspaces. Save the typed text then, as leaving the field does
 * (#6434). The save's phase guard skips it when the field's blur already saved.
 */
function useSaveOnUnmount(
  mountedRef: React.MutableRefObject<boolean>,
  save: () => Promise<void>,
  dirty: boolean
) {
  const latestRef = useRef({ save, dirty });
  useEffect(() => {
    latestRef.current = { save, dirty };
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // StrictMode's dev remount runs this with an unchanged draft: nothing to save then.
      if (latestRef.current.dirty) void latestRef.current.save();
    };
  }, [mountedRef]);
}

/** The draft, its save and its cancel. The field below only maps keys and renders. */
function useTitleDraft(props: WorkspaceHeaderTitleInputProps) {
  const { updateWorkspaceTitle } = useWorkspaceContext();
  const [draft, setDraft] = useState(props.initialTitle);
  const titleError = usePopoverError();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter saves, and so does the blur that follows when focus moves: save once. After onDone,
  // which moves focus away, the blur must not save a cancelled draft.
  const phaseRef = useRef<"editing" | "saving" | "done">("editing");
  const mountedRef = useRef(false);

  const finish = () => {
    phaseRef.current = "done";
    props.onDone(document.activeElement === inputRef.current);
  };
  const showError = (error: string) =>
    titleError.showError(props.workspaceId, error, getErrorAnchorBelow(inputRef.current));

  const save = async () => {
    if (phaseRef.current !== "editing") return;
    const title = draft.trim();
    if (title === props.initialTitle.trim()) return finish();
    // After a workspace switch this runs with the field gone: the toast must say why (Codex on #6461).
    if (!title) return reportSaveError(mountedRef.current, "Title cannot be empty", showError);
    phaseRef.current = "saving";
    const result = await updateWorkspaceTitle(props.workspaceId, title);
    if (result.success) return finish();
    phaseRef.current = "editing";
    reportSaveError(mountedRef.current, result.error ?? "Failed to update title", showError);
  };
  useSaveOnUnmount(mountedRef, save, draft.trim() !== props.initialTitle.trim());
  // A pending save still renames the workspace: Escape then must not look like a cancel
  // (Codex on #6431). The field closes when the save settles.
  const cancel = () => {
    if (phaseRef.current === "editing") finish();
  };

  return { draft, setDraft, titleError, inputRef, save, cancel };
}

function WorkspaceHeaderTitleInput(props: WorkspaceHeaderTitleInputProps) {
  const { draft, setDraft, titleError, inputRef, save, cancel } = useTitleDraft(props);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Typing in the field must not reach the window shortcuts.
    stopKeyboardPropagation(e);
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
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
