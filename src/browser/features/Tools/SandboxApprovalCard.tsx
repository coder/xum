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
  type ChatPaneScope,
} from "@/browser/utils/ui/keybinds";
import type { BashSandboxApprovalView } from "@/browser/stores/WorkspaceStore";
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
  approval: BashSandboxApprovalView;
  /** The newest card of the workspace: only it answers the keyboard shortcuts. */
  isLatest: boolean;
}

/** True for the run-outside chord, false for the deny chord, null for any other key. */
function chordAnswer(event: KeyboardEvent): boolean | null {
  if (matchesKeybind(event, KEYBINDS.RUN_OUTSIDE_SANDBOX)) return true;
  if (matchesKeybind(event, KEYBINDS.DENY_OUTSIDE_SANDBOX)) return false;
  return null;
}

/**
 * Whether a window key event belongs to the card of `workspaceId`, the way the plan card's
 * shortcut decides: only its own pane, and in the main pane only the selected workspace (hosts
 * without a workspace context show one transcript).
 */
function keyEventTargetsWorkspace(
  event: KeyboardEvent,
  paneScope: ChatPaneScope,
  selectedWorkspaceId: string | undefined,
  workspaceId: string
): boolean {
  if (!paneHandlesKeyEvent(paneScope, event.target)) return false;
  return (
    paneScope !== "main" || selectedWorkspaceId === undefined || selectedWorkspaceId === workspaceId
  );
}

/** Sends the user's answer for one bash call; on success the card goes once the wait ends. */
function useSandboxApprovalAnswer(approval: BashSandboxApprovalView) {
  const api = useLiveAPI();
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        workspaceId: approval.workspaceId,
        toolCallId: approval.toolCallId,
        approved,
      })
      .then(
        (result) => {
          if (!result.success) setError(result.error);
        },
        (answerError: unknown) => setError(getErrorMessage(answerError))
      )
      .finally(() => setAnswering(false));
  };
  return { answer, answering, error };
}

/**
 * The shortcuts answer only the newest card, in the pane and workspace that show it. A chord
 * with three modifiers, so typing never approves.
 */
function useSandboxApprovalShortcuts(
  workspaceId: string,
  isLatest: boolean,
  answer: (approved: boolean) => void
) {
  const paneScope = useChatPaneScope();
  const selectedWorkspaceId = useOptionalWorkspaceContext()?.selectedWorkspace?.workspaceId;
  useEffect(() => {
    if (!isLatest) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const approved = chordAnswer(event);
      if (
        approved === null ||
        event.defaultPrevented ||
        !keyEventTargetsWorkspace(event, paneScope, selectedWorkspaceId, workspaceId)
      ) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) answer(approved);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });
}

function AnswerButton(props: {
  label: string;
  keybind: Keybind;
  /** Only the newest card shows and announces its shortcut. */
  showShortcut: boolean;
  variant?: "outline";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={props.variant}
      size="sm"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-keyshortcuts={props.showShortcut ? formatKeybindForAria(props.keybind) : undefined}
    >
      {props.label}
      {props.showShortcut && (
        <span aria-hidden="true" className="mobile-hide-shortcut-hints opacity-70">
          ({formatKeybind(props.keybind)})
        </span>
      )}
    </Button>
  );
}

/**
 * A bash call that the sandbox blocked waits here for the user to let it run once outside. The
 * card shows only while the backend waits; one answer is for this call, never remembered.
 */
export function SandboxApprovalCard(props: SandboxApprovalCardProps) {
  const { answer, answering, error } = useSandboxApprovalAnswer(props.approval);
  useSandboxApprovalShortcuts(props.approval.workspaceId, props.isLatest, answer);

  return (
    <ToolContainer expanded className="border-warning/40 bg-warning-overlay border">
      <div className="flex min-w-0 items-center gap-2">
        <ToolIcon toolName="bash" />
        <span className="text-text font-monospace min-w-0 flex-1 truncate">
          {props.approval.script}
        </span>
        <SandboxBadge label="Needs approval" />
      </div>
      <div className="mt-2 space-y-2 font-sans">
        <div>
          <DetailLabel>Command</DetailLabel>
          <DetailContent className="scroll-fade-y px-2 py-1.5">
            {props.approval.script}
          </DetailContent>
        </div>
        <div>
          <DetailLabel>Reason from the agent</DetailLabel>
          <DetailContent className="px-2 py-1.5 font-sans whitespace-pre-wrap">
            {props.approval.reason}
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
          <AnswerButton
            label="Deny"
            keybind={KEYBINDS.DENY_OUTSIDE_SANDBOX}
            showShortcut={props.isLatest}
            variant="outline"
            disabled={answering}
            onClick={() => answer(false)}
          />
          <AnswerButton
            label="Run outside once"
            keybind={KEYBINDS.RUN_OUTSIDE_SANDBOX}
            showShortcut={props.isLatest}
            disabled={answering}
            onClick={() => answer(true)}
          />
        </div>
      </div>
    </ToolContainer>
  );
}
