import { useState, type ReactElement } from "react";
import { Bot, Braces, ChevronRight, CircleCheck, Radio } from "lucide-react";

import { cn } from "@/common/lib/utils";
import type { SubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { ExpandIcon, FOLDED_ROW_TEXT_CLASS } from "@/browser/features/Tools/Shared/ToolPrimitives";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ModelDisplay, ThinkingLevelLabel } from "./ModelDisplay";

export { parseSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";

export function formatSubagentStructuredOutput(report: SubagentReportEnvelope): string | undefined {
  if (report.structuredOutput === undefined) return undefined;
  if (typeof report.structuredOutput === "string") return report.structuredOutput;
  return JSON.stringify(report.structuredOutput, null, 2);
}

interface SubagentReportMessageContentProps {
  report: SubagentReportEnvelope;
}

/** Who wrote the report: the agent's type, its model and its thinking level. */
function ReportAuthorLine(props: { report: SubagentReportEnvelope }): ReactElement {
  return (
    <div className="text-muted flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-snug">
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
            thinking:{" "}
            <ThinkingLevelLabel
              level={props.report.thinkingLevel}
              modelString={props.report.model}
            />
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Present trusted sub-agent findings as transcript content rather than exposing the model-facing
 * XML protocol. Closed, a report is one line like a tool call's (its title and whether the
 * sub-agent is done): reports arrive in the middle of the agent's work, several at a time, and a
 * card each made them the loudest rows of the turn. The report itself is one click away.
 */
export function SubagentReportMessageContent(
  props: SubagentReportMessageContentProps
): ReactElement {
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
        className={cn(
          "text-muted hover:text-foreground focus-visible:outline-primary flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
          FOLDED_ROW_TEXT_CLASS
        )}
      >
        <Bot aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="text-foreground min-w-0 truncate">{props.report.title}</span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1",
            isInProgress ? "text-backgrounded" : "text-success-text"
          )}
        >
          <StatusIcon aria-hidden="true" className="size-3" />
          {statusLabel}
        </span>
        <ExpandIcon expanded={reportExpanded} />
      </button>

      {reportExpanded && (
        <div className="mt-1.5 pl-5">
          <ReportAuthorLine report={props.report} />
          <MarkdownRenderer
            content={props.report.reportMarkdown}
            className="mt-2 text-sm leading-relaxed"
          />

          {structuredOutputJson && (
            <div className="border-border mt-2 border-t pt-2">
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
                <pre className="bg-code-bg mt-2 max-h-[40vh] max-w-full overflow-auto rounded-sm p-2 font-mono text-xs leading-relaxed whitespace-pre">
                  {structuredOutputJson}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
