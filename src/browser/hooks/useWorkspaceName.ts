import { useState } from "react";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import { CREATION_DRAFT_NAME_MAX_CHARS } from "@/constants/drafts";
import type { NameGenerationError } from "@/common/types/errors";
import {
  validateWorkspaceBranchName,
  validateWorkspaceName,
} from "@/common/utils/validation/workspaceValidation";

/** Discriminated error type for workspace name operations */
export type WorkspaceNameUIError =
  | { kind: "generation"; error: NameGenerationError }
  | { kind: "validation"; message: string }
  | { kind: "transport"; message: string };

/** Workspace identity (name + title) */
export interface WorkspaceIdentity {
  /** Short git-safe name (e.g., "plan-a1b2") */
  name: string;
  /** Human-readable title (e.g., "Fix plan mode over SSH") */
  title: string;
}

/** A valid local name for a message, when generation is skipped or fails. */
export function buildFallbackWorkspaceIdentity(message: string): WorkspaceIdentity {
  const normalized = message
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const name = normalized && !validateWorkspaceName(normalized).error ? normalized : "workspace";
  return { name, title: name };
}

/** State and actions for the creation form's name field (CreationControls). */
export interface WorkspaceNameState {
  /** The manual name ("" when the workspace is named on Send). */
  name: string;
  title: string | null;
  /** Whether Send is generating the name. */
  isGenerating: boolean;
  /** Whether Send names the workspace (no manual name). */
  autoGenerate: boolean;
  error: WorkspaceNameUIError | null;
  setAutoGenerate: (enabled: boolean) => void;
  setName: (name: string) => void;
}

/**
 * The creation form's name: only a manual name is kept (in the creation draft). With none, the
 * workspace is named on Send; there is deliberately no preview, cached result or debounce.
 */
export function useWorkspaceName(options: {
  manualName: string;
  /** The creation draft that stores the manual name. */
  draftId: string;
  isGenerating: boolean;
}): WorkspaceNameState {
  // Focusing the empty field starts a manual name; the draft holds only typed text.
  const [editing, setEditing] = useState(false);
  const name = options.manualName;
  // The draft write lives here, not in the caller (#6843): React Compiler skips
  // useCreationWorkspace, so a setter defined there gets a new identity every render, and
  // CreationControls re-rendered on every keystroke. Here the compiler keeps setName and
  // setAutoGenerate stable for one draft.
  const draftId = options.draftId;
  const setManualName = (manualName: string) =>
    getCreationDraftStore().update(draftId, {
      manualName: manualName.slice(0, CREATION_DRAFT_NAME_MAX_CHARS),
    });
  const validationError = name.trim() ? validateWorkspaceBranchName(name).error : undefined;
  return {
    name,
    title: null,
    isGenerating: options.isGenerating,
    autoGenerate: !editing && name.trim().length === 0,
    error: validationError ? { kind: "validation", message: validationError } : null,
    setAutoGenerate: (enabled) => {
      setEditing(!enabled);
      if (enabled) setManualName("");
    },
    setName: setManualName,
  };
}
