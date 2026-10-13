import { useEffect, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { ToggleGroup, type ToggleOption } from "@/browser/components/ToggleGroup/ToggleGroup";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { MarkdownFilePreview } from "@/browser/features/Messages/MarkdownFilePreview";
import { RowActionButton } from "@/browser/features/RightSidebar/GoalBoardSections";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  formatKeybind,
  formatKeybindForAria,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type { MemorySaveError } from "@/common/orpc/schemas/memory";
import { getErrorMessage } from "@/common/utils/errors";
import { getLanguageFromPath } from "@/common/utils/git/languageDetector";

type ViewMode = "preview" | "edit";

const VIEW_MODE_OPTIONS: Array<ToggleOption<ViewMode>> = [
  { value: "preview", label: "Preview" },
  { value: "edit", label: "Edit" },
];

interface MemoryFileEditorProps {
  /** null = no workspace (Settings → Memory); only global paths are editable. */
  workspaceId: string | null;
  path: string;
  onBack: () => void;
}

/**
 * Whole-file editor. Saves carry the sha256 captured at load; the backend
 * rejects stale saves as conflicts, which surface as a banner with a reload
 * affordance (reload discards the local draft by design — the alternative
 * silently overwrites the other writer's changes).
 *
 * Markdown files open in a rendered preview of the current draft; the toggle
 * and its shortcut switch to the textarea and back without losing the draft.
 */
export function MemoryFileEditor(props: MemoryFileEditorProps) {
  const { api } = useAPI();
  const [loaded, setLoaded] = useState<{ content: string; sha256: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<MemorySaveError | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // Read the live DOM value at save time (same pattern as
  // WorkspaceHeartbeatModal): controlled-textarea onChange does not fire in
  // happy-dom, and the DOM is authoritative for what the user typed anyway.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const view = useMarkdownViewMode(props.path, rootRef, textareaRef, setDraft);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api.memory
      .read({ workspaceId: props.workspaceId, path: props.path }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.success) {
          setLoaded(result.data);
          setDraft(result.data.content);
          setLoadError(null);
        } else {
          setLoadError(result.error);
        }
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return;
        setLoadError(getErrorMessage(err));
      });
    return () => controller.abort();
  }, [api, props.workspaceId, props.path, reloadTick]);

  const handleSave = async () => {
    if (!api || loaded === null || saving) return;
    const content = textareaRef.current?.value ?? draft;
    setSaving(true);
    try {
      const result = await api.memory.save({
        workspaceId: props.workspaceId,
        path: props.path,
        content,
        expectedSha256: loaded.sha256,
      });
      if (result.success) {
        setLoaded({ content, sha256: result.data.sha256 });
        setDraft(content);
        setSaveError(null);
      } else {
        setSaveError(result.error);
      }
    } catch (err) {
      setSaveError({ kind: "error", message: getErrorMessage(err) });
    } finally {
      setSaving(false);
      focusEditorIfFocusLost(rootRef.current, null);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (matchesKeybind(e, KEYBINDS.SAVE_EDIT)) {
      e.preventDefault();
      void handleSave();
    } else if (view.isMarkdown && matchesKeybind(e, KEYBINDS.TOGGLE_MARKDOWN_PREVIEW)) {
      e.preventDefault();
      // A held shortcut must not flip the mode on every key repeat.
      if (!e.repeat) view.toggle();
    }
  };

  const handleReload = (button: HTMLElement) => {
    focusEditorIfFocusLost(rootRef.current, button);
    setSaveError(null);
    setReloadTick((n) => n + 1);
  };

  return (
    // h-full fills block parents (sidebar tabpanel); flex-1 fills flex parents
    // (Settings → Memory). Each is inert in the other context.
    // Shortcuts are scoped to the editor (as in the Artifacts panel): they fire
    // from the textarea, the preview and the header controls, never elsewhere.
    <div
      ref={rootRef}
      tabIndex={-1}
      // Focused on open. Unnamed, it would be named after all of its text, which a screen
      // reader then reads out.
      role="group"
      aria-label={`Memory file ${props.path}`}
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 flex-1 flex-col outline-none"
    >
      <MemoryFileHeader
        path={props.path}
        showModeToggle={view.isMarkdown && loadError === null}
        mode={view.mode}
        onModeChange={view.switchMode}
        saveDisabled={loaded === null || saving}
        saving={saving}
        onBack={props.onBack}
        onSave={() => void handleSave()}
      />
      {saveError !== null && <SaveErrorBanner error={saveError} onReload={handleReload} />}
      <MemoryFileBody
        loadError={loadError}
        mode={view.mode}
        draft={draft}
        textareaRef={textareaRef}
        onDraftChange={setDraft}
      />
    </div>
  );
}

function MemoryFileBody(props: {
  loadError: string | null;
  mode: ViewMode;
  draft: string;
  textareaRef: Ref<HTMLTextAreaElement>;
  onDraftChange: (draft: string) => void;
}) {
  if (props.loadError !== null) {
    return (
      <div className="text-error px-3 py-2 text-xs" role="alert">
        {props.loadError}
      </div>
    );
  }
  return (
    <>
      {props.mode === "preview" && (
        <div className="min-h-48 flex-1 overflow-auto p-3">
          <MarkdownFilePreview content={props.draft} />
        </div>
      )}
      {/* Stays mounted (hidden) in Preview, as GitHub's Write/Preview tabs
          do, so a round trip keeps the caret and undo history. */}
      <textarea
        ref={props.textareaRef}
        hidden={props.mode === "preview"}
        // flex-1 fills the available height; the min-h floor keeps the
        // editor usable on very short viewports.
        className="min-h-48 flex-1 resize-none bg-transparent p-3 font-mono text-xs outline-none"
        aria-label="Memory file content"
        value={props.draft}
        spellCheck={false}
        onChange={(e) => props.onDraftChange(e.target.value)}
      />
    </>
  );
}

/**
 * When the control holding focus goes away (Save is disabled while saving,
 * Reload unmounts with its banner, the textarea hides in Preview), focus falls
 * to <body> and the editor shortcuts stop working. Pull it back to the editor
 * root, but never move focus the user put elsewhere.
 */
function focusEditorIfFocusLost(root: HTMLElement | null, leaving: Element | null) {
  const active = document.activeElement;
  if (active === null || active === document.body || (leaving?.contains(active) ?? false)) {
    root?.focus();
  }
}

/**
 * Preview/Edit state for Markdown files. Switching keeps the draft: leaving
 * Edit copies the textarea's live value out before Preview renders it.
 */
function useMarkdownViewMode(
  path: string,
  rootRef: RefObject<HTMLDivElement | null>,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  onLeaveEdit: (draft: string) => void
) {
  const isMarkdown = getLanguageFromPath(path) === "markdown";
  const [mode, setMode] = useState<ViewMode>(isMarkdown ? "preview" : "edit");
  // Chromium resets scrollTop while an element is display:none.
  const editScrollTopRef = useRef(0);

  // Focus the editor on open so its shortcuts work at once (the clicked row
  // unmounts, so focus would fall to <body>). Never the textarea: opening a
  // file to read it must not pop up the phone keyboard.
  useEffect(() => {
    rootRef.current?.focus();
  }, [rootRef]);

  const switchMode = (next: ViewMode) => {
    const textarea = textareaRef.current;
    // No textarea means a load error, which shows the same message in both modes.
    if (next === mode || textarea === null) return;
    if (next === "preview") {
      onLeaveEdit(textarea.value);
      editScrollTopRef.current = textarea.scrollTop;
      focusEditorIfFocusLost(rootRef.current, textarea);
      setMode(next);
      return;
    }
    // Show the textarea synchronously so it can take focus in this handler.
    flushSync(() => setMode(next));
    textarea.focus();
    textarea.scrollTop = editScrollTopRef.current;
  };

  return {
    isMarkdown,
    mode,
    switchMode,
    toggle: () => switchMode(mode === "preview" ? "edit" : "preview"),
  };
}

interface MemoryFileHeaderProps {
  path: string;
  /** Only Markdown files have a preview. */
  showModeToggle: boolean;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  saveDisabled: boolean;
  saving: boolean;
  onBack: () => void;
  onSave: () => void;
}

function MemoryFileHeader(props: MemoryFileHeaderProps) {
  return (
    <div className="border-border-light flex items-center gap-2 border-b px-2 py-2">
      <RowActionButton aria-label="Back to memory list" onClick={props.onBack}>
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      </RowActionButton>
      <MemoryFilePath path={props.path} />
      {props.showModeToggle && (
        <TooltipIfPresent
          tooltip={
            <>
              Toggle preview
              <span className="mobile-hide-shortcut-hints">
                {" "}
                ({formatKeybind(KEYBINDS.TOGGLE_MARKDOWN_PREVIEW)})
              </span>
            </>
          }
        >
          <div className="shrink-0">
            <ToggleGroup
              options={VIEW_MODE_OPTIONS}
              value={props.mode}
              onChange={props.onModeChange}
              // The tooltip describes this wrapper, not the focused button.
              keyShortcuts={formatKeybindForAria(KEYBINDS.TOGGLE_MARKDOWN_PREVIEW)}
            />
          </div>
        </TooltipIfPresent>
      )}
      <Button
        size="sm"
        aria-label="Save memory file"
        disabled={props.saveDisabled}
        onClick={props.onSave}
      >
        {props.saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

/**
 * The directory part truncates first so the file name stays readable on a
 * phone; the name truncates only when it alone is wider than the slot.
 */
function MemoryFilePath(props: { path: string }) {
  const nameStart = props.path.lastIndexOf("/") + 1;
  return (
    <span className="flex min-w-0 flex-1 text-xs font-medium">
      <span className="min-w-0 truncate">{props.path.slice(0, nameStart)}</span>
      <span className="max-w-full shrink-0 truncate">{props.path.slice(nameStart)}</span>
    </span>
  );
}

function SaveErrorBanner(props: {
  error: MemorySaveError;
  onReload: (button: HTMLElement) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-xs",
        props.error.kind === "conflict" ? "bg-warning/10 text-warning" : "bg-error/10 text-error"
      )}
      role="alert"
    >
      <span className="min-w-0 flex-1">{props.error.message}</span>
      {props.error.kind === "conflict" && (
        <RowActionButton
          className="shrink-0"
          aria-label="Reload memory file"
          onClick={(e) => props.onReload(e.currentTarget)}
        >
          Reload
        </RowActionButton>
      )}
    </div>
  );
}
