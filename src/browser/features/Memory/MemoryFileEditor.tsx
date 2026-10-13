import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { ToggleGroup, type ToggleOption } from "@/browser/components/ToggleGroup/ToggleGroup";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { MarkdownFilePreview } from "@/browser/features/Messages/MarkdownFilePreview";
import { RowActionButton } from "@/browser/features/RightSidebar/GoalBoardSections";
import { isAbortError } from "@/browser/utils/isAbortError";
import { formatKeybind, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
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
  const isMarkdown = getLanguageFromPath(props.path) === "markdown";
  const [mode, setMode] = useState<ViewMode>(isMarkdown ? "preview" : "edit");

  // Focus the editor on open so its shortcuts work at once (the clicked row
  // unmounts, so focus would fall to <body>). Never the textarea: opening a
  // file to read it must not pop up the phone keyboard.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

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
    }
  };

  const switchMode = (next: ViewMode) => {
    if (next === mode) return;
    if (next === "preview") {
      const textarea = textareaRef.current;
      if (textarea) setDraft(textarea.value);
      // The textarea unmounts; keep focus inside the editor so the next
      // shortcut press still reaches it.
      if (textarea !== null && document.activeElement === textarea) rootRef.current?.focus();
    }
    setMode(next);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (matchesKeybind(e, KEYBINDS.SAVE_EDIT)) {
      e.preventDefault();
      void handleSave();
    } else if (isMarkdown && matchesKeybind(e, KEYBINDS.TOGGLE_MARKDOWN_PREVIEW)) {
      e.preventDefault();
      switchMode(mode === "preview" ? "edit" : "preview");
    }
  };

  const handleReload = () => {
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
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 flex-1 flex-col outline-none"
    >
      <div className="border-border-light flex items-center gap-2 border-b px-2 py-2">
        <RowActionButton aria-label="Back to memory list" onClick={props.onBack}>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </RowActionButton>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.path}</span>
        {isMarkdown && (
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
              <ToggleGroup options={VIEW_MODE_OPTIONS} value={mode} onChange={switchMode} />
            </div>
          </TooltipIfPresent>
        )}
        <Button
          size="sm"
          aria-label="Save memory file"
          disabled={loaded === null || saving}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {saveError !== null && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-xs",
            saveError.kind === "conflict" ? "bg-warning/10 text-warning" : "bg-error/10 text-error"
          )}
          role="alert"
        >
          <span className="min-w-0 flex-1">{saveError.message}</span>
          {saveError.kind === "conflict" && (
            <RowActionButton
              className="shrink-0"
              aria-label="Reload memory file"
              onClick={handleReload}
            >
              Reload
            </RowActionButton>
          )}
        </div>
      )}
      {loadError !== null ? (
        <div className="text-error px-3 py-2 text-xs" role="alert">
          {loadError}
        </div>
      ) : mode === "preview" ? (
        <div className="min-h-48 flex-1 overflow-auto p-3">
          <MarkdownFilePreview content={draft} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          // flex-1 fills the available height; the min-h floor keeps the
          // editor usable on very short viewports.
          className="min-h-48 flex-1 resize-none bg-transparent p-3 font-mono text-xs outline-none"
          aria-label="Memory file content"
          value={draft}
          spellCheck={false}
          // Only Markdown files open in Preview, so a mounting textarea there
          // means the user switched to Edit and wants to type.
          autoFocus={isMarkdown}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
    </div>
  );
}
