import React from "react";

import type { AgentReportToolArgs, AgentReportToolResult } from "@/common/types/tools";

import { ErrorBox } from "./Shared/ToolPrimitives";
import { AgentCommunicationCard } from "./Shared/AgentCommunicationCard";
import { isToolErrorResult, type ToolStatus } from "./Shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface LegacyAgentReportFileArgs {
  reportMarkdownPath?: string | null;
  structuredOutputPath?: string | null;
  title?: string | null;
}

type AgentReportRenderableArgs = AgentReportToolArgs | LegacyAgentReportFileArgs;

interface AgentReportToolCallProps {
  args: AgentReportRenderableArgs;
  result?: AgentReportToolResult;
  status?: ToolStatus;
}

function getSubmittedReportMarkdown(
  args: AgentReportRenderableArgs,
  result: AgentReportToolResult | undefined
): string {
  if (result && "success" in result && result.success === true && result.report?.reportMarkdown) {
    return result.report.reportMarkdown;
  }
  if ("reportMarkdown" in args) {
    return args.reportMarkdown;
  }
  return `Report file: ${args.reportMarkdownPath ?? "report.md"}`;
}

export const AgentReportToolCall: React.FC<AgentReportToolCallProps> = (props) => {
  const reportMarkdown = getSubmittedReportMarkdown(props.args, props.result);
  const failedResult = props.result?.success === false ? props.result : null;

  return (
    <AgentCommunicationCard
      toolName="agent_report"
      title={props.args.title ?? "Agent update"}
      destination="To parent"
      status={failedResult ? "failed" : (props.status ?? "pending")}
      preview={reportMarkdown}
      initiallyExpanded
      error={
        failedResult && (
          <ErrorBox className="mt-2" role="alert">
            {isToolErrorResult(failedResult) ? (
              failedResult.error
            ) : (
              <>
                {failedResult.message}
                {failedResult.errors.map((error, index) => (
                  <div key={index}>
                    {error.path}: {error.message}
                  </div>
                ))}
              </>
            )}
          </ErrorBox>
        )
      }
    >
      <MarkdownRenderer content={reportMarkdown} className="text-sm leading-relaxed" />
    </AgentCommunicationCard>
  );
};
