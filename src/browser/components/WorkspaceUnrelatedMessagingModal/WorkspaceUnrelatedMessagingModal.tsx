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
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import type { Result } from "@/common/types/result";

interface WorkspaceUnrelatedMessagingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * False on runtimes that cannot take part in unrelated messaging (remote/container). The
   * consent switch and its disclosure are hidden there; the hold preference still applies to
   * same-tree senders.
   */
  consentSupported: boolean;
  /**
   * Current persisted consent, derived from workspace metadata (`unrelatedWorkspaceConsent`
   * present). The modal never keeps its own copy: the switch only moves when the backend has
   * committed the change and republished metadata.
   */
  enabled: boolean;
  /** Persists the new state; resolves only after the backend has committed and published it. */
  onSetEnabled: (enabled: boolean) => Promise<Result<void, string>>;
  /**
   * True when this chat holds incoming agent messages until its turn ends (persisted
   * `agentMessageDispatchMode === "turn-end"`). Same source-of-truth rule as `enabled`.
   */
  holdUntilTurnEnd: boolean;
  /** Persists the delivery preference; same commit-then-publish contract as `onSetEnabled`. */
  onSetHoldUntilTurnEnd: (hold: boolean) => Promise<Result<void, string>>;
  /**
   * Current persisted messaging tag (without `@`), derived from workspace metadata. Same
   * source-of-truth rule as `enabled`: the input shows this once no edit is in progress.
   * Shown on every runtime — remote/container chats are the point of tag linking.
   */
  messagingTag: string | undefined;
  /** Persists the tag (`null` clears it); same commit-then-publish contract as `onSetEnabled`. */
  onSetMessagingTag: (tag: string | null) => Promise<Result<void, string>>;
  /**
   * True only for root chats. Sub-agent children and side chats cannot carry a tag
   * (the backend refuses), so the editor is hidden for them instead of failing on save.
   */
  tagSupported: boolean;
}

/**
 * One switch controlling incoming messages from unrelated local workspaces (other task trees in
 * this Xum instance) and, where cross-workspace discovery is available, whether they can list this
 * chat. The copy states discovery conditionally: this dialog ships before discovery does, and must
 * not promise an exposure that is not yet wired. Same-tree messaging is unaffected. The consent is
 * application-level: any process running as the same user with access to the config can change
 * it, so the copy below avoids claiming isolation. *
 * The second switch is the recipient's delivery preference for busy-time agent messages. It also
 * covers same-tree senders (sub-agents, siblings), so it stays usable while consent is off.
 */
export function WorkspaceUnrelatedMessagingModal(props: WorkspaceUnrelatedMessagingModalProps) {
  // Which switch has a request in flight: the "Saving" status renders beside that switch, and
  // both switches stay locked so requests never overlap.
  const [savingSetting, setSavingSetting] = useState<"consent" | "hold" | "tag" | null>(null);
  const isSaving = savingSetting != null;
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may settle the pending/error state (rapid toggles, unmounts).
  const latestRequestIdRef = useRef(0);
  const handleToggle = async (
    setting: "consent" | "hold" | "tag",
    save: () => Promise<Result<void, string>>
  ): Promise<boolean> => {
    const requestId = ++latestRequestIdRef.current;
    setSavingSetting(setting);
    setError(null);
    let result: Result<void, string>;
    try {
      result = await save();
    } catch (caught) {
      result = {
        success: false,
        error: caught instanceof Error ? caught.message : "Failed to update the setting.",
      };
    }
    if (requestId !== latestRequestIdRef.current) {
      // A newer request owns the state; callers must not touch the UI on its behalf.
      return true;
    }
    setSavingSetting(null);
    if (!result.success) {
      setError(result.error);
    }
    return result.success;
  };

  const saveMessagingTag = (tag: string | null) =>
    handleToggle("tag", () => props.onSetMessagingTag(tag));

  const HoldDescription = props.consentSupported ? "div" : DialogDescription;

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
          {props.consentSupported && (
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
                    chat&apos;s task tree. On by default for new chats you create, and for chats an
                    agent creates once their first turn ends; same-tree sub-agents are unaffected.
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {savingSetting === "consent" && (
                    <span role="status" className="text-muted text-xs">
                      Saving
                    </span>
                  )}
                  <Switch
                    checked={props.enabled}
                    onCheckedChange={(checked) =>
                      void handleToggle("consent", () => props.onSetEnabled(checked))
                    }
                    disabled={isSaving}
                    aria-labelledby="unrelated-messaging-consent-label"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tag linking works on every runtime (remote/container chats are the point), so
              this row is never gated on consentSupported — only on being a root chat.
              Only the user can set a tag. */}
          <MessagingTagSetting
            supported={props.tagSupported}
            messagingTag={props.messagingTag}
            disabled={isSaving}
            saving={savingSetting === "tag"}
            onSaveTag={saveMessagingTag}
          />

          <div className="border-border rounded-lg border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div id="agent-message-hold-label" className="text-foreground text-sm font-medium">
                  Hold agent messages until the turn ends
                </div>
                {/* Radix links the dialog to exactly one Description; the hold copy takes that role when the
                    consent row (which holds it otherwise) is hidden on remote runtimes. */}
                <HoldDescription className="text-muted mt-1 text-xs">
                  Off by default: while this chat is busy, messages that agents send it (from its
                  sub-agents, sibling tasks, and other workspaces) arrive after the next step. Turn
                  on to make them, including sub-agent reports, wait for the current turn to end.
                </HoldDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {savingSetting === "hold" && (
                  <span role="status" className="text-muted text-xs">
                    Saving
                  </span>
                )}
                <Switch
                  checked={props.holdUntilTurnEnd}
                  onCheckedChange={(checked) =>
                    void handleToggle("hold", () => props.onSetHoldUntilTurnEnd(checked))
                  }
                  disabled={isSaving}
                  aria-labelledby="agent-message-hold-label"
                />
              </div>
            </div>
          </div>

          {props.consentSupported && (
            <ul className="text-muted list-disc space-y-1.5 pl-5 text-xs">
              <li>
                While on, other local agents can send this chat messages. Where cross-workspace
                discovery is available, they can also list this chat&apos;s title, branch name,
                project path, and busy/idle state.
              </li>
              <li>
                Incoming messages arrive as untrusted agent text. If this chat is idle, they wake it
                and spend provider tokens under this chat&apos;s own model and agent settings; if it
                is busy, they arrive after its next step unless you hold them until the turn ends.
              </li>
              <li>
                Turning this off stops new deliveries and removes this chat from any such listing.
                Messages already received stay in the transcript, and a reply that is already
                running finishes. After an app restart, resume these turns yourself.
              </li>
            </ul>
          )}

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
interface MessagingTagSettingProps {
  /** False for sub-agent children and side chats, which cannot carry a tag. */
  supported: boolean;
  /** Persisted tag (without `@`) from published metadata; the only source of truth. */
  messagingTag: string | undefined;
  disabled: boolean;
  saving: boolean;
  /** Resolves true when the save succeeded (metadata publication owns the display). */
  onSaveTag: (tag: string | null) => Promise<boolean>;
}

/**
 * The messaging-tag row. The input is uncontrolled, keyed by the persisted tag: a save
 * reads the DOM value on blur/submit, and only a failed save resets it to the persisted
 * text — on success the republished metadata (which may arrive before the ack) owns the
 * display, so writing the old text back would clobber the newly keyed input.
 */
/** Empty drafts clear the tag; anything else is sent raw for backend normalization. */
function draftToTag(draft: string): string | null {
  return draft.trim() === "" ? null : draft;
}

function MessagingTagSetting(props: MessagingTagSettingProps) {
  const persistedTagText = props.messagingTag != null ? `@${props.messagingTag}` : "";
  const tagInputRef = useRef<HTMLInputElement>(null);
  if (!props.supported) return null;

  const save = async (draft: string) => {
    if (draft === persistedTagText) {
      return;
    }
    const saved = await props.onSaveTag(draftToTag(draft));
    if (!saved && tagInputRef.current) {
      tagInputRef.current.value = persistedTagText;
    }
  };
  const submitDraft = () => {
    const input = tagInputRef.current;
    if (input) {
      void save(input.value);
    }
  };

  return (
    <div className="border-border rounded-lg border p-4">
      <div className="min-w-0">
        <label htmlFor="messaging-tag-input" className="text-foreground text-sm font-medium">
          Messaging tag
        </label>
        <p className="text-muted mt-1 text-xs">
          Give this chat a tag such as <span className="font-mono">@research</span> and give the
          same tag to other chats you want it to exchange agent messages with. Only you can set or
          clear a tag; clearing it removes the link.
        </p>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
        >
          <Input
            key={persistedTagText}
            ref={tagInputRef}
            id="messaging-tag-input"
            defaultValue={persistedTagText}
            onBlur={(event) => void save(event.currentTarget.value)}
            disabled={props.disabled}
            placeholder="@research"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1"
          />
          {props.saving && (
            <span role="status" className="text-muted shrink-0 text-xs">
              Saving
            </span>
          )}
        </form>
      </div>
    </div>
  );
}
