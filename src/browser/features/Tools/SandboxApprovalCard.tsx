import { useEffect, useState } from "react";
import { Lock, TriangleAlert } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useLiveAPI } from "@/browser/contexts/API";
import { useChatPaneScope } from "@/browser/contexts/ChatPaneScopeContext";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { CONNECTION_LOST_MESSAGE } from "@/browser/contexts/connectionLink";
import {
  formatKeybind,
  formatKeybindForAria,
  KEYBINDS,
  matchesKeybind,
  paneHandlesKeyEvent,
} from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type { Keybind } from "@/common/types/keybind";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DetailContent,
  DetailLabel,
  ErrorBox,
  ToolContainer,
  ToolIcon,
} from "./Shared/ToolPrimitives";

/** The warning badge with a lock that marks what the sandbox did, or what it waits for. */
export function SandboxBadge(props: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "border-warning/40 bg-warning-overlay text-warning inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        props.className
      )}
    >
      <Lock aria-hidden="true" size={10} />
      {props.label}
    </span>
  );
}

interface SandboxApprovalCardProps {
  workspaceId: string;
  toolCallId: string;
  script: string;
  reason: string;
  /** The newest card of the workspace: only it answers the keyboard shortcuts. */
  isLatest: boolean;
}

/**
 * A bash call that the sandbox blocked waits here for the user to let it run once outside. The
 * card shows only while the backend waits; one answer is for this call, never remembered.
 */
export function SandboxApprovalCard(props: SandboxApprovalCardProps) {
  const api = useLiveAPI();
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paneScope = useChatPaneScope();
  const selectedWorkspaceId = useOptionalWorkspaceContext()?.selectedWorkspace?.workspaceId;

  const answer = (approved: boolean) => {
    if (answering) return;
    if (api == null) {
      setError(CONNECTION_LOST_MESSAGE);
      return;
    }
    setAnswering(true);
    setError(null);
    api.workspace
      .answerSandboxApproval({
        workspaceId: props.workspaceId,
        toolCallId: props.toolCallId,
        approved,
      })
      .then(
        (result) => {
          if (!result.success) setError(result.error);
        },
        (answerError: unknown) => setError(getErrorMessage(answerError))
      )
      // On success the card goes away once the backend stops waiting.
      .finally(() => setAnswering(false));
  };

  // The shortcuts answer only the newest card, in the pane and workspace that show it, the way
  // the plan card's shortcut does. A chord with three modifiers, so typing never approves.
  useEffect(() => {
    if (!props.isLatest) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const approved = matchesKeybind(event, KEYBINDS.RUN_OUTSIDE_SANDBOX)
        ? true
        : matchesKeybind(event, KEYBINDS.DENY_OUTSIDE_SANDBOX)
          ? false
          : null;
      if (approved === null || event.defaultPrevented) return;
      if (!paneHandlesKeyEvent(paneScope, event.target)) return;
      if (
        paneScope === "main" &&
        selectedWorkspaceId !== undefined &&
        selectedWorkspaceId !== props.workspaceId
      ) {
        return;
      }
      event.preventDefault();
      if (event.repeat) return;
      answer(approved);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <ToolContainer expanded className="border-warning/40 bg-warning-overlay border">
      <div className="flex min-w-0 items-center gap-2">
        <ToolIcon toolName="bash" />
        <span className="text-text font-monospace min-w-0 flex-1 truncate">{props.script}</span>
        <SandboxBadge label="Needs approval" />
      </div>
      <div className="mt-2 space-y-2 font-sans">
        <div>
          <DetailLabel>Reason from the agent</DetailLabel>
          <DetailContent className="px-2 py-1.5 font-sans whitespace-pre-wrap">
            {props.reason}
          </DetailContent>
        </div>
        <div className="text-warning flex items-start gap-1.5 text-[11px]">
          <TriangleAlert aria-hidden="true" size={12} className="mt-px shrink-0" />
          <span>
            Runs once outside the sandbox, with full access to your files, keys and network.
          </span>
        </div>
        {error !== null && (
          <ErrorBox role="alert" className="wrap-anywhere">
            {error}
          </ErrorBox>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={answering}
            onClick={() => answer(false)}
            aria-keyshortcuts={
              props.isLatest ? formatKeybindForAria(KEYBINDS.DENY_OUTSIDE_SANDBOX) : undefined
            }
          >
            Deny
            {props.isLatest && <ShortcutHint keybind={KEYBINDS.DENY_OUTSIDE_SANDBOX} />}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={answering}
            onClick={() => answer(true)}
            aria-keyshortcuts={
              props.isLatest ? formatKeybindForAria(KEYBINDS.RUN_OUTSIDE_SANDBOX) : undefined
            }
          >
            Run outside once
            {props.isLatest && <ShortcutHint keybind={KEYBINDS.RUN_OUTSIDE_SANDBOX} />}
          </Button>
        </div>
      </div>
    </ToolContainer>
  );
}

function ShortcutHint(props: { keybind: Keybind }) {
  return (
    <span aria-hidden="true" className="mobile-hide-shortcut-hints opacity-70">
      ({formatKeybind(props.keybind)})
    </span>
  );
}
