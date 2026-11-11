import React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import {
  ExpandIcon,
  LoadingDots,
  ToolContainer,
  ToolIcon,
} from "@/browser/features/Tools/Shared/ToolPrimitives";
import type { OperationalBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";

interface OperationalBundleMessageProps {
  item: OperationalBundleInfo;
  expanded: boolean;
  onToggle: () => void;
}

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function OperationalBundleMessage(props: OperationalBundleMessageProps): React.ReactElement {
  const isActive = props.item.state === "active";
  const isTaskAwaitBundle = props.item.entries.every(
    (entry) => entry.message.type === "tool" && entry.message.toolName === "task_await"
  );

  if (isTaskAwaitBundle) {
    // Task waits keep the tool-row typography of the standalone task_await card they replace.
    const title = isActive
      ? (props.item.summary.activeTitle ?? props.item.summary.title)
      : props.item.summary.title;
    return (
      <ToolContainer data-testid="operational-bundle" expanded={false} className="bg-transparent">
        <button
          type="button"
          className={cn(
            "text-secondary hover:text-foreground flex w-full cursor-pointer items-center gap-2 text-left transition-colors select-none",
            FOCUS_RING
          )}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <ExpandIcon expanded={props.expanded} className="text-muted shrink-0">
            ▶
          </ExpandIcon>
          <ToolIcon toolName="task_await" className="text-task-mode" />
          <span
            data-component="OperationalBundleSummary"
            className="text-secondary min-w-0 flex-1 truncate text-[11px] leading-5"
          >
            <span
              className={cn(
                props.item.summary.tone === "danger" && "text-danger",
                props.item.summary.tone === "interrupted" && "text-interrupted"
              )}
            >
              {title}
            </span>
            {props.item.summary.details && (
              <span className="text-muted"> · {props.item.summary.details}</span>
            )}
          </span>
        </button>
      </ToolContainer>
    );
  }

  // Other bundles read like Claude Code / Codex / Cursor summary lines: one muted sentence in the
  // transcript's prose font ("Explored 3 files, 2 queries"), a chevron after it, nothing else.
  // The chevron is quiet until hover or focus, except while the row is open.
  return (
    <div className="my-1.5 px-1">
      <button
        type="button"
        data-testid="operational-bundle"
        className={cn(
          "group text-muted hover:text-secondary inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left text-[13px] leading-5 transition-colors select-none",
          FOCUS_RING
        )}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span className="min-w-0 truncate">{props.item.summary.title}</span>
        {isActive && <LoadingDots aria-hidden="true" />}
        {props.item.summary.details && (
          <span className="text-danger shrink-0">· {props.item.summary.details}</span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-[transform,opacity]",
            props.expanded
              ? "rotate-90 opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
          )}
        />
      </button>
    </div>
  );
}
