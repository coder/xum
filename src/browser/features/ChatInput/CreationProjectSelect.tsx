import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { FilterList } from "@/browser/components/FilterList/FilterList";
import {
  MODAL_POPOVER_CONTENT_PROPS,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/browser/components/Popover/Popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import type { ProjectConfig } from "@/common/types/project";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";

interface CreationProjectSelectProps {
  /** Current creation scope: SCRATCH_PROJECT_CONFIG_KEY or a project path. */
  selected: string;
  userProjects: Map<string, ProjectConfig>;
  onChange: (scope: string) => void;
  /** Frozen while a Send, a file read or a recording is in flight. */
  disabled?: boolean;
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
    <ProjectSwitcher
      label={label}
      tooltip={tooltip}
      selected={props.selected}
      disabled={props.disabled}
      onChange={props.onChange}
      items={scopes.map((scope) => ({
        value: scope,
        label: formatScopeLabel(scope, props.userProjects),
        // The path tells apart projects that share a name; it is searched too.
        detail: scope === SCRATCH_PROJECT_CONFIG_KEY ? "No project" : scope,
      }))}
    />
  );
}

/**
 * The switcher itself: the heading opens a filterable list. A plain select had no filter, and its
 * rows showed only names, so two checkouts of one repository looked the same.
 */
function ProjectSwitcher(props: {
  label: string;
  tooltip: string;
  selected: string;
  disabled: boolean | undefined;
  onChange: (scope: string) => void;
  items: Array<{ value: string; label: string; detail: string }>;
}) {
  const [open, setOpen] = useState(false);
  // A lock that lands while the list is open (a send, a file read, a recording) closes it: the
  // open rows would otherwise still switch projects under the draft the lock protects. The state
  // is cleared, not masked, so the list does not reopen by itself when the lock lifts.
  if (props.disabled && open) setOpen(false);
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Select project"
              // The popup is the popover (a dialog) that holds the filter and its list.
              aria-haspopup="dialog"
              data-testid="project-selector"
              disabled={props.disabled}
              className="text-foreground hover:bg-toggle-bg/70 focus-visible:ring-accent flex h-7 max-w-[280px] shrink-0 items-center gap-1 rounded-md text-lg font-semibold outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0 truncate">{props.label}</span>
              <ChevronDown aria-hidden className="size-4 shrink-0 opacity-50" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent align="start">{props.tooltip}</TooltipContent>
      </Tooltip>
      {/* Fits the space Radix has on the side it opens: on a short phone (keyboard up) the list
          opens above the heading and must end below the top safe-area band, not under it. */}
      <PopoverContent
        {...MODAL_POPOVER_CONTENT_PROPS}
        align="start"
        aria-label="Select project"
        className="flex max-h-(--radix-popover-content-available-height) w-[min(22rem,calc(100vw-1rem))] flex-col p-0"
      >
        <FilterList
          items={props.items}
          selected={props.selected}
          onSelect={(scope) => {
            setOpen(false);
            // Re-picking the current project changes nothing, as with the select this replaced.
            if (scope !== props.selected) props.onChange(scope);
          }}
          label="Select project"
          placeholder="Find a project…"
          noun="projects"
          disabled={props.disabled}
          listClassName="max-h-72"
        />
      </PopoverContent>
    </Popover>
  );
}
