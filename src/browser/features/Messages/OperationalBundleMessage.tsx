import React from "react";
import { cn } from "@/common/lib/utils";
import {
  ExpandIcon,
  ToolContainer,
  ToolIcon,
} from "@/browser/features/Tools/Shared/ToolPrimitives";
import type { OperationalBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";

interface OperationalBundleMessageProps {
  item: OperationalBundleInfo;
  expanded: boolean;
  onToggle: () => void;
}

export function OperationalBundleMessage(props: OperationalBundleMessageProps): React.ReactElement {
  const title =
    props.item.state === "active"
      ? (props.item.summary.activeTitle ??
        `Running ${props.item.entries.length.toLocaleString()} ${
          props.item.entries.length === 1 ? "operation" : "operations"
        }`)
      : props.item.summary.title;
  const details = props.item.entries.length === 1 ? "" : props.item.summary.details;
  const isTaskAwaitBundle = props.item.entries.every(
    (entry) => entry.message.type === "tool" && entry.message.toolName === "task_await"
  );

  return (
    <ToolContainer data-testid="operational-bundle" expanded={false} className="bg-transparent">
      <button
        type="button"
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 text-left text-secondary transition-colors select-none hover:text-foreground",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        )}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <ExpandIcon expanded={props.expanded} className="text-muted shrink-0">
          ▶
        </ExpandIcon>
        {isTaskAwaitBundle && <ToolIcon toolName="task_await" className="text-task-mode" />}
        <span
          data-component={isTaskAwaitBundle ? "OperationalBundleSummary" : undefined}
          className={cn(
            "text-secondary min-w-0 flex-1 truncate leading-5",
            isTaskAwaitBundle ? "text-[11px]" : "text-sm"
          )}
        >
          <span
            className={cn(
              props.item.summary.tone === "danger" && "text-danger",
              props.item.summary.tone === "interrupted" && "text-interrupted"
            )}
          >
            {title}
          </span>
          {details && <span className="text-muted"> · {details}</span>}
        </span>
      </button>
    </ToolContainer>
  );
}
