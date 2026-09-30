import React from "react";
import type { TaskApplyGitPatchToolArgs, TaskApplyGitPatchToolResult } from "@/common/types/tools";
import {
  DetailContent,
  DetailLabel,
  DetailSection,
  ErrorBox,
  ExpandIcon,
  HeaderButton,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import { getStatusDisplay, useToolExpansion, type ToolStatus } from "./Shared/toolUtils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { cn } from "@/common/lib/utils";

type TaskApplyGitPatchSuccessResult = Extract<TaskApplyGitPatchToolResult, { success: true }>;
type TaskApplyGitPatchFailureResult = Extract<TaskApplyGitPatchToolResult, { success: false }>;

interface TaskApplyGitPatchToolCallProps {
  args: TaskApplyGitPatchToolArgs;
  result?: unknown;
  status?: ToolStatus;
}

function formatCommitCount(count: number): string {
  return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function formatShortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 7) : sha;
}

interface AppliedCommit {
  subject: string;
  sha?: string;
}

export interface ParsedProjectResult {
  projectPath: string;
  projectName: string;
  status: "applied" | "failed" | "skipped";
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  error?: string;
  failedPatchSubject?: string;
  conflictPaths?: string[];
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapJsonContainer(value: unknown): unknown {
  let current = value;

  for (let i = 0; i < 2; i++) {
    if (
      current !== null &&
      typeof current === "object" &&
      "type" in current &&
      (current as { type?: unknown }).type === "json" &&
      "value" in current
    ) {
      current = (current as { value: unknown }).value;
      continue;
    }
    break;
  }

  return current;
}

const MAX_CONFLICT_PATHS_SHOWN = 6;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const items: string[] = [];
  for (const item of value) {
    const str = readNonEmptyString(item);
    if (str) items.push(str);
  }

  return items.length > 0 ? items : undefined;
}

function readAppliedCommits(value: unknown): AppliedCommit[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const commits: AppliedCommit[] = [];
  for (const commit of value) {
    if (!isRecord(commit)) continue;

    const subject = (commit as { subject?: unknown }).subject;
    if (typeof subject !== "string" || subject.length === 0) continue;

    const sha = (commit as { sha?: unknown }).sha;
    commits.push({
      subject,
      sha: typeof sha === "string" && sha.length > 0 ? sha : undefined,
    });
  }

  return commits;
}

function readResultAppliedCommits(result: unknown): AppliedCommit[] | undefined {
  if (!isRecord(result)) return undefined;
  return readAppliedCommits((result as { appliedCommits?: unknown }).appliedCommits);
}

function readLegacyAppliedCommitCount(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined;

  const value = (result as { appliedCommitCount?: unknown }).appliedCommitCount;
  return typeof value === "number" ? value : undefined;
}

function readProjectResults(result: unknown): ParsedProjectResult[] | undefined {
  if (!isRecord(result)) return undefined;

  const value = (result as { projectResults?: unknown }).projectResults;
  if (!Array.isArray(value)) return undefined;

  const projectResults: ParsedProjectResult[] = [];
  for (const projectResult of value) {
    if (!isRecord(projectResult)) continue;

    const rawProjectPath = (projectResult as { projectPath?: unknown }).projectPath;
    const projectPath = typeof rawProjectPath === "string" ? rawProjectPath : undefined;
    const projectName = readNonEmptyString(
      (projectResult as { projectName?: unknown }).projectName
    );
    const status = (projectResult as { status?: unknown }).status;
    if (projectPath === undefined || !projectName) continue;
    if (status !== "applied" && status !== "failed" && status !== "skipped") continue;

    projectResults.push({
      projectPath,
      projectName,
      status,
      appliedCommits: readAppliedCommits(
        (projectResult as { appliedCommits?: unknown }).appliedCommits
      ),
      headCommitSha: readNonEmptyString(
        (projectResult as { headCommitSha?: unknown }).headCommitSha
      ),
      error: readNonEmptyString((projectResult as { error?: unknown }).error),
      failedPatchSubject: readNonEmptyString(
        (projectResult as { failedPatchSubject?: unknown }).failedPatchSubject
      ),
      conflictPaths: readStringArray((projectResult as { conflictPaths?: unknown }).conflictPaths),
      note: readNonEmptyString((projectResult as { note?: unknown }).note),
    });
  }

  return projectResults.length > 0 ? projectResults : undefined;
}

const CopyableCode: React.FC<{
  value: string;
  displayValue?: string;
  tooltipLabel: string;
  className?: string;
}> = ({ value, displayValue, tooltipLabel, className }) => {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "min-w-0 truncate font-mono text-[11px] text-link opacity-90 hover:opacity-100 hover:underline underline-offset-2",
            className
          )}
          onClick={() => void copyToClipboard(value)}
        >
          {displayValue ?? value}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : tooltipLabel}</TooltipContent>
    </Tooltip>
  );
};

const ErrorOutput: React.FC<{ error: string }> = ({ error }) => (
  <ErrorBox>
    <pre className="m-0 max-h-[200px] overflow-y-auto break-words whitespace-pre-wrap">{error}</pre>
  </ErrorBox>
);

export const TaskApplyGitPatchProjectResultCard: React.FC<{
  projectResult: ParsedProjectResult;
  isDryRun: boolean;
}> = ({ projectResult, isDryRun }) => {
  const shownConflictPaths = projectResult.conflictPaths?.slice(0, MAX_CONFLICT_PATHS_SHOWN);
  const remainingConflictPaths =
    projectResult.conflictPaths && shownConflictPaths
      ? Math.max(0, projectResult.conflictPaths.length - shownConflictPaths.length)
      : 0;
  const appliedCommitCount = projectResult.appliedCommits?.length ?? 0;

  return (
    <div className="bg-code-bg flex flex-col gap-2 rounded px-2 py-2 text-[11px] leading-[1.4]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text font-medium">{projectResult.projectName}</span>
        {projectResult.projectPath.length > 0 && (
          <span className="text-secondary font-mono text-[10px]">{projectResult.projectPath}</span>
        )}
        <span className="text-muted rounded border px-1.5 py-0.5 text-[10px] capitalize">
          {projectResult.status}
        </span>
        {appliedCommitCount > 0 && (
          <span className="text-secondary text-[10px]">
            {isDryRun ? "Would apply" : "Applied"} {formatCommitCount(appliedCommitCount)}
          </span>
        )}
      </div>

      {projectResult.headCommitSha && (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-secondary shrink-0 font-medium">HEAD:</span>
          <CopyableCode
            value={projectResult.headCommitSha}
            displayValue={formatShortSha(projectResult.headCommitSha)}
            tooltipLabel="Copy HEAD SHA"
          />
        </div>
      )}

      {projectResult.appliedCommits && projectResult.appliedCommits.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-secondary font-medium">Commits</span>
          <div className="flex flex-col gap-1">
            {projectResult.appliedCommits.map((commit, index) => (
              <div
                key={`${commit.sha ?? index}-${commit.subject}`}
                className="flex min-w-0 items-start gap-2"
              >
                {commit.sha ? (
                  <CopyableCode
                    value={commit.sha}
                    displayValue={formatShortSha(commit.sha)}
                    tooltipLabel="Copy commit SHA"
                    className="shrink-0"
                  />
                ) : (
                  <span className="text-secondary shrink-0 font-mono text-[11px]">
                    {index + 1}.
                  </span>
                )}
                <span className="text-text min-w-0 break-words">{commit.subject}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(projectResult.failedPatchSubject ??
        (shownConflictPaths && shownConflictPaths.length > 0) ??
        projectResult.error) &&
        projectResult.status !== "applied" && (
          <div className="flex flex-col gap-1">
            {projectResult.failedPatchSubject && (
              <div className="flex min-w-0 items-start gap-1.5">
                <span className="text-secondary shrink-0 font-medium">Failed patch:</span>
                <span className="text-text min-w-0 break-words">
                  {projectResult.failedPatchSubject}
                </span>
              </div>
            )}
            {shownConflictPaths && shownConflictPaths.length > 0 && (
              <div className="flex min-w-0 items-start gap-1.5">
                <span className="text-secondary shrink-0 font-medium">Conflicts:</span>
                <span className="text-text min-w-0 font-mono break-words">
                  {shownConflictPaths.join(", ")}
                  {remainingConflictPaths > 0 && (
                    <span className="text-secondary"> +{remainingConflictPaths} more</span>
                  )}
                </span>
              </div>
            )}
            {projectResult.error && <ErrorOutput error={projectResult.error} />}
          </div>
        )}

      {projectResult.note && (
        <div className="text-secondary whitespace-pre-wrap">{projectResult.note}</div>
      )}
    </div>
  );
};

export const TaskApplyGitPatchToolCall: React.FC<TaskApplyGitPatchToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const unwrappedResult = unwrapJsonContainer(result);

  const successResult =
    isRecord(unwrappedResult) && unwrappedResult.success === true
      ? (unwrappedResult as TaskApplyGitPatchSuccessResult)
      : null;
  const errorResult =
    isRecord(unwrappedResult) && unwrappedResult.success === false
      ? (unwrappedResult as TaskApplyGitPatchFailureResult)
      : null;

  const taskIdFromResult =
    isRecord(unwrappedResult) &&
    typeof (unwrappedResult as { taskId?: unknown }).taskId === "string"
      ? (unwrappedResult as { taskId: string }).taskId
      : undefined;
  const taskId = taskIdFromResult ?? args.task_id;

  const dryRunFromResult =
    isRecord(unwrappedResult) && typeof unwrappedResult.dryRun === "boolean"
      ? unwrappedResult.dryRun
      : undefined;

  const isDryRun = dryRunFromResult === true || args.dry_run === true;
  const projectResults = readProjectResults(unwrappedResult);
  const fallbackAppliedCommits = successResult
    ? readResultAppliedCommits(successResult)
    : undefined;
  const fallbackLegacyAppliedCommitCount = successResult
    ? readLegacyAppliedCommitCount(successResult)
    : undefined;
  const appliedCommitCount = projectResults
    ? projectResults.reduce(
        (sum, projectResult) => sum + (projectResult.appliedCommits?.length ?? 0),
        0
      )
    : fallbackAppliedCommits
      ? fallbackAppliedCommits.length
      : (fallbackLegacyAppliedCommitCount ?? 0);
  const appliedProjectCount = projectResults?.filter(
    (projectResult) => projectResult.status === "applied"
  ).length;

  const errorPreview =
    typeof errorResult?.error === "string" ? errorResult.error.split("\n")[0]?.trim() : undefined;

  // A failed patch must surface its error, so force the row open when there's an error
  // result instead of letting a stored `tools: false` preference hide it (mirrors how
  // TaskToolCall forces open on error/failed states).
  const { expanded, toggleExpanded } = useToolExpansion(false, {
    forceExpanded: Boolean(errorResult),
  });
  const { copied: copiedError, copyToClipboard: copyErrorToClipboard } = useCopyToClipboard();

  const effectiveThreeWay = args.three_way !== false;
  const errorNote = errorResult && "note" in errorResult ? errorResult.note : undefined;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="task_apply_git_patch" />
        <ToolName>Apply patch</ToolName>
        <span className="text-muted ml-1 max-w-40 truncate text-[10px]">{taskId}</span>
        {isDryRun && <span className="text-backgrounded text-[10px] font-medium">dry-run</span>}
        {successResult && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            {projectResults && projectResults.length > 1 && appliedProjectCount != null
              ? `${appliedProjectCount} projects, ${formatCommitCount(appliedCommitCount)}`
              : formatCommitCount(appliedCommitCount)}
          </span>
        )}
        {errorPreview && (
          <span className="text-danger ml-2 max-w-64 truncate text-[10px]">{errorPreview}</span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Patch source</DetailLabel>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-secondary shrink-0 font-medium">Task ID:</span>
                <CopyableCode
                  value={taskId}
                  tooltipLabel="Copy task ID"
                  className="max-w-[260px]"
                />
              </div>
            </div>
          </DetailSection>

          <DetailSection>
            <DetailLabel>Options</DetailLabel>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex items-center gap-1.5">
                <span className="text-secondary font-medium">project_path:</span>
                <span className="text-text font-mono">
                  {args.project_path ?? "all ready projects"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-secondary font-medium">dry_run:</span>
                <span className="text-text font-mono">
                  {args.dry_run === true ? "true" : "false"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-secondary font-medium">three_way:</span>
                <span className="text-text font-mono">{effectiveThreeWay ? "true" : "false"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-secondary font-medium">force:</span>
                <span className="text-text font-mono">
                  {args.force === true ? "true" : "false"}
                </span>
              </div>
            </div>
          </DetailSection>

          {status === "executing" && !result && (
            <DetailSection>
              <DetailContent>
                Applying patch
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}

          {successResult && (
            <>
              <DetailSection>
                <DetailLabel>Result</DetailLabel>
                <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
                  <div className="flex items-center gap-1.5">
                    <span className="text-secondary font-medium">
                      {isDryRun ? "Would apply" : "Applied"}:
                    </span>
                    <span className="text-text font-mono">
                      {projectResults && projectResults.length > 1 && appliedProjectCount != null
                        ? `${appliedProjectCount} projects, ${formatCommitCount(appliedCommitCount)}`
                        : formatCommitCount(appliedCommitCount)}
                    </span>
                  </div>
                </div>
              </DetailSection>

              {projectResults && projectResults.length > 0 ? (
                <DetailSection>
                  <DetailLabel>Projects</DetailLabel>
                  <div className="flex flex-col gap-2">
                    {projectResults.map((projectResult) => (
                      <TaskApplyGitPatchProjectResultCard
                        key={`${projectResult.projectName}-${projectResult.projectPath}-${projectResult.status}`}
                        projectResult={projectResult}
                        isDryRun={isDryRun}
                      />
                    ))}
                  </div>
                </DetailSection>
              ) : (
                fallbackAppliedCommits &&
                fallbackAppliedCommits.length > 0 && (
                  <DetailSection>
                    <DetailLabel>Commits</DetailLabel>
                    <div className="bg-code-bg flex flex-col gap-1 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
                      {fallbackAppliedCommits.map((commit, index) => (
                        <div
                          key={`${commit.sha ?? index}-${commit.subject}`}
                          className="flex min-w-0 items-start gap-2"
                        >
                          {commit.sha ? (
                            <CopyableCode
                              value={commit.sha}
                              displayValue={formatShortSha(commit.sha)}
                              tooltipLabel="Copy commit SHA"
                              className="shrink-0"
                            />
                          ) : (
                            <span className="text-secondary shrink-0 font-mono text-[11px]">
                              {index + 1}.
                            </span>
                          )}
                          <span className="text-text min-w-0 break-words">{commit.subject}</span>
                        </div>
                      ))}
                    </div>
                  </DetailSection>
                )
              )}
              {successResult.note && (
                <DetailSection>
                  <DetailLabel>Note</DetailLabel>
                  <DetailContent className="px-2 py-1.5">{successResult.note}</DetailContent>
                </DetailSection>
              )}
            </>
          )}

          {errorResult && (
            <>
              {projectResults && projectResults.length > 0 && (
                <DetailSection>
                  <DetailLabel>Projects</DetailLabel>
                  <div className="flex flex-col gap-2">
                    {projectResults.map((projectResult) => (
                      <TaskApplyGitPatchProjectResultCard
                        key={`${projectResult.projectName}-${projectResult.projectPath}-${projectResult.status}`}
                        projectResult={projectResult}
                        isDryRun={isDryRun}
                      />
                    ))}
                  </div>
                </DetailSection>
              )}

              <DetailSection>
                <DetailLabel className="flex items-center justify-between gap-2">
                  <span>Error</span>
                  <HeaderButton
                    type="button"
                    onClick={() => void copyErrorToClipboard(errorResult.error)}
                    active={copiedError}
                  >
                    {copiedError ? "Copied" : "Copy"}
                  </HeaderButton>
                </DetailLabel>
                <ErrorOutput error={errorResult.error} />
              </DetailSection>

              {errorNote && (
                <DetailSection>
                  <DetailLabel>Note</DetailLabel>
                  <DetailContent className="px-2 py-1.5">{errorNote}</DetailContent>
                </DetailSection>
              )}
            </>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
