import React from "react";
import { AlertTriangle, Check, EyeOff, XCircle } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { SkillIcon } from "@/browser/components/icons/SkillIcon/SkillIcon";
import { HoverClickPopover } from "@/browser/components/HoverClickPopover/HoverClickPopover";
import type {
  LoadedSkill,
  SkillLoadError,
} from "@/browser/utils/messages/StreamingMessageAggregator";
import type {
  AgentSkillDescriptor,
  AgentSkillIssue,
  AgentSkillScope,
} from "@/common/types/agentSkill";

interface SkillIndicatorProps {
  /** Skills that have been loaded in the current session */
  loadedSkills: LoadedSkill[];
  /** All available skills discovered for this project */
  availableSkills: AgentSkillDescriptor[];
  /** Skills that were discovered but couldn't be loaded (SKILL.md parse errors, etc.) */
  invalidSkills?: AgentSkillIssue[];
  /** Runtime skill load failures (agent_skill_read returned an error) */
  skillLoadErrors?: SkillLoadError[];
  className?: string;
}

/** Scope display order and labels */
const SCOPE_CONFIG: Array<{ scope: AgentSkillScope; label: string }> = [
  { scope: "project", label: "Project" },
  { scope: "global", label: "Global" },
  { scope: "built-in", label: "Built-in" },
];

interface SkillsPopoverContentProps {
  loadedSkills: LoadedSkill[];
  availableSkills: AgentSkillDescriptor[];
  invalidSkills: AgentSkillIssue[];
  skillLoadErrors: SkillLoadError[];
}

const SkillsPopoverContent: React.FC<SkillsPopoverContentProps> = (props) => {
  const loadedSkillNames = new Set(props.loadedSkills.map((skill) => skill.name));

  const skillsByScope = new Map<AgentSkillScope, AgentSkillDescriptor[]>();
  for (const skill of props.availableSkills) {
    const existing = skillsByScope.get(skill.scope) ?? [];
    existing.push(skill);
    skillsByScope.set(skill.scope, existing);
  }

  const invalidSkillsByScope = new Map<AgentSkillScope, AgentSkillIssue[]>();
  for (const issue of props.invalidSkills) {
    const existing = invalidSkillsByScope.get(issue.scope) ?? [];
    existing.push(issue);
    invalidSkillsByScope.set(issue.scope, existing);
  }

  return (
    // Scroll container lives inside PopoverContent (whose overflow-visible
    // powers the hover-bridge pseudo-element and must not be overridden).
    <div className="flex max-h-[min(400px,60vh)] flex-col gap-2 overflow-y-auto">
      {SCOPE_CONFIG.map(({ scope, label }) => {
        const skills = skillsByScope.get(scope);
        if (!skills || skills.length === 0) return null;

        return (
          <div key={scope} className="flex flex-col gap-1">
            <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
              {label} skills
            </div>
            {skills.map((skill) => {
              const isLoaded = loadedSkillNames.has(skill.name);
              const isUnadvertised = skill.advertise === false;
              return (
                <div key={skill.name} className="flex items-start gap-1.5">
                  <div className="bg-muted-foreground/30 mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                  <div className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "text-xs font-medium",
                        isLoaded ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {skill.name}
                      {isUnadvertised && (
                        <EyeOff
                          className="text-muted-foreground ml-1 inline h-3 w-3"
                          aria-label="Not advertised in system prompt"
                        />
                      )}
                      {isLoaded && <Check className="text-success ml-1 inline h-3 w-3" />}
                    </span>
                    <span className="text-muted-foreground line-clamp-1 text-[11px] leading-snug">
                      {skill.description}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {props.invalidSkills.length > 0 && (
        <div className="border-separator-light border-t pt-2">
          <div className="text-danger-soft flex items-center gap-1 text-[10px] font-medium tracking-wider uppercase">
            <AlertTriangle className="h-3 w-3" />
            Invalid skills
          </div>
          <div className="mt-1.5 flex flex-col gap-2">
            {SCOPE_CONFIG.map(({ scope, label }) => {
              const issues = invalidSkillsByScope.get(scope);
              if (!issues || issues.length === 0) return null;

              return (
                <div key={`invalid-${scope}`} className="flex flex-col gap-1">
                  <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                    {label}
                  </div>
                  {issues.map((issue) => (
                    <div
                      key={`${issue.scope}:${issue.directoryName}:${issue.displayPath}`}
                      className="flex items-start gap-1.5"
                    >
                      <div className="bg-muted-foreground/30 mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-xs font-medium">{issue.directoryName}</span>
                        <span className="text-muted-foreground line-clamp-1 font-mono text-[10px]">
                          {issue.displayPath}
                        </span>
                        <span className="text-muted-foreground line-clamp-2 text-[11px] leading-snug">
                          {issue.message}
                        </span>
                        {issue.hint && (
                          <span className="text-muted-foreground line-clamp-1 text-[11px] leading-snug">
                            Hint: {issue.hint}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {props.skillLoadErrors.length > 0 && (
        <div className="border-separator-light border-t pt-2">
          <div className="text-danger-soft flex items-center gap-1 text-[10px] font-medium tracking-wider uppercase">
            <XCircle className="h-3 w-3" />
            Load errors
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            {props.skillLoadErrors.map((err) => (
              <div key={err.name} className="flex items-start gap-1.5">
                <div className="bg-muted-foreground/30 mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium">{err.name}</span>
                  <span className="text-muted-foreground line-clamp-2 text-[11px] leading-snug">
                    {err.error}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Indicator showing loaded and available skills in a workspace.
 * Displays in the WorkspaceMenuBar to the right of the notification bell.
 * Hover to preview skills organized by scope (Project, Global, Built-in); click to pin the list open.
 */
export const SkillIndicator: React.FC<SkillIndicatorProps> = (props) => {
  const loadedCount = props.loadedSkills.length;
  const totalCount = props.availableSkills.length;
  const invalidCount = props.invalidSkills?.length ?? 0;
  const loadErrorCount = props.skillLoadErrors?.length ?? 0;
  const errorCount = invalidCount + loadErrorCount;
  const badgeCount = errorCount > 0 ? errorCount : loadedCount;

  // Don't render if there's nothing to show.
  if (totalCount === 0 && errorCount === 0) {
    return null;
  }

  const ariaLabelParts: string[] = [];
  if (totalCount > 0) {
    ariaLabelParts.push(
      `${loadedCount} of ${totalCount} skill${totalCount === 1 ? "" : "s"} loaded`
    );
  }
  if (invalidCount > 0) {
    ariaLabelParts.push(`${invalidCount} invalid`);
  }
  if (loadErrorCount > 0) {
    ariaLabelParts.push(`${loadErrorCount} load error${loadErrorCount === 1 ? "" : "s"}`);
  }
  const ariaLabel = ariaLabelParts.join(", ");

  // Hover previews skills; click pins the list open to match the context indicator behavior.
  return (
    <HoverClickPopover
      content={
        <SkillsPopoverContent
          loadedSkills={props.loadedSkills}
          availableSkills={props.availableSkills}
          invalidSkills={props.invalidSkills ?? []}
          skillLoadErrors={props.skillLoadErrors ?? []}
        />
      }
      side="bottom"
      align="end"
      sideOffset={8}
      contentClassName={cn(
        "bg-modal-bg text-foreground z-[9999] rounded px-[10px] py-[6px]",
        "text-[11px] font-normal font-sans text-left",
        "border border-separator-light shadow-[0_2px_8px_rgba(0,0,0,0.4)]",
        "animate-in fade-in-0 zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        "max-w-[280px] w-auto min-w-0"
      )}
    >
      <button
        type="button"
        className={cn(
          "relative flex h-6 w-6 shrink-0 items-center justify-center rounded",
          "text-muted hover:bg-sidebar-hover hover:text-foreground",
          props.className
        )}
        aria-label={ariaLabel}
      >
        <span className="relative flex h-6 w-6 items-center justify-center">
          <SkillIcon className="h-4.5 w-4.5" />
          <span
            className={cn(
              "absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center",
              "rounded-full border px-0.5 text-[9px] font-medium",
              errorCount > 0 ? "border-danger bg-danger text-on-danger" : "border-border bg-dark",
              errorCount === 0 && (loadedCount > 0 ? "text-foreground" : "text-muted")
            )}
          >
            {badgeCount}
          </span>
        </span>
      </button>
    </HoverClickPopover>
  );
};
