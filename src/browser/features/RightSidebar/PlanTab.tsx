import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Play } from "lucide-react";
import { useLiveAPI } from "@/browser/contexts/API";
import { useOptionalWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { MarkdownCore } from "@/browser/features/Messages/MarkdownCore";
import { PlanMarkdownContainer } from "@/browser/features/Messages/MarkdownRenderer";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useOptionalWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { showFeedbackToast } from "@/browser/utils/feedbackToast";
import { NO_RUNNABLE_PLAN_MESSAGE, runLatestPlanAction } from "@/browser/utils/latestPlanAction";
import { openInEditor } from "@/browser/utils/openInEditor";
import { getPlanTabScrollTopKey } from "@/common/constants/storage";
import { TAB_ICONS } from "./Tabs/tabIcons";
import { usePlanFile } from "./usePlanFile";

interface PlanTabProps {
  workspaceId: string;
}

/**
 * The right sidebar's Plan tab: the workspace's plan file, next to the chat instead of in a
 * modal, with the plan card's main actions. Keyed by workspace, so another workspace starts
 * from an empty body instead of showing the previous plan while its own loads.
 */
export const PlanTab: React.FC<PlanTabProps> = (props) => (
  <PlanTabBody key={props.workspaceId} workspaceId={props.workspaceId} />
);

/** The plan reader's wording for a workspace without a plan (getWorkspacePlanContent). */
const NO_PLAN_ERROR_PREFIX = "Plan file not found";

function normalizeScrollTop(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

const ACTION_CLASS =
  "text-subtle hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50";

function PlanTabBody(props: { workspaceId: string }) {
  const { workspaceId } = props;
  const api = useLiveAPI();
  const runtimeConfig =
    useOptionalWorkspaceMetadata()?.workspaceMetadata.get(workspaceId)?.runtimeConfig;

  // The plan has no push channel, so it is re-read at the moments it can have changed: a turn
  // ending (the plan agent writes the file during its turn) and the window regaining focus
  // (an external editor).
  const [refreshKey, setRefreshKey] = useState(0);
  const isStreaming = useOptionalWorkspaceSidebarState(workspaceId)?.canInterrupt === true;
  const [wasStreaming, setWasStreaming] = useState(isStreaming);
  if (wasStreaming !== isStreaming) {
    setWasStreaming(isStreaming);
    if (!isStreaming) setRefreshKey((key) => key + 1);
  }
  useEffect(() => {
    const handleFocus = () => setRefreshKey((key) => key + 1);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  const { isLoading, error, content, path } = usePlanFile(workspaceId, refreshKey);
  const { copied, copyToClipboard } = useCopyToClipboard();
  const hasPlan = content !== null && content.length > 0;

  // Leaving the workspace or switching tabs unmounts this body: keep the plan's scroll offset
  // per workspace. Tracked while scrolling, saved on unmount, restored once the plan renders
  // (the body has its height only then). A re-read keeps the body, so its offset stays.
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  useEffect(() => {
    if (!hasPlan) return;
    const saved = normalizeScrollTop(
      readPersistedState<unknown>(getPlanTabScrollTopKey(workspaceId), 0)
    );
    scrollTopRef.current = saved;
    if (bodyRef.current) bodyRef.current.scrollTop = saved;
  }, [hasPlan, workspaceId]);
  useEffect(() => {
    return () => {
      updatePersistedState<number>(getPlanTabScrollTopKey(workspaceId), scrollTopRef.current, 0);
    };
  }, [workspaceId]);

  const handleImplement = () => {
    if (!runLatestPlanAction(workspaceId)) {
      showFeedbackToast({ type: "error", message: NO_RUNNABLE_PLAN_MESSAGE });
    }
  };

  const handleOpenInEditor = async () => {
    if (path === null) return;
    const result = await openInEditor({
      api,
      workspaceId,
      targetPath: path,
      runtimeConfig,
      isFile: true,
    });
    if (!result.success) {
      showFeedbackToast({ type: "error", message: result.error ?? "Failed to open editor" });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border-primary flex flex-col gap-1 border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground inline-flex items-center gap-1.5 text-xs font-medium">
            <TAB_ICONS.plan className="h-3.5 w-3.5 shrink-0" />
            Plan
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={ACTION_CLASS}
              onClick={handleImplement}
              disabled={!hasPlan}
            >
              <Play className="h-3 w-3" />
              Implement
            </button>
            <button
              type="button"
              className={ACTION_CLASS}
              onClick={() => void handleOpenInEditor()}
              disabled={path === null}
            >
              <ExternalLink className="h-3 w-3" />
              Edit
            </button>
            <button
              type="button"
              className={ACTION_CLASS}
              onClick={() => void copyToClipboard(content ?? "")}
              disabled={!hasPlan}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        {path && (
          <code className="text-muted truncate font-mono text-[10px]" data-testid="plan-tab-path">
            {path}
          </code>
        )}
      </div>

      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto p-3"
        data-testid="plan-tab-body"
        onScroll={(event) => {
          scrollTopRef.current = normalizeScrollTop(event.currentTarget.scrollTop);
        }}
      >
        {error ? (
          <div className="flex flex-col gap-2">
            <div className="text-muted text-[11px] italic" data-testid="plan-tab-error">
              {error}
            </div>
            {error.startsWith(NO_PLAN_ERROR_PREFIX) && (
              <div className="text-muted text-[11px]">
                Switch to the Plan agent and ask for a plan; it shows here as the agent writes it.
              </div>
            )}
          </div>
        ) : isLoading ? (
          <div className="text-muted text-[11px] italic">Loading plan…</div>
        ) : content !== null ? (
          hasPlan ? (
            <PlanMarkdownContainer>
              {/* Keyed by the text: a reload replaces the plan in place, and Streamdown's
                  elements re-render only when their source position changes, so an edit that
                  keeps the positions would otherwise stay stale on screen. */}
              <MarkdownCore key={content} content={content} />
            </PlanMarkdownContainer>
          ) : (
            <div className="text-muted text-[11px] italic">Plan file is empty</div>
          )
        ) : (
          <div className="text-muted text-[11px] italic">No plan loaded</div>
        )}
      </div>
    </div>
  );
}
