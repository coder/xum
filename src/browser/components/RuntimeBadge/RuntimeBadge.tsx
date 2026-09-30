import { Copy, Check } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  isSSHRuntime,
  isWorktreeRuntime,
  isLocalProjectRuntime,
  isDockerRuntime,
  isDevcontainerRuntime,
} from "@/common/types/runtime";
import { extractSshHostname } from "@/browser/utils/ui/runtimeBadge";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { RUNTIME_BADGE_UI } from "@/browser/utils/runtimeUi";

interface RuntimeBadgeProps {
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
  /** Workspace path to show in tooltip */
  workspacePath?: string;
  /** Workspace name to show in tooltip */
  workspaceName?: string;
  /** Tooltip position: "top" (default) or "bottom" */
  tooltipSide?: "top" | "bottom";
}

/**
 * Badge to display runtime type information.
 * Shows icon-only badge with tooltip describing the runtime type.
 * - SSH: server icon with hostname (blue theme)
 * - Worktree: git branch icon (purple theme)
 * - Local: folder icon (gray theme)
 *
 * When isWorking=true, badges brighten and pulse within their color scheme.
 */
function TooltipRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="text-muted shrink-0 text-xs">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs" title={value}>
        {value}
      </span>
      {copyable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void copyToClipboard(value);
          }}
          className="text-muted hover:text-foreground shrink-0"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}

type RuntimeType = keyof typeof RUNTIME_BADGE_UI;

function getRuntimeInfo(
  runtimeConfig?: RuntimeConfig
): { type: RuntimeType; label: string } | null {
  if (isSSHRuntime(runtimeConfig)) {
    // Coder-backed SSH runtime gets special treatment
    if (runtimeConfig.coder) {
      const coderWorkspaceName = runtimeConfig.coder.workspaceName;
      return {
        type: "coder",
        label: `Coder Workspace: ${coderWorkspaceName ?? runtimeConfig.host}`,
      };
    }
    const hostname = extractSshHostname(runtimeConfig);
    return { type: "ssh", label: `SSH: ${hostname ?? runtimeConfig.host}` };
  }
  if (isWorktreeRuntime(runtimeConfig)) {
    return { type: "worktree", label: "Worktree: isolated git worktree" };
  }
  if (isLocalProjectRuntime(runtimeConfig)) {
    return { type: "local", label: "Local: project directory" };
  }
  if (isDockerRuntime(runtimeConfig)) {
    return { type: "docker", label: `Docker: ${runtimeConfig.image}` };
  }
  if (isDevcontainerRuntime(runtimeConfig)) {
    return {
      type: "devcontainer",
      label: runtimeConfig.configPath
        ? `Dev container: ${runtimeConfig.configPath}`
        : "Dev container",
    };
  }
  return null;
}

export function RuntimeBadge({
  runtimeConfig,
  className,
  isWorking = false,
  workspacePath,
  workspaceName,
  tooltipSide = "top",
}: RuntimeBadgeProps) {
  const info = getRuntimeInfo(runtimeConfig);
  if (!info) return null;

  const badgeUi = RUNTIME_BADGE_UI[info.type];
  const styles = isWorking ? badgeUi.badge.workingClass : badgeUi.badge.idleClass;
  const Icon = badgeUi.Icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
            styles,
            className
          )}
        >
          <Icon />
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} align="start" className="max-w-[min(90vw,500px)]">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium">{info.label}</div>
          {workspaceName && <TooltipRow label="Name" value={workspaceName} />}
          {workspacePath && <TooltipRow label="Path" value={workspacePath} copyable />}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
