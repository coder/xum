import {
  Select as RadixSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import type { ProjectConfig } from "@/common/types/project";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";

export interface CreationProjectOption {
  value: string;
  label: string;
}

/**
 * Every user project as picker options, labeled with the same hierarchy label
 * the trigger uses so sub-projects read as "parent/child" in both places.
 * Shared so callers that prepend extra entries (e.g. Scratch) stay consistent.
 */
export function projectSelectOptions(
  userProjects: Map<string, ProjectConfig>
): CreationProjectOption[] {
  return Array.from(userProjects.keys()).map((path) => ({
    value: path,
    label: formatProjectHierarchyLabel(path, userProjects),
  }));
}

interface CreationProjectSelectProps {
  selected: string;
  selectedLabel: string;
  tooltip?: string;
  options: CreationProjectOption[];
  onChange: (value: string) => void;
}

/**
 * Current-scope heading for creation composers: a project switcher when there
 * is more than one choice, otherwise a static heading. Shared by the project
 * creation header (CreationControls) and the scratch creation header.
 */
export function CreationProjectSelect(props: CreationProjectSelectProps) {
  const tooltip = props.tooltip ?? props.selected;
  if (props.options.length <= 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <h2 className="text-foreground shrink-0 text-lg font-semibold">{props.selectedLabel}</h2>
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
            <SelectValue placeholder={props.selectedLabel}>{props.selectedLabel}</SelectValue>
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent align="start">{tooltip}</TooltipContent>
      </Tooltip>
      <SelectContent>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </RadixSelect>
  );
}
