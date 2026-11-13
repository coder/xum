import { useState, type ComponentProps } from "react";
import { ChevronDown, Pencil, Plus } from "lucide-react";
import { FilterList } from "@/browser/components/FilterList/FilterList";
import type { FilterListItem } from "@/browser/components/FilterList/filterListItems";
import {
  MODAL_POPOVER_CONTENT_PROPS,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/browser/components/Popover/Popover";
import { KeyHint } from "@/browser/components/KeyHint/KeyHint";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useOptionalWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceRecency } from "@/browser/stores/WorkspaceStore";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import type { ProjectConfig } from "@/common/types/project";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";
import { groupProjectsByRecency, PROJECT_SECTIONS } from "./creationPickerGroups";

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
  const label = formatScopeLabel(props.selected, props.userProjects);
  // Project labels may be display names, so the tooltip shows the path.
  const tooltip = props.selected === SCRATCH_PROJECT_CONFIG_KEY ? label : props.selected;
  // Scratch is always a destination, so there is something to switch to once a project exists.
  if (props.userProjects.size === 0) {
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
      // Projects first, Scratch last under a separator: it is the one row that is not a project.
      items={[
        ...[...props.userProjects.keys()].map((scope) => ({
          value: scope,
          label: formatScopeLabel(scope, props.userProjects),
          // The path tells apart projects that share a name; it is searched too.
          detail: scope,
        })),
        {
          value: SCRATCH_PROJECT_CONFIG_KEY,
          label: SCRATCH_PROJECT_NAME,
          aside: "No project",
          divider: true,
        },
      ]}
    />
  );
}

/**
 * The project list with the projects worked in last on top, under "Recent". With many projects
 * the sidebar's order says nothing about which one is wanted next; the last few used usually
 * are. Mounted only while the switcher is open, so the recency subscription costs nothing closed.
 */
function RecencyGroupedProjectList(props: ComponentProps<typeof FilterList>) {
  const recency = useWorkspaceRecency();
  const workspaces = useOptionalWorkspaceMetadata()?.workspaceMetadata;
  const projects = props.items.filter((item) => item.value !== SCRATCH_PROJECT_CONFIG_KEY);
  const others = props.items.filter((item) => item.value === SCRATCH_PROJECT_CONFIG_KEY);
  const groups = groupProjectsByRecency(
    projects.map((item) => item.value),
    workspaces?.values() ?? [],
    recency
  );
  const byPath = new Map(projects.map((item) => [item.value, item]));
  const rows = (paths: string[], section: string | undefined) =>
    paths.flatMap((path) => {
      const item = byPath.get(path);
      return item ? [{ ...item, section }] : [];
    });
  const grouped = groups.recent.length > 0;
  return (
    <FilterList
      {...props}
      items={[
        ...rows(groups.recent, PROJECT_SECTIONS.recent),
        ...rows(groups.rest, grouped ? PROJECT_SECTIONS.all : undefined),
        ...others,
      ]}
    />
  );
}

/**
 * A project's mark: its first letter in a small tile (a pencil for Scratch), so the heading and
 * the rows read as projects at a glance and a long list can be scanned by letter.
 */
function ProjectTile(props: { scope: string; label: string }) {
  const scratch = props.scope === SCRATCH_PROJECT_CONFIG_KEY;
  return (
    <span
      aria-hidden
      // The letter is drawn from the attribute, not as text: the heading's and the rows' text
      // stays the project's name alone (tests and copy-paste read it).
      // The first code point, not the first UTF-16 unit: a name may start with an astral character.
      data-letter={scratch ? undefined : (Array.from(props.label.trim())[0] ?? "?")}
      className="border-border-medium bg-hover text-foreground flex size-[22px] shrink-0 items-center justify-center rounded-[5px] border font-mono text-[11px] font-medium before:content-[attr(data-letter)]"
    >
      {scratch && <Pencil className="size-3" />}
    </span>
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
  items: FilterListItem[];
}) {
  const [open, setOpen] = useState(false);
  const { openProjectCreateModal } = useProjectContext();
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
              className="text-foreground hover:bg-toggle-bg/70 focus-visible:ring-accent flex h-7 max-w-[280px] shrink-0 items-center gap-2 rounded-md text-lg font-semibold outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ProjectTile scope={props.selected} label={props.label} />
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
        className="flex max-h-(--radix-popover-content-available-height) w-[min(21.25rem,calc(100vw-1rem))] flex-col rounded-[10px] p-0 shadow-xl"
      >
        <RecencyGroupedProjectList
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
          listClassName="max-h-[26rem]"
          twoLine
          renderLeading={(item) => <ProjectTile scope={item.value} label={item.label} />}
          filterHint={<KeyHint>esc</KeyHint>}
          footer={
            // Adding a project used to need a trip to the sidebar; the list that shows what
            // exists is where a missing one is noticed.
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => {
                setOpen(false);
                openProjectCreateModal();
              }}
              className="hover:bg-hover focus-visible:bg-hover text-foreground flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] outline-none disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
            >
              <span
                aria-hidden
                className="border-border-medium bg-hover flex size-[22px] shrink-0 items-center justify-center rounded-[5px] border"
              >
                <Plus className="size-3" />
              </span>
              Add project…
            </button>
          }
        />
      </PopoverContent>
    </Popover>
  );
}
