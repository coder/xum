import {
  Select as RadixSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import type { ProjectConfig } from "@/common/types/project";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";

interface CreationProjectSelectProps {
  /** Current creation scope: SCRATCH_PROJECT_CONFIG_KEY or a project path. */
  selected: string;
  userProjects: Map<string, ProjectConfig>;
  onChange: (scope: string) => void;
}

function formatScopeLabel(scope: string, userProjects: Map<string, ProjectConfig>): string {
  return scope === SCRATCH_PROJECT_CONFIG_KEY
    ? SCRATCH_PROJECT_NAME
    : formatProjectHierarchyLabel(scope, userProjects);
}

/**
 * Current-scope heading for creation composers. Every creation page offers the
 * same destinations, Scratch and every project, so a draft can move between
 * any two scopes. Shared by the project creation header (CreationControls)
 * and the scratch creation header; a static heading when there is nothing to
 * switch to.
 */
export function CreationProjectSelect(props: CreationProjectSelectProps) {
  const scopes = [SCRATCH_PROJECT_CONFIG_KEY, ...props.userProjects.keys()];
  const label = formatScopeLabel(props.selected, props.userProjects);
  // Project labels may be display names, so the tooltip shows the path.
  const tooltip = props.selected === SCRATCH_PROJECT_CONFIG_KEY ? label : props.selected;
  if (scopes.length <= 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <h2 className="text-foreground shrink-0 text-lg font-semibold">{label}</h2>
        </TooltipTrigger>
        <TooltipContent align="start">{tooltip}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <RadixSelect value={props.selected} onValueChange={props.onChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SelectTrigger
            aria-label="Select project"
            data-testid="project-selector"
            className="text-foreground hover:bg-toggle-bg/70 h-7 w-auto max-w-[280px] shrink-0 border-transparent bg-transparent px-0 text-lg font-semibold shadow-none"
          >
            {/* Explicit child instead of Radix's <SelectValue/> mirror of the
                matched <SelectItem/> text, so unmatched values still render
                the caller's label rather than falling back to nothing. */}
            <SelectValue placeholder={label}>{label}</SelectValue>
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent align="start">{tooltip}</TooltipContent>
      </Tooltip>
      <SelectContent>
        {scopes.map((scope) => (
          <SelectItem key={scope} value={scope}>
            {formatScopeLabel(scope, props.userProjects)}
          </SelectItem>
        ))}
      </SelectContent>
    </RadixSelect>
  );
}
