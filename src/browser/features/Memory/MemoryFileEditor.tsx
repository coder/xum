import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { RowActionButton } from "@/browser/features/RightSidebar/GoalBoardSections";
import { isAbortError } from "@/browser/utils/isAbortError";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type { MemorySaveError } from "@/common/orpc/schemas/memory";
import { getErrorMessage } from "@/common/utils/errors";

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

  const handleReload = () => {
    setSaveError(null);
    setReloadTick((n) => n + 1);
  };

  return (
    // h-full fills block parents (sidebar tabpanel); flex-1 fills flex parents
    // (Settings → Memory). Each is inert in the other context.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border-light flex items-center gap-2 border-b px-2 py-2">
        <RowActionButton aria-label="Back to memory list" onClick={props.onBack}>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </RowActionButton>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.path}</span>
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
      ) : (
        <textarea
          ref={textareaRef}
          // flex-1 fills the available height; the min-h floor keeps the
          // editor usable on very short viewports.
          className="min-h-48 flex-1 resize-none bg-transparent p-3 font-mono text-xs outline-none"
          aria-label="Memory file content"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (matchesKeybind(e, KEYBINDS.SAVE_EDIT)) {
              e.preventDefault();
              void handleSave();
            }
          }}
        />
      )}
    </div>
  );
}
