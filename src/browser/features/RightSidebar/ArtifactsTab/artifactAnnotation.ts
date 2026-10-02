import {
  ARTIFACT_ANNOTATION_CONTEXT_CHARS,
  ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS,
} from "@/common/constants/artifactInteractions";
import type { ArtifactAnnotationAnchor } from "@/common/types/review";
import type { ArtifactFrameToHostMessage } from "./artifactBridge";

/**
 * Annotate mode (Artifacts M5b): a comment target picked in the viewer, plus the viewport point
 * the comment popover opens at. Comments become review notes attached to the composer.
 */
export interface ArtifactAnnotationPick {
  anchor: ArtifactAnnotationAnchor;
  clientX: number;
  clientY: number;
}

/** Kinds rendered by Xum components (text selection) and kinds in the sandboxed frame (pins). */
export type ArtifactAnnotationSupport = "host" | "frame";

export function getArtifactAnnotationSupport(kind: string): ArtifactAnnotationSupport | null {
  switch (kind) {
    case "markdown":
    case "json":
    case "csv":
    case "text":
    case "canvas":
      return "host";
    case "html":
    case "svg":
      return "frame";
    default:
      return null;
  }
}

/**
 * Text anchor for a selection inside `container`: the quote (capped) and a little context on
 * each side, taken from the rendered text. Null when the selection is empty or leaves the
 * container.
 */
export function textAnchorFromSelection(
  container: HTMLElement,
  selection: Selection | null
): ArtifactAnnotationPick | null {
  if (selection == null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const quote = range.toString().trim();
  if (quote.length === 0) return null;

  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);

  const rect = range.getBoundingClientRect();
  return {
    anchor: {
      kind: "text",
      quote: quote.slice(0, ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS),
      prefix: before.toString().slice(-ARTIFACT_ANNOTATION_CONTEXT_CHARS),
      suffix: after.toString().slice(0, ARTIFACT_ANNOTATION_CONTEXT_CHARS),
    },
    clientX: rect.left,
    clientY: rect.bottom,
  };
}

/**
 * A validated pin from the sandboxed frame; frame-relative fractions map onto `frameRect`.
 *
 * SECURITY AUDIT: the frame runs artifact code, so every field of its message is attacker
 * controlled, and the anchor goes into a user-role prompt. Keep only what the popover and the
 * review card show (the quote, or the pin position); the frame's selector and quote context are
 * dropped so hidden text cannot ride along with a comment the user approved (Codex r5).
 */
export function pickFromFrameAnnotation(
  message: Extract<ArtifactFrameToHostMessage, { type: "annotate" }>,
  frameRect: Pick<DOMRect, "left" | "top" | "width" | "height">
): ArtifactAnnotationPick {
  const anchor: ArtifactAnnotationAnchor =
    message.quote != null
      ? { kind: "text", quote: message.quote, prefix: "", suffix: "" }
      : { kind: "point", x: message.x, y: message.y };
  return {
    anchor,
    clientX: frameRect.left + message.x * frameRect.width,
    clientY: frameRect.top + message.y * frameRect.height,
  };
}
