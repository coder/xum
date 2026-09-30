import { useState, type ReactElement } from "react";
import { Bot, Braces, ChevronRight, CircleCheck, Radio } from "lucide-react";

import { cn } from "@/common/lib/utils";
import { getThinkingOptionLabel } from "@/common/types/thinking";
import type { SubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ModelDisplay } from "./ModelDisplay";

export { parseSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";

export function formatSubagentStructuredOutput(report: SubagentReportEnvelope): string | undefined {
  if (report.structuredOutput === undefined) return undefined;
  if (typeof report.structuredOutput === "string") return report.structuredOutput;
  return JSON.stringify(report.structuredOutput, null, 2);
}

interface SubagentReportMessageContentProps {
  report: SubagentReportEnvelope;
}

/**
 * Present trusted sub-agent findings as transcript content rather than exposing the model-facing
 * XML protocol. The existing user bubble owns the border and surface, avoiding nested card chrome.
 */
export function SubagentReportMessageContent(
  props: SubagentReportMessageContentProps
): ReactElement {
  // Reports can be lengthy and numerous, so keep the transcript scannable until the user opts in.
  const [reportExpanded, setReportExpanded] = useState(false);
  const [structuredOutputExpanded, setStructuredOutputExpanded] = useState(false);
  const structuredOutputJson = formatSubagentStructuredOutput(props.report);
  const isInProgress = props.report.status === "in_progress";
  const StatusIcon = isInProgress ? Radio : CircleCheck;
  const statusLabel = isInProgress ? "In progress" : "Completed";

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={reportExpanded}
        aria-label={`${reportExpanded ? "Hide" : "Show"} subagent report details`}
        onClick={() => setReportExpanded((previous) => !previous)}
        className="hover:bg-muted/10 focus-visible:ring-ring focus-visible:ring-offset-background flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <Bot aria-hidden="true" className="text-muted mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-snug font-medium text-[var(--color-user-text)]">
            {props.report.title}
          </div>
          <div className="text-muted mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-snug">
            <span className="truncate">{props.report.agentType}</span>
            {props.report.model && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">
                  <ModelDisplay modelString={props.report.model} />
                </span>
              </>
            )}
            {props.report.thinkingLevel != null && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">
                  thinking: {getThinkingOptionLabel(props.report.thinkingLevel, props.report.model)}
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1",
                isInProgress ? "text-backgrounded" : "text-success"
              )}
            >
              <StatusIcon aria-hidden="true" className="size-3" />
              {statusLabel}
            </span>
          </div>
        </div>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "text-muted mt-0.5 size-4 shrink-0 transition-transform duration-200",
            reportExpanded && "rotate-90"
          )}
        />
      </button>

      {reportExpanded && (
        <>
          <MarkdownRenderer
            content={props.report.reportMarkdown}
            className="mt-2 text-sm leading-relaxed text-[var(--color-user-text)]"
          />

          {structuredOutputJson && (
            <div className="mt-2 border-t border-[var(--color-user-border)] pt-2">
              <button
                type="button"
                aria-expanded={structuredOutputExpanded}
                onClick={() => setStructuredOutputExpanded((previous) => !previous)}
                className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3 transition-transform duration-200",
                    structuredOutputExpanded && "rotate-90"
                  )}
                />
                <Braces aria-hidden="true" className="size-3" />
                Structured output
              </button>
              {structuredOutputExpanded && (
                <pre className="bg-code-bg mt-2 max-h-[40vh] max-w-full overflow-auto rounded-sm p-2 font-mono text-xs leading-relaxed whitespace-pre text-[var(--color-user-text)]">
                  {structuredOutputJson}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
