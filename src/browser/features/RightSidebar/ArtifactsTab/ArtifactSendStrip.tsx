import { Send, X } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { formatKeybind, KEYBINDS, type Keybind } from "@/browser/utils/ui/keybinds";
import type { useConfirmArmed } from "./confirmArming";

export interface PendingArtifactSend {
  /** Unique per shown strip (newConfirmPromptId), so the Send delay re-arms each time. */
  id: number;
  text: string;
  data?: unknown;
  /** The version on screen when the artifact asked (null: the live file). */
  version: number | null;
}

/**
 * Host-owned confirm strip for `window.xum.send` (M5b). It lives outside the artifact frame, so
 * the artifact cannot click it. Nothing is focused on open: Enter only sends while the user has
 * focused the Send button themselves (native button behavior). Send stays disabled for a moment
 * after the strip appears (confirmArming.ts); the hook that renders the strip owns that arming, so
 * its Send shortcut waits for it too (useArtifactInteractions.tsx).
 */
export function ArtifactSendStrip(props: {
  pending: PendingArtifactSend;
  arming: ReturnType<typeof useConfirmArmed>;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  onDismiss: () => void;
}) {
  const arming = props.arming;
  const dataText =
    props.pending.data === undefined ? null : JSON.stringify(props.pending.data, null, 0);
  return (
    <div
      role="region"
      aria-label="Message from artifact"
      className="border-border-light bg-sidebar flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 text-xs"
      data-testid="artifact-send-strip"
    >
      <div className="text-muted text-[11px]">The artifact wants to send this message:</div>
      <div className="text-foreground max-h-24 overflow-auto break-words whitespace-pre-wrap">
        {props.pending.text}
      </div>
      {dataText != null && (
        <code className="text-muted font-monospace max-h-16 overflow-auto text-[11px] break-all">
          {dataText}
        </code>
      )}
      {props.error != null && <div className="text-danger text-[11px]">{props.error}</div>}
      <div className="flex justify-end gap-1.5">
        <TooltipIfPresent
          tooltip={<ShortcutHint label="Dismiss" keybind={KEYBINDS.DISMISS_ARTIFACT_MESSAGE} />}
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={props.sending}
            onClick={props.onDismiss}
          >
            <X />
            Dismiss
          </Button>
        </TooltipIfPresent>
        <TooltipIfPresent
          tooltip={<ShortcutHint label="Send" keybind={KEYBINDS.SEND_ARTIFACT_MESSAGE} />}
        >
          <Button
            type="button"
            size="xs"
            disabled={props.sending || !arming.armed}
            onPointerDown={arming.onPointerDown}
            onClick={(event) => arming.guardClick(event, props.onSend)}
          >
            <Send />
            Send
          </Button>
        </TooltipIfPresent>
      </div>
    </div>
  );
}

/** Tooltip text with the shortcut, which is hidden on mobile like the panel's other hints. */
function ShortcutHint(props: { label: string; keybind: Keybind }) {
  return (
    <>
      {props.label}
      <span className="mobile-hide-shortcut-hints"> ({formatKeybind(props.keybind)})</span>
    </>
  );
}
