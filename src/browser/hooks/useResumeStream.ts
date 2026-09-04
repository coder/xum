import { useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { getErrorMessage } from "@/common/utils/errors";

export interface UseResumeStreamResult {
  /** Continue the interrupted stream from where it stopped. */
  resume: () => Promise<void>;
  /** True while a resume request is in flight; guards against double-trigger. */
  isResuming: boolean;
  /** Last resume error, if any. */
  error: string | null;
}

/**
 * One-shot "continue from where it stopped" for the interrupted divider and its
 * keybind. A user who pressed Esc asked to stop, so this never flips the
 * auto-retry preference (RetryBarrier owns its own auto-retry recovery for
 * system/error interrupts). resumeStream does no history shaping; the model just
 * continues the partial assistant turn. Auto-retry-enabled users still get
 * backend recovery, since the backend consults the persisted preference on failure.
 *
 * `resetKey` (the resume target message id) augments the identity so transient
 * state can't bleed across workspaces or across interrupted turns.
 */
export function useResumeStream(
  workspaceId: string,
  resetKey?: string | null
): UseResumeStreamResult {
  const { api } = useAPI();
  const workspaceState = useWorkspaceState(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [isResuming, setIsResuming] = useState(false);

  // ChatPane owns this hook and stays mounted across workspace/target changes, so
  // reset transient state when identity changes (adjust-during-render, no effect)
  // and track the live identity so a late-resolving resume can't write onto it.
  const identity = `${workspaceId}\u0000${resetKey ?? ""}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const [trackedIdentity, setTrackedIdentity] = useState(identity);
  if (identity !== trackedIdentity) {
    setTrackedIdentity(identity);
    setError(null);
    setIsResuming(false);
  }

  const resume = async (): Promise<void> => {
    if (!api) {
      setError("Not connected to server");
      return;
    }
    if (isResuming) {
      return;
    }

    const startedForIdentity = identity;
    const applyIfCurrent = (apply: () => void): void => {
      if (latestIdentity.current === startedForIdentity) apply();
    };

    setIsResuming(true);
    setError(null);
    try {
      let options = getSendOptionsFromStorage(workspaceId);
      const lastUserMessage = [...workspaceState.messages]
        .reverse()
        .find(
          (message): message is Extract<typeof message, { type: "user" }> => message.type === "user"
        );
      if (lastUserMessage?.compactionRequest) {
        options = applyCompactionOverrides(options, lastUserMessage.compactionRequest.parsed);
      }

      const result = await api.workspace.resumeStream({ workspaceId, options });
      if (!result.success) {
        const formatted = formatSendMessageError(result.error);
        applyIfCurrent(() =>
          setError(
            formatted.resolutionHint
              ? `${formatted.message} ${formatted.resolutionHint}`
              : formatted.message
          )
        );
      }
    } catch (err) {
      applyIfCurrent(() => setError(getErrorMessage(err)));
    } finally {
      applyIfCurrent(() => setIsResuming(false));
    }
  };

  return { resume, isResuming, error };
}
