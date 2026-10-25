import React, { useEffect, useRef } from "react";
import { useChatHostContext } from "@/browser/contexts/ChatHostContext";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { openArtifact } from "@/browser/features/RightSidebar/ArtifactsTab/openArtifact";
import type { ArtifactKind } from "@/common/utils/artifactKind";
import {
  ArtifactToolResultSchema,
  type ArtifactToolSuccessResult,
} from "@/common/utils/tools/toolDefinitions";
import {
  ErrorBox,
  StatusIndicator,
  ToolContainer,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  normalizeToolResultForRendering,
  type ToolStatus,
} from "./Shared/toolUtils";

/** Short kind tags for chat cards only; the Artifacts picker never shows them. */
const KIND_TAGS: Record<ArtifactKind, string> = {
  html: "HTML",
  markdown: "MD",
  json: "JSON",
  svg: "SVG",
  csv: "CSV",
  image: "IMG",
  text: "TXT",
  mermaid: "MMD",
  pdf: "PDF",
  diff: "DIFF",
  canvas: "CANVAS",
};

interface ArtifactToolCallProps {
  toolName: string;
  args?: { path?: string; focus?: boolean | null };
  result?: unknown;
  status?: ToolStatus;
  workspaceId?: string;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Chat card for the `artifact` tool: "<KIND> name · v<N> · title", opening the Artifacts tab
 * at that exact version. It renders from the tool result alone (no lookups), so the card
 * survives compaction and older-history paging.
 */
export const ArtifactToolCall: React.FC<ArtifactToolCallProps> = (props) => {
  const parsed =
    props.result == null
      ? null
      : ArtifactToolResultSchema.safeParse(normalizeToolResultForRendering(props.result));
  const published: ArtifactToolSuccessResult | null =
    parsed?.success === true && parsed.data.success ? parsed.data : null;
  // Hosts without an Artifacts surface (VS Code webview), or with the experiment off, keep the
  // card but never dispatch an open nobody listens for.
  const artifactsEnabled = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS);
  const canOpen = useChatHostContext().uiSupport.artifactsPanel === "supported" && artifactsEnabled;
  const workspaceId = canOpen ? props.workspaceId : undefined;

  // `focus` opens the tab once, when the result arrives live. A card that mounts with its
  // result already present (history replay, remounts) never saw the call pending and stays put.
  const sawPendingRef = useRef(props.result == null);
  const focusRequested = props.args?.focus === true;
  useEffect(() => {
    if (props.result == null) {
      sawPendingRef.current = true;
      return;
    }
    if (!sawPendingRef.current) return;
    sawPendingRef.current = false;
    if (published && focusRequested && workspaceId) {
      openArtifact({ workspaceId, path: published.path, versionId: published.version });
    }
  }, [props.result, published, focusRequested, workspaceId]);

  if (published == null) {
    const status = props.status ?? "pending";
    const error =
      parsed?.success === true && !parsed.data.success
        ? parsed.data.error
        : parsed?.success === false
          ? "Unexpected result from the artifact tool."
          : null;
    return (
      <ToolContainer expanded={error != null}>
        <ToolHeader className="cursor-default">
          <ToolIcon toolName="artifact" />
          <ToolName>artifact</ToolName>
          {props.args?.path && (
            <span className="text-muted min-w-0 truncate">{props.args.path}</span>
          )}
          <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
        </ToolHeader>
        {error != null && <ErrorBox className="mt-1">{error}</ErrorBox>}
      </ToolContainer>
    );
  }

  const showTitle = published.title.length > 0 && published.title !== basename(published.path);
  return (
    <ToolContainer expanded={false}>
      <button
        type="button"
        disabled={!workspaceId}
        aria-label={`Open ${published.path} version ${published.version} in Artifacts`}
        onClick={() => {
          if (!workspaceId) return;
          openArtifact({ workspaceId, path: published.path, versionId: published.version });
        }}
        className="border-accent hover:bg-accent/10 focus-visible:ring-accent flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-dashed px-2.5 py-2 text-left font-sans text-[13px] focus-visible:ring-1 focus-visible:outline-none disabled:cursor-default"
      >
        <span className="border-border-medium text-muted shrink-0 rounded-full border px-2 py-px text-[11px] leading-4">
          {KIND_TAGS[published.kind]}
        </span>
        <span className="min-w-0 truncate">
          <strong className="text-foreground font-semibold">{published.path}</strong>
          <span className="text-secondary">
            {" "}
            · <span className="counter-nums">v{published.version}</span>
            {showTitle && ` · ${published.title}`}
          </span>
        </span>
      </button>
    </ToolContainer>
  );
};
