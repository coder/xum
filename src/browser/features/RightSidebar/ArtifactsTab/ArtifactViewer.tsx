import React from "react";
import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";
import { MermaidPendingFrame } from "@/browser/features/Messages/MermaidPendingFrame";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactImageMimeType } from "@/common/utils/artifactKind";
import { formatBytes } from "@/common/utils/formatBytes";
import { downloadArtifact, openArtifactInNewWindow } from "./artifactDownload";
import { CodeArtifact } from "./CodeArtifact";
import { CsvArtifact } from "./CsvArtifact";
import { DiffArtifact } from "./DiffArtifact";
import { ImageArtifact } from "./ImageArtifact";
import { JsonArtifact } from "./JsonArtifact";
import { MarkdownArtifact } from "./MarkdownArtifact";
import { SandboxedArtifactFrame, type ArtifactFrameKey } from "./SandboxedArtifactFrame";
import { Notice, NoteBar } from "./SourceText";
import type { ArtifactAnnotationPick } from "./artifactAnnotation";
import type { ArtifactInteractionHandlers } from "./artifactInteractions";
import { useAgentBrowserAvailable } from "./useAgentBrowserAvailable";

// Lazy so the `mermaid` package stays off the first load (T3, #5971): diagrams render only
// when an artifact or message contains one.
const Mermaid = React.lazy(() =>
  import("@/browser/features/Messages/Mermaid").then((m) => ({ default: m.Mermaid }))
);
// Lazy so `recharts` stays off the first load (T3, #5971): canvases render only when opened.
const CanvasArtifact = React.lazy(() =>
  import("./CanvasArtifact").then((m) => ({ default: m.CanvasArtifact }))
);

// Every renderer here goes through React elements, so artifact content (agent-written,
// therefore untrusted) is always escaped. HTML and SVG only ever render inside
// SandboxedArtifactFrame; never route them through dangerouslySetInnerHTML.

const actionButtonClassName =
  "border-border-light text-foreground hover:bg-hover inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs focus-visible:ring-1 focus-visible:ring-accent";

function TooLarge(props: {
  path: string;
  absolutePath: string | null;
  size: number;
  maxBytes: number;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();
  return (
    <Notice>
      <div>
        <strong className="text-foreground break-all">{props.path}</strong> is too large to preview
        ({formatBytes(props.size)}; the limit is {formatBytes(props.maxBytes)}).
      </div>
      {props.absolutePath != null && (
        <button
          type="button"
          onClick={() => void copyToClipboard(props.absolutePath ?? "")}
          className={`${actionButtonClassName} mt-2`}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy path"}
        </button>
      )}
    </Notice>
  );
}

function PdfArtifact(props: { result: Extract<ArtifactReadResult, { status: "ok" }> }) {
  // The desktop app's window-open handler only forwards http(s) URLs, so a blob URL cannot open
  // there; Download hands the file to the OS viewer instead.
  const canOpen = !isDesktopMode();
  return (
    <Notice>
      <div>PDF files are not previewed in the app.</div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => downloadArtifact(props.result)}
          className={actionButtonClassName}
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
        {canOpen && (
          <button
            type="button"
            onClick={() => openArtifactInNewWindow(props.result)}
            className={actionButtonClassName}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </button>
        )}
      </div>
    </Notice>
  );
}

export const AGENT_BROWSER_MISSING_WARNING =
  "Not checked by the agent: agent-browser is not available on this runtime.";

/**
 * HTML and SVG are the artifacts the agent can check with agent-browser; when the runtime has
 * none, say so above the frame (null means unknown, which shows nothing).
 */
function SandboxedArtifactWithCheckNotice(
  props: React.ComponentProps<typeof SandboxedArtifactFrame> & {
    /** The workspace whose runtime is probed; `workspaceId` may be null (no relative assets). */
    checkWorkspaceId: string;
  }
) {
  const { checkWorkspaceId, ...frameProps } = props;
  const agentBrowserAvailable = useAgentBrowserAvailable(checkWorkspaceId);
  // One stable tree, so the answer arriving never remounts (reloads) the frame.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {agentBrowserAvailable === false && <NoteBar>{AGENT_BROWSER_MISSING_WARNING}</NoteBar>}
      <div className="min-h-0 flex-1">
        <SandboxedArtifactFrame {...frameProps} />
      </div>
    </div>
  );
}

export function ArtifactViewer(props: {
  result: ArtifactReadResult;
  workspaceId: string;
  /** Absolute artifacts dir, for "Copy path" on files too large to preview. */
  artifactsDir?: string | null;
  /** Escape / Shift+F pressed inside a sandboxed HTML/SVG frame. */
  onFrameKey?: (key: ArtifactFrameKey) => void;
  /**
   * Resolve relative images/assets through the artifacts folder (default). Off for pinned
   * checkout files, whose neighbours live in the checkout, not the artifacts folder.
   */
  readRelativeAssets?: boolean;
  /** Host side of artifact interactions (M5b); absent where artifacts are read-only. */
  interactions?: ArtifactInteractionHandlers;
  /** Set only while annotate mode is on: pins clicked inside an HTML/SVG frame (M5b). */
  onFrameAnnotate?: (pick: ArtifactAnnotationPick) => void;
  /** Bumped by panel refreshes; renderers that read referenced files re-read them (canvas). */
  reloadToken?: number;
  /**
   * Identifies the shown file version. Renderers keep view choices (the JSON mode) per key, so
   * they survive remounts such as fullscreen or a sidebar tab switch.
   */
  viewKey?: string;
}) {
  const result = props.result;
  const assetWorkspaceId = props.readRelativeAssets === false ? null : props.workspaceId;
  if (result.status === "too_large") {
    return (
      <TooLarge
        path={result.path}
        absolutePath={props.artifactsDir != null ? `${props.artifactsDir}/${result.path}` : null}
        size={result.size}
        maxBytes={result.maxBytes}
      />
    );
  }
  if (result.status === "binary") {
    return (
      <Notice>
        <strong className="text-foreground">{result.path}</strong> is a binary file and cannot be
        previewed.
      </Notice>
    );
  }
  switch (result.kind) {
    case "markdown":
      return (
        <MarkdownArtifact
          content={result.content}
          path={result.path}
          workspaceId={assetWorkspaceId}
        />
      );
    case "json":
      return <JsonArtifact content={result.content} path={result.path} viewKey={props.viewKey} />;
    case "image": {
      const mime = getArtifactImageMimeType(result.path);
      if (mime == null || result.encoding !== "base64") {
        return <Notice>This image cannot be displayed.</Notice>;
      }
      return <ImageArtifact src={`data:${mime};base64,${result.content}`} alt={result.path} />;
    }
    case "html":
    case "svg":
      return (
        <SandboxedArtifactWithCheckNotice
          checkWorkspaceId={props.workspaceId}
          workspaceId={assetWorkspaceId}
          path={result.path}
          kind={result.kind}
          content={result.content}
          onFrameKey={props.onFrameKey}
          interactions={props.interactions}
          onAnnotate={props.onFrameAnnotate}
        />
      );
    case "csv":
      return <CsvArtifact content={result.content} path={result.path} />;
    case "mermaid":
      return (
        <div className="p-3">
          <LazyFeature name="Diagram" fallback={<MermaidPendingFrame />}>
            <Mermaid chart={result.content} />
          </LazyFeature>
        </div>
      );
    case "diff":
      return <DiffArtifact content={result.content} />;
    case "pdf":
      return <PdfArtifact result={result} />;
    case "canvas":
      return (
        <LazyFeature name="Canvas">
          <CanvasArtifact
            content={result.content}
            path={result.path}
            workspaceId={assetWorkspaceId}
            interactions={props.interactions}
            reloadToken={props.reloadToken}
          />
        </LazyFeature>
      );
    case "text":
      return <CodeArtifact content={result.content} path={result.path} />;
  }
}
