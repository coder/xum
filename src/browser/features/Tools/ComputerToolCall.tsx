import React from "react";
import type { z } from "zod";

import type { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import { ToolResultImages, extractImagesFromToolResult } from "./Shared/ToolResultImages";
import {
  getStatusDisplay,
  isToolErrorResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

type ComputerToolArgs = z.infer<typeof TOOL_DEFINITIONS.computer.schema>;

const CLICK_LABELS = {
  left_click: "Click",
  right_click: "Right-click",
  middle_click: "Middle-click",
  double_click: "Double-click",
} as const;

function formatPoint(x: number | null | undefined, y: number | null | undefined): string {
  return x != null && y != null ? ` (${x}, ${y})` : "";
}

/** One-line header label for a computer action, e.g. "Click (640, 412)". */
export function summarizeComputerAction(args: ComputerToolArgs | undefined): string {
  if (args == null) {
    return "Computer";
  }
  switch (args.action) {
    case "screenshot":
      return "Screenshot";
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
      return `${CLICK_LABELS[args.action]}${formatPoint(args.x, args.y)}`;
    case "mouse_move":
      return `Move mouse${formatPoint(args.x, args.y)}`;
    case "left_click_drag":
      return `Drag${formatPoint(args.startX, args.startY)} →${formatPoint(args.x, args.y)}`;
    case "scroll":
      return `Scroll ${args.scrollDirection ?? ""} x${args.scrollAmount ?? 3}`;
    case "type": {
      const count = Array.from(args.text ?? "").length;
      return `Type ${count} ${count === 1 ? "character" : "characters"}`;
    }
    case "key":
      return `Key ${args.text ?? ""}`.trim();
    case "wait":
      return `Wait ${args.durationSeconds ?? ""}s`;
    case "cursor_position":
      return "Cursor position";
  }
}

function getResultText(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as { type?: unknown; value?: unknown };
  if (record.type !== "content" || !Array.isArray(record.value)) return null;
  for (const item of record.value as Array<{ type?: unknown; text?: unknown }>) {
    if (item.type === "text" && typeof item.text === "string") return item.text;
  }
  return null;
}

interface ComputerToolCallProps {
  args?: ComputerToolArgs;
  result?: unknown;
  status?: ToolStatus;
}

export const ComputerToolCall: React.FC<ComputerToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion();
  const errorResult = isToolErrorResult(props.result) ? props.result : null;
  const hasImages = extractImagesFromToolResult(props.result).length > 0;
  const resultText = getResultText(props.result);
  const hasDetails = hasImages || errorResult !== null || resultText !== null;
  const shouldShowDetails = expanded || hasImages || errorResult !== null;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={shouldShowDetails}>▶</ExpandIcon>}
        <ToolIcon toolName="computer" />
        <ToolName className="min-w-0 truncate">{summarizeComputerAction(props.args)}</ToolName>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {shouldShowDetails && (
        <ToolDetails>
          {resultText && !errorResult && (
            <div className="text-secondary mb-2 text-[11px]">{resultText}</div>
          )}
          {hasImages && <ToolResultImages result={props.result} />}
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
