import { useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, GitBranch } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import { FilterList } from "@/browser/components/FilterList/FilterList";
import {
  MODAL_POPOVER_CONTENT_PROPS,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/browser/components/Popover/Popover";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import type { IsolationOptionUi } from "@/browser/utils/runtimeUi";
import {
  formatKeybind,
  formatKeybindForAria,
  KEYBINDS,
  matchesKeybind,
  type Keybind,
} from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type {
  IsolationChoice,
  ProjectIsolation,
  WorkspaceIsolation,
} from "@/common/types/isolation";
import type { BranchLoadStatus } from "./branchListLoad";
import type { EnvironmentSummary, RuntimeFieldError } from "./creationEnvironmentSummary";
import { environmentArrowTarget, environmentOpenFocusTarget } from "./environmentPanelKeys";
import { useCreationShortcut } from "./useCreationShortcut";

/** One option on an isolation axis, with its UI and why it cannot be picked (if it cannot). */
export interface IsolationSelectOption<T extends string> {
  value: T;
  ui: IsolationOptionUi;
  disabledReason: string | null;
}

/** The base-branch column's data; null when the selected runtime needs no base branch. */
export interface EnvironmentBranchPicker {
  load: BranchLoadStatus;
  options: string[];
  selected: string;
  /** The repository's default branch, tagged in the list; null when it is not known. */
  defaultBranch: string | null;
  onSelect: (branch: string) => void;
}

interface CreationEnvironmentPanelProps {
  summary: EnvironmentSummary;
  /** The selection as one sentence: the chip's tooltip and the panel's footer. */
  description: string;
  disabled: boolean;
  isolation: IsolationChoice;
  projectOptions: Array<IsolationSelectOption<ProjectIsolation>>;
  workspaceOptions: Array<IsolationSelectOption<WorkspaceIsolation>>;
  onSelectIsolation: (choice: IsolationChoice) => void;
  /** Inputs the selected "Run on" option needs (SSH host, Coder form), shown under its row. */
  projectFields: ReactNode;
  /** Inputs the selected isolation needs (Docker image, dev container config). */
  workspaceFields: ReactNode;
  branch: EnvironmentBranchPicker | null;
  fieldError: RuntimeFieldError | null;
  /** Counts the sends refused for a required field; a new one reopens the panel. */
  fieldErrorAttempt: number;
  /** Shown in the footer before Done: making the selection the project's default. */
  footerAction: ReactNode;
  /**
   * Runs the footer action's shortcut while the panel is open. The panel is modal and keeps its
   * key events from the page's window listeners, so the page's own listener never sees it.
   */
  footerShortcut: { keybind: Keybind; run: () => void } | null;
}

// A quiet mono caption: the column names are labels for the eye, not headings to read.
const COLUMN_TITLE_CLASSES =
  "text-muted-light font-mono text-[10.5px] font-medium tracking-[0.06em] uppercase";
const COLUMN_CLASSES = "flex min-w-0 flex-col p-1.5";
const COLUMN_HEADER_CLASSES = "flex items-center justify-between px-2.5 pt-2 pb-1";

/** One isolation axis as a radio group; the selected row shows the inputs it needs below it. */
function OptionColumn<T extends string>(props: {
  title: string;
  ariaLabel: string;
  value: T;
  options: Array<IsolationSelectOption<T>>;
  onChange: (value: T) => void;
  disabled: boolean;
  fields: ReactNode;
  className?: string;
}) {
  const selected = props.options.find((option) => option.value === props.value);
  return (
    <div data-environment-column className={cn(COLUMN_CLASSES, props.className)}>
      <div className={COLUMN_HEADER_CLASSES}>
        <span className={COLUMN_TITLE_CLASSES}>{props.title}</span>
        {selected && <DocsLink path={selected.ui.docsPath} />}
      </div>
      <div role="radiogroup" aria-label={props.ariaLabel} className="flex flex-col">
        {props.options.map((option) => {
          const Icon = option.ui.Icon;
          const checked = option.value === props.value;
          const unavailable = option.disabledReason !== null;
          const rowDisabled = props.disabled || unavailable;
          return (
            <div key={option.value} className="flex flex-col">
              <button
                type="button"
                role="radio"
                aria-checked={checked}
                // aria-disabled as well: assistive tech and tests read it on a native-disabled row.
                aria-disabled={rowDisabled}
                disabled={rowDisabled}
                // Re-picking the selected row is a no-op, as with the select this replaced: the
                // pick rebuilds the runtime and would drop what the row's fields hold (for
                // example Docker's credential sharing).
                onClick={() => {
                  if (!checked) props.onChange(option.value);
                }}
                className={cn(
                  "focus-visible:ring-accent flex w-full gap-2.5 rounded-md px-2.5 py-[7px] text-left outline-none focus-visible:ring-1 [@media(pointer:coarse)]:min-h-12",
                  // A reason can wrap to several lines; the icon then stays with the name.
                  unavailable ? "items-start" : "items-center",
                  checked ? "bg-hover" : "hover:bg-hover/60",
                  props.disabled && "opacity-50"
                )}
              >
                {/* Decorative: the runtime icons carry their own labels ("Local Runtime" on None's
                    icon), which would otherwise become part of the row's accessible name. */}
                <span
                  aria-hidden
                  className={cn(
                    "flex shrink-0",
                    unavailable ? "text-muted-light mt-[3px]" : option.ui.iconClass
                  )}
                >
                  <Icon size={14} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span
                    className={cn(
                      "text-[13px] font-medium",
                      unavailable ? "text-muted" : "text-foreground"
                    )}
                  >
                    {option.ui.label}
                  </span>
                  {/* One line under the name: what the option is, or why it cannot be picked.
                      The reason replaces the description (both made the row three paragraphs)
                      and is shown whole, wrapped: the old select cut it off after two lines. */}
                  {unavailable ? (
                    <span className="text-warning-text/85 text-xs leading-snug break-words">
                      {option.disabledReason}
                    </span>
                  ) : (
                    <span className="text-muted text-xs leading-snug">{option.ui.description}</span>
                  )}
                </span>
                {checked && <Check aria-hidden className="text-foreground size-3.5 shrink-0" />}
              </button>
              {checked && props.fields != null && (
                <div className="flex flex-col gap-2 pt-1 pr-1.5 pb-2 pl-[2.125rem]">
                  {props.fields}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BranchColumn(props: {
  branch: EnvironmentBranchPicker;
  disabled: boolean;
  className?: string;
}) {
  const { branch } = props;
  return (
    <div data-environment-column className={cn(COLUMN_CLASSES, props.className)}>
      <div className={COLUMN_HEADER_CLASSES}>
        <span className={COLUMN_TITLE_CLASSES}>Base branch</span>
      </div>
      {branch.load === "loading" ? (
        <div className="flex flex-col gap-3 px-2.5 pt-2 pb-2.5" aria-busy role="status">
          <span className="sr-only">Loading branches</span>
          <Skeleton className="h-3 w-3/5 rounded" />
          <Skeleton className="h-3 w-4/5 rounded" />
          <Skeleton className="h-3 w-2/5 rounded" />
        </div>
      ) : branch.load === "failed" ? (
        <span className="text-error px-2.5 py-2 text-xs" role="status">
          Could not load branches
        </span>
      ) : (
        <FilterList
          items={branch.options.map((name) => ({
            value: name,
            label: name,
            badge: name === branch.defaultBranch ? "default" : undefined,
          }))}
          selected={branch.selected}
          onSelect={branch.onSelect}
          label="Select source branch"
          placeholder="Filter branches…"
          noun="branches"
          mono
          boxedFilter
          disabled={props.disabled}
          listClassName="max-h-56 p-0"
        />
      )}
    </div>
  );
}

const SEPARATOR = (
  <span aria-hidden className="text-muted-light shrink-0">
    ·
  </span>
);

function ChipBranch(props: { branch: EnvironmentSummary["branch"] }) {
  const { branch } = props;
  if (branch.kind === "hidden") return null;
  return (
    <>
      {SEPARATOR}
      <span
        data-component="BranchSelector"
        data-branch-load={branch.kind}
        className="flex min-w-0 items-center gap-1.5"
      >
        {branch.kind === "selected" ? (
          <>
            <span className="text-muted hidden font-normal sm:inline">from</span>
            <GitBranch aria-hidden className="text-muted size-3 shrink-0 sm:hidden" />
            <span className="min-w-0 truncate font-mono text-xs">{branch.name}</span>
          </>
        ) : branch.kind === "failed" ? (
          <span className="text-error min-w-0 truncate">Could not load branches</span>
        ) : (
          <>
            <span className="sr-only">Loading branches</span>
            <Skeleton className="h-3 w-12 rounded" />
          </>
        )}
      </span>
    </>
  );
}

/** The UI of the selected option on one axis, for the chip's icon and colour. */
function selectedOptionUi<T extends string>(
  options: Array<IsolationSelectOption<T>>,
  value: T
): IsolationOptionUi | undefined {
  return options.find((option) => option.value === value)?.ui;
}

/** The closed state: the selection as one line, or the field Send is waiting for. */
function ChipSummary(props: {
  summary: EnvironmentSummary;
  projectUi: IsolationOptionUi | undefined;
  workspaceUi: IsolationOptionUi | undefined;
}) {
  const { summary, projectUi } = props;
  const ProjectIcon = projectUi?.Icon;
  return (
    <>
      <span className="sr-only">Environment:</span>
      {summary.error !== null ? (
        <span className="text-error flex min-w-0 items-center gap-1.5">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{summary.error}</span>
        </span>
      ) : (
        <span
          data-component="ProjectIsolationSummary"
          className="text-foreground flex min-w-0 items-center gap-2"
        >
          {ProjectIcon && (
            <span aria-hidden className={cn("flex shrink-0", projectUi?.iconClass)}>
              <ProjectIcon size={14} />
            </span>
          )}
          <span className="min-w-0 truncate">{summary.where}</span>
        </span>
      )}
      {SEPARATOR}
      {/* Usually a short word; with SSH and no isolation it is the shared directory, so it can
          truncate like the host and the branch. */}
      <span
        data-component="WorkspaceIsolationSummary"
        className={cn("min-w-0 truncate", props.workspaceUi?.iconClass ?? "text-foreground")}
      >
        {summary.isolation}
      </span>
      <ChipBranch branch={summary.branch} />
      <ChevronDown aria-hidden className="text-muted ml-auto size-3.5 shrink-0" />
    </>
  );
}

/** Three columns on desktop, stacked on a phone. Literal classes: Tailwind only finds literals. */
function columnsClass(props: Pick<CreationEnvironmentPanelProps, "branch" | "isolation">): string {
  if (props.branch === null) return "md:grid-cols-2";
  // Coder's workspace form is wider than a plain option list.
  return props.isolation.project === "coder"
    ? "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]"
    : "md:grid-cols-[minmax(0,27fr)_minmax(0,29fr)_minmax(0,34fr)]";
}

/**
 * The creation page's environment: one chip that reads as the selection ("Local · Worktree · from
 * main") and opens one panel holding where it runs, the isolation and the base branch side by
 * side. It replaces a row of three separate selects, so the choices that depend on each other are
 * seen and changed together, and the reason an option is unavailable is shown in full.
 */
export function CreationEnvironmentPanel(props: CreationEnvironmentPanelProps) {
  const [open, setOpen] = useState(false);
  // Each Send refused for an empty required field opens the panel on that field. The fields live
  // in the panel, so a closed panel would hide what Send is waiting for. Keyed on the attempt, not
  // on the error: the error is the same for a second refused send. Adjusted during render (not in
  // an effect): it is state derived from a prop change.
  const [seenAttempt, setSeenAttempt] = useState(props.fieldErrorAttempt);
  if (props.fieldErrorAttempt !== seenAttempt) {
    setSeenAttempt(props.fieldErrorAttempt);
    if (props.fieldError !== null) setOpen(true);
  }
  const contentRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();

  useCreationShortcut(!props.disabled && !open, KEYBINDS.OPEN_CREATION_ENVIRONMENT, () =>
    setOpen(true)
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (props.footerShortcut && matchesKeybind(event, props.footerShortcut.keybind)) {
      event.preventDefault();
      props.footerShortcut.run();
      return;
    }
    const next = environmentArrowTarget(
      event.target as HTMLElement,
      event.currentTarget,
      event.key
    );
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <Tooltip>
        {/* Hover only. Radix also opens a tooltip on focus, and closing the panel returns focus to
            the chip: the tooltip then sat on top of the project heading, which could not be
            clicked, and on a phone it showed the keyboard shortcut. Cancelling the focus event
            keeps the focus return and skips the tooltip. */}
        <TooltipTrigger asChild onFocus={(event) => event.preventDefault()}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="creation-environment"
              // The tutorial's base-branch step points here. On the chip, not on its branch
              // segment: the segment is hidden for runtimes with no base branch, and a step with
              // no target shows only its backdrop.
              data-tutorial="trunk-branch"
              aria-haspopup="dialog"
              aria-keyshortcuts={formatKeybindForAria(KEYBINDS.OPEN_CREATION_ENVIRONMENT)}
              disabled={props.disabled}
              className={cn(
                // A phone gets a full-width, thumb-sized chip; the desktop chip is as wide as its text.
                "bg-background-secondary hover:bg-hover focus-visible:ring-accent flex h-8 max-w-full min-w-0 items-center gap-2 rounded-[7px] border px-2.5 text-[13px] font-medium outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50 [@media(max-width:768px)_and_(pointer:coarse)]:h-11 [@media(max-width:768px)_and_(pointer:coarse)]:w-full",
                props.summary.error !== null ? "border-error" : "border-border-medium",
                open && "bg-hover"
              )}
            >
              <ChipSummary
                summary={props.summary}
                projectUi={selectedOptionUi(props.projectOptions, props.isolation.project)}
                workspaceUi={selectedOptionUi(props.workspaceOptions, props.isolation.workspace)}
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-72">
          {props.description} ({formatKeybind(KEYBINDS.OPEN_CREATION_ENVIRONMENT)})
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        {...MODAL_POPOVER_CONTENT_PROPS}
        ref={contentRef}
        align="start"
        // Keeps the same gap to both screen edges on a phone, where the panel is as wide as the
        // viewport allows and would otherwise start at the chip and end flush with the edge.
        collisionPadding={8}
        aria-label="Environment"
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          handleKeyDown(event);
          MODAL_POPOVER_CONTENT_PROPS.onKeyDown(event);
        }}
        // Wide enough for three columns on desktop; on a phone it spans the viewport and the
        // columns stack, scrolling inside the space the popover has.
        className="flex max-h-(--radix-popover-content-available-height) w-[min(56.25rem,calc(100vw-1rem))] flex-col overflow-y-auto rounded-[10px] p-0 shadow-xl"
        onOpenAutoFocus={(event) => {
          const target = environmentOpenFocusTarget(contentRef.current);
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {/* Arrow keys move between the rows inside; the rows themselves are the controls. */}
        <div role="presentation" className={cn("grid grid-cols-1", columnsClass(props))}>
          <OptionColumn
            title="Run on"
            ariaLabel="Project isolation"
            value={props.isolation.project}
            options={props.projectOptions}
            onChange={(project) =>
              props.onSelectIsolation({ project, workspace: props.isolation.workspace })
            }
            disabled={props.disabled}
            fields={props.projectFields}
          />
          <OptionColumn
            title="Isolation"
            ariaLabel="Workspace isolation"
            value={props.isolation.workspace}
            options={props.workspaceOptions}
            onChange={(workspace) =>
              props.onSelectIsolation({ project: props.isolation.project, workspace })
            }
            disabled={props.disabled}
            fields={props.workspaceFields}
            className="border-border-light border-t md:border-t-0 md:border-l"
          />
          {props.branch !== null && (
            <BranchColumn
              branch={props.branch}
              disabled={props.disabled}
              className="border-border-light border-t md:border-t-0 md:border-l"
            />
          )}
        </div>
        <div className="border-border-light flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3.5 py-2.5">
          <span id={descriptionId} className="text-muted min-w-0 flex-1 basis-48 text-xs">
            {props.description}
          </span>
          {props.footerAction}
          {/* The panel's one primary action, so it is the light button: every pick applies at
              once and Done only closes. */}
          <Button
            size="xs"
            className="bg-foreground text-background hover:bg-foreground/90 h-7 px-3 text-xs font-medium"
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
