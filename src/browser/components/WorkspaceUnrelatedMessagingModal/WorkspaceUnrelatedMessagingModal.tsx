import { useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { Switch } from "@/browser/components/Switch/Switch";
import type { Result } from "@/common/types/result";

interface WorkspaceUnrelatedMessagingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Current persisted consent, derived from workspace metadata (`unrelatedWorkspaceConsent`
   * present). The modal never keeps its own copy: the switch only moves when the backend has
   * committed the change and republished metadata.
   */
  enabled: boolean;
  /** Persists the new state; resolves only after the backend has committed and published it. */
  onSetEnabled: (enabled: boolean) => Promise<Result<void, string>>;
}

/**
 * One switch controlling incoming messages from unrelated local workspaces (other task trees in
 * this Xum instance) and, where cross-workspace discovery is available, whether they can list this
 * chat. The copy states discovery conditionally: this dialog ships before discovery does, and must
 * not promise an exposure that is not yet wired. Same-tree messaging is unaffected. The consent is
 * application-level: any process running as the same user with access to the config can change
 * it, so the copy below avoids claiming isolation.
 */
export function WorkspaceUnrelatedMessagingModal(props: WorkspaceUnrelatedMessagingModalProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may settle the pending/error state (rapid toggles, unmounts).
  const latestRequestIdRef = useRef(0);

  const handleToggle = async (next: boolean) => {
    const requestId = ++latestRequestIdRef.current;
    setIsSaving(true);
    setError(null);
    let result: Result<void, string>;
    try {
      result = await props.onSetEnabled(next);
    } catch (caught) {
      result = {
        success: false,
        error: caught instanceof Error ? caught.message : "Failed to update the setting.",
      };
    }
    if (requestId !== latestRequestIdRef.current) {
      return;
    }
    setIsSaving(false);
    if (!result.success) {
      setError(result.error);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-border border-b px-6 py-5 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <MessagesSquare className="h-5 w-5" />
            Messages from other workspaces
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
          <div className="border-border rounded-lg border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div
                  id="unrelated-messaging-consent-label"
                  className="text-foreground text-sm font-medium"
                >
                  Allow messages from unrelated workspaces
                </div>
                <DialogDescription className="text-muted mt-1 text-xs">
                  Applies to agents in other local chats in this Xum instance, outside this
                  chat&apos;s task tree. On by default for new top-level chats; same-tree sub-agents
                  are unaffected.
                </DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isSaving && (
                  <span role="status" className="text-muted text-xs">
                    Saving
                  </span>
                )}
                <Switch
                  checked={props.enabled}
                  onCheckedChange={(checked) => void handleToggle(checked)}
                  disabled={isSaving}
                  aria-labelledby="unrelated-messaging-consent-label"
                />
              </div>
            </div>
          </div>

          <ul className="text-muted list-disc space-y-1.5 pl-5 text-xs">
            <li>
              While on, other local agents can send this chat messages. Where cross-workspace
              discovery is available, they can also list this chat&apos;s title, branch name,
              project path, and busy/idle state.
            </li>
            <li>
              Incoming messages arrive as untrusted agent text. If this chat is idle, they wake it
              and spend provider tokens under this chat&apos;s own model and agent settings; if it
              is busy, they queue for the end of the current turn by default (a sender may request
              the next tool boundary instead, which interrupts sooner).
            </li>
            <li>
              Turning this off stops new deliveries and removes this chat from any such listing.
              Messages already received stay in the transcript, and a reply that is already running
              finishes. After an app restart, resume these turns yourself.
            </li>
          </ul>

          {error != null && (
            <div role="alert" className="bg-danger-soft/10 text-danger-soft rounded-md p-3 text-sm">
              {error}
            </div>
          )}
        </div>

        <div className="border-border flex justify-end border-t px-6 py-4">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
