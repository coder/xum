import { Send, X } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useConfirmArmed } from "./confirmArming";

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
 * after the strip appears (confirmArming.ts).
 */
export function ArtifactSendStrip(props: {
  pending: PendingArtifactSend;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  onDismiss: () => void;
}) {
  const arming = useConfirmArmed(props.pending.id);
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
        <Button type="button" variant="outline" size="xs" onClick={props.onDismiss}>
          <X />
          Dismiss
        </Button>
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
      </div>
    </div>
  );
}
