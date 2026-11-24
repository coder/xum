import React from "react";
import type { AgentSkillReadToolArgs } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  type ToolStatus,
  isToolErrorResult,
} from "./Shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";
import { JsonHighlight } from "./Shared/HighlightedCode";

interface AgentSkillReadToolCallProps {
  args: AgentSkillReadToolArgs;
  result?: unknown;
  status?: ToolStatus;
}

interface AgentSkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
}

interface AgentSkillPackage {
  scope: string;
  directoryName: string;
  frontmatter: AgentSkillFrontmatter;
  body: string;
}

function isAgentSkillPackage(val: unknown): val is AgentSkillPackage {
  if (!val || typeof val !== "object") return false;
  const record = val as Record<string, unknown>;

  if (typeof record.scope !== "string") return false;
  if (typeof record.directoryName !== "string") return false;
  if (typeof record.body !== "string") return false;

  const frontmatter = record.frontmatter;
  if (!frontmatter || typeof frontmatter !== "object") return false;
  const fm = frontmatter as Record<string, unknown>;

  if (typeof fm.name !== "string") return false;
  if (typeof fm.description !== "string") return false;

  return true;
}

function isAgentSkillReadSuccessResult(
  val: unknown
): val is { success: true; skill: AgentSkillPackage } {
  if (!val || typeof val !== "object") return false;
  const record = val as Record<string, unknown>;
  if (record.success !== true) return false;
  return isAgentSkillPackage(record.skill);
}

export const AgentSkillReadToolCall: React.FC<AgentSkillReadToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  const successResult = isAgentSkillReadSuccessResult(result) ? result : null;
  const errorResult = isToolErrorResult(result) ? result : null;
  const hasResult = result !== undefined && result !== null;
  const hasUnrecognizedResult = hasResult && !successResult && !errorResult;

  const frontmatter = successResult?.skill.frontmatter;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="agent_skill_read" />
        <div className="text-text font-monospace flex max-w-96 min-w-0 items-baseline gap-1.5">
          <span className="text-secondary whitespace-nowrap">Read skill:</span>
          <span className="truncate">{args.name}</span>
        </div>
        {successResult && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            <span className="hidden @sm:inline">scope </span>
            {successResult.skill.scope}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex items-baseline gap-1.5">
                <span className="text-secondary font-medium">Skill:</span>
                <span className="text-text font-monospace break-all">{args.name}</span>
              </div>
              {successResult && (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-secondary font-medium">Scope:</span>
                    <span className="text-text font-monospace break-all">
                      {successResult.skill.scope}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-secondary font-medium">Directory:</span>
                    <span className="text-text font-monospace break-all">
                      {successResult.skill.directoryName}
                    </span>
                  </div>
                </>
              )}
            </div>
          </DetailSection>

          {errorResult && (
            <DetailSection>
              <DetailLabel>Error</DetailLabel>
              <ErrorBox>{errorResult.error}</ErrorBox>
            </DetailSection>
          )}

          {hasUnrecognizedResult && (
            <>
              <DetailSection>
                <DetailLabel>Error</DetailLabel>
                <ErrorBox>Unrecognized tool output shape</ErrorBox>
              </DetailSection>
              <DetailSection>
                <DetailLabel>Result</DetailLabel>
                <DetailContent>
                  <JsonHighlight value={result} />
                </DetailContent>
              </DetailSection>
            </>
          )}

          {successResult && frontmatter && (
            <>
              <DetailSection>
                <DetailLabel>Description</DetailLabel>
                <DetailContent className="px-2 py-1.5">{frontmatter.description}</DetailContent>
              </DetailSection>

              {frontmatter.license && (
                <DetailSection>
                  <DetailLabel>License</DetailLabel>
                  <DetailContent className="px-2 py-1.5">{frontmatter.license}</DetailContent>
                </DetailSection>
              )}

              {frontmatter.compatibility && (
                <DetailSection>
                  <DetailLabel>Compatibility</DetailLabel>
                  <DetailContent className="px-2 py-1.5">{frontmatter.compatibility}</DetailContent>
                </DetailSection>
              )}

              {frontmatter.metadata && (
                <DetailSection>
                  <DetailLabel>Metadata</DetailLabel>
                  <DetailContent>
                    <JsonHighlight value={frontmatter.metadata} />
                  </DetailContent>
                </DetailSection>
              )}

              <DetailSection>
                <DetailLabel>Contents</DetailLabel>
                <div className="bg-code-bg max-h-[300px] overflow-y-auto rounded px-3 py-2 text-[12px]">
                  <MarkdownRenderer content={successResult.skill.body} />
                </div>
              </DetailSection>
            </>
          )}

          {status === "executing" && !hasResult && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                Reading skill
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
