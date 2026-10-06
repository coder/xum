import { useLayoutEffect, useRef, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import type { ArtifactAnnotationPick } from "./artifactAnnotation";

const POPOVER_WIDTH_PX = 288;
/** Rough height, used only to flip the popover above the target near the bottom edge. */
const POPOVER_HEIGHT_PX = 170;
const EDGE_PX = 8;

/**
 * Comment box for annotate mode (Artifacts M5b), opened at the selection or pin with a fixed
 * position. Rendered inline (not portaled) next to the viewer, inside the fullscreen overlay when
 * that is open. Submitting adds a review note to the composer; nothing is sent by itself.
 */
export function ArtifactAnnotationPopover(props: {
  pick: ArtifactAnnotationPick;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // `fixed` is relative to the nearest transformed ancestor (the centered Artifacts dialog on
  // narrow windows), not the viewport. A zero-size probe at fixed 0,0 measures that origin so
  // viewport coordinates from the selection still land on it.
  const probeRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const rect = probeRef.current?.getBoundingClientRect();
    if (rect != null && (rect.left !== origin.x || rect.top !== origin.y)) {
      setOrigin({ x: rect.left, y: rect.top });
    }
  }, [origin.x, origin.y]);
  const anchor = props.pick.anchor;
  const maxLeft = window.innerWidth - Math.min(POPOVER_WIDTH_PX, window.innerWidth) - EDGE_PX;
  const left = Math.max(EDGE_PX, Math.min(props.pick.clientX, maxLeft));
  const below = props.pick.clientY + 6;
  const top =
    below + POPOVER_HEIGHT_PX > window.innerHeight
      ? Math.max(EDGE_PX, props.pick.clientY - POPOVER_HEIGHT_PX - 6)
      : below;
  // Uncontrolled: the text is read once, on submit; an empty comment is ignored.
  const submit = () => {
    const trimmed = textareaRef.current?.value.trim() ?? "";
    if (trimmed.length > 0) props.onSubmit(trimmed);
  };

  return (
    <>
      <div ref={probeRef} aria-hidden className="pointer-events-none fixed top-0 left-0 h-0 w-0" />
      <div
        role="dialog"
        aria-label="Comment on artifact"
        style={{ left: left - origin.x, top: top - origin.y, width: POPOVER_WIDTH_PX }}
        className="border-border-light bg-sidebar fixed z-[60] flex max-w-[calc(100vw-16px)] flex-col gap-1.5 rounded border p-2 text-xs shadow-lg"
        data-testid="artifact-annotation-popover"
      >
        <div className="text-muted line-clamp-2 text-[11px] break-words">
          {anchor.kind === "text"
            ? `“${anchor.quote}”`
            : `Pin at ${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%`}
        </div>
        <textarea
          autoFocus
          aria-label="Comment"
          ref={textareaRef}
          onKeyDown={(e) => {
            if (matchesKeybind(e, KEYBINDS.SAVE_EDIT)) {
              e.preventDefault();
              submit();
            } else if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
              e.preventDefault();
              stopKeyboardPropagation(e);
              props.onCancel();
            }
          }}
          rows={3}
          placeholder="Comment"
          className="border-border-light bg-background text-foreground resize-none rounded border p-1.5 text-xs outline-none"
        />
        <div className="flex justify-end gap-1.5">
          <Button type="button" variant="outline" size="xs" onClick={props.onCancel}>
            <X />
            Cancel
          </Button>
          <Button type="button" size="xs" onClick={submit}>
            <MessageSquarePlus />
            Comment
          </Button>
        </div>
      </div>
    </>
  );
}
