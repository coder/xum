import React from "react";
import { AlertTriangle, CircleDot } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { cn } from "@/common/lib/utils";
import assert from "@/common/utils/assert";
import type { GitStatus } from "@/common/types/workspace";
import type { MultiProjectGitSummary } from "@/browser/stores/GitStatusStore";
import { formatRepoCount } from "./gitStatusFormatters";

interface MultiProjectDivergenceDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  summary: MultiProjectGitSummary | null;
  isRefreshing: boolean;
}

function formatLineDelta(additions: number, deletions: number): React.ReactNode {
  if (additions === 0 && deletions === 0) {
    return <span className="counter-nums text-muted">0</span>;
  }

  return (
    <span className="counter-nums inline-flex items-center gap-2 whitespace-nowrap">
      <span className={cn(additions > 0 ? "text-success-light" : "text-muted")}>+{additions}</span>
      <span className={cn(deletions > 0 ? "text-warning-light" : "text-muted")}>-{deletions}</span>
    </span>
  );
}

function getHeaderSummary(summary: MultiProjectGitSummary | null): React.ReactNode {
  if (summary === null) {
    return null;
  }

  const fragments: Array<{
    key: string;
    text: string;
    className?: string;
    icon?: React.ReactNode;
  }> = [{ key: "total", text: formatRepoCount(summary.totalProjectCount) }];

  if (summary.divergedProjectCount > 0) {
    fragments.push({
      key: "diverged",
      text: `${summary.divergedProjectCount} diverged`,
      className: "text-accent-text",
    });
  }
  if (summary.dirtyProjectCount > 0) {
    fragments.push({
      key: "dirty",
      text: `${summary.dirtyProjectCount} dirty`,
      className: "text-git-dirty",
    });
  }
  if (summary.unknownProjectCount > 0) {
    fragments.push({
      key: "unknown",
      text: `${summary.unknownProjectCount} unknown`,
      className: "text-warning",
      icon: <AlertTriangle aria-hidden="true" className="h-3 w-3" />,
    });
  }

  return (
    <div className="text-muted counter-nums flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]">
      {fragments.map((fragment, index) => (
        <React.Fragment key={fragment.key}>
          {index > 0 && <span className="text-muted">·</span>}
          <span className={cn("inline-flex items-center gap-1", fragment.className)}>
            {fragment.icon}
            <span>{fragment.text}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function renderDirtyCell(status: GitStatus): React.ReactNode {
  if (!status.dirty) {
    return <span className="text-muted">—</span>;
  }

  return (
    <span className="text-git-dirty inline-flex items-center gap-1">
      <CircleDot aria-hidden="true" className="h-3 w-3" />
      <span>Dirty</span>
    </span>
  );
}

export const MultiProjectDivergenceDialog: React.FC<MultiProjectDivergenceDialogProps> = ({
  isOpen,
  onOpenChange,
  summary,
  isRefreshing,
}) => {
  if (summary !== null) {
    assert(
      Array.isArray(summary.projects),
      "Multi-project divergence dialog requires summary.projects"
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        maxWidth="860px"
        maxHeight="80vh"
        className="bg-modal-bg text-foreground border-separator-light z-[10000] w-[min(92vw,860px)] min-w-0 overflow-auto px-3 py-2 font-mono text-[11px] shadow-lg"
      >
        <DialogHeader className="mb-2 gap-1">
          <DialogTitle className="text-foreground text-sm">Multi-project git status</DialogTitle>
          {getHeaderSummary(summary)}
          {isRefreshing && (
            <div className="text-muted animate-pulse font-mono text-[11px]">
              Refreshing git status…
            </div>
          )}
        </DialogHeader>

        {summary === null ? (
          <div className="text-muted-light py-2">Loading git status for workspace repos…</div>
        ) : summary.totalProjectCount === 0 ? (
          <div className="text-muted-light py-2">No repos are tracked in this workspace.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left font-mono text-[11px]">
              <thead>
                <tr className="text-muted border-separator-light border-b">
                  <th scope="col" className="px-2 py-1 font-medium">
                    Project
                  </th>
                  <th scope="col" className="px-2 py-1 font-medium">
                    Branch
                  </th>
                  <th scope="col" className="px-2 py-1 font-medium">
                    Ahead
                  </th>
                  <th scope="col" className="px-2 py-1 font-medium">
                    Behind
                  </th>
                  <th scope="col" className="px-2 py-1 font-medium">
                    Dirty
                  </th>
                  <th scope="col" className="px-2 py-1 font-medium">
                    Outgoing
                  </th>
                  <th scope="col" className="px-2 py-1 font-medium">
                    Incoming
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.projects.map((project) => {
                  const status = project.gitStatus;
                  if (status === null) {
                    return (
                      <tr
                        key={project.projectPath}
                        className="border-separator-light border-b last:border-b-0"
                      >
                        <th scope="row" className="text-foreground px-2 py-1.5 font-medium">
                          {project.projectName}
                        </th>
                        <td className="px-2 py-1.5" colSpan={6}>
                          <span className="text-warning inline-flex items-center gap-1">
                            <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
                            <span>{project.error ?? "Git status unavailable"}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr
                      key={project.projectPath}
                      className="border-separator-light border-b last:border-b-0"
                    >
                      <th scope="row" className="text-foreground px-2 py-1.5 font-medium">
                        {project.projectName}
                      </th>
                      <td className="text-foreground px-2 py-1.5">{status.branch.trim() || "—"}</td>
                      <td className="counter-nums text-foreground px-2 py-1.5">{status.ahead}</td>
                      <td className="counter-nums text-foreground px-2 py-1.5">{status.behind}</td>
                      <td className="px-2 py-1.5">{renderDirtyCell(status)}</td>
                      <td className="px-2 py-1.5">
                        {formatLineDelta(status.outgoingAdditions, status.outgoingDeletions)}
                      </td>
                      <td className="px-2 py-1.5">
                        {formatLineDelta(status.incomingAdditions, status.incomingDeletions)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
