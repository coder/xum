import { useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitBranch,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import { FilterList } from "@/browser/components/FilterList/FilterList";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import type { IsolationOptionUi } from "@/browser/utils/runtimeUi";
import { formatKeybind, formatKeybindForAria, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type {
  IsolationChoice,
  ProjectIsolation,
  WorkspaceIsolation,
} from "@/common/types/isolation";
import type { BranchLoadStatus } from "./branchListLoad";
import type { EnvironmentSummary, RuntimeFieldError } from "./creationEnvironmentSummary";
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
  /** Trust of the SSH+None directory, or null when it does not apply. */
  directoryTrusted: boolean | null;
}

const COLUMN_SELECTOR = "[data-environment-column]";
const ROW_SELECTOR = '[role="radio"]:not(:disabled)';

/** The row an Up/Down key moves to within a column; null from anything but a row. */
function verticalTarget(target: HTMLElement, column: HTMLElement, key: string): HTMLElement | null {
  // Inputs keep their own arrows (the branch filter moves its active row).
  if (target.getAttribute("role") !== "radio") return null;
  const rows = Array.from(column.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const next = rows.indexOf(target) + (key === "ArrowDown" ? 1 : -1);
  return rows[(next + rows.length) % rows.length] ?? null;
}

/** The control a Left/Right key moves to in the neighbouring column. */
function horizontalTarget(
  target: HTMLElement,
  column: HTMLElement,
  panel: HTMLElement,
  key: string
): HTMLElement | null {
  // Left/Right move the caret while a field has text; they change column only from an empty one.
  if (target instanceof HTMLInputElement && target.value !== "") return null;
  const columns = Array.from(panel.querySelectorAll<HTMLElement>(COLUMN_SELECTOR));
  const neighbor = columns[columns.indexOf(column) + (key === "ArrowRight" ? 1 : -1)];
  if (!neighbor) return null;
  return (
    neighbor.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not(:disabled)') ??
    neighbor.querySelector<HTMLElement>(`${ROW_SELECTOR}, [role="combobox"]`)
  );
}

/** Where an arrow key moves focus inside the panel, or null when the key is not the panel's. */
export function environmentArrowTarget(
  target: HTMLElement,
  panel: HTMLElement,
  key: string
): HTMLElement | null {
  const column = target.closest<HTMLElement>(COLUMN_SELECTOR);
  if (!column) return null;
  if (key === "ArrowUp" || key === "ArrowDown") return verticalTarget(target, column, key);
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return horizontalTarget(target, column, panel, key);
  }
  return null;
}

const COLUMN_TITLE_CLASSES = "text-muted text-[11px] font-medium tracking-wide uppercase";

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
    <div data-environment-column className={cn("flex min-w-0 flex-col p-1.5", props.className)}>
      <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
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
                onClick={() => props.onChange(option.value)}
                className={cn(
                  "focus-visible:ring-accent flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left outline-none focus-visible:ring-1",
                  checked ? "bg-hover" : "hover:bg-hover/60",
                  props.disabled && "opacity-50"
                )}
              >
                <Icon
                  size={14}
                  className={cn(
                    "mt-0.5 shrink-0",
                    unavailable ? "text-muted" : option.ui.iconClass
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={cn(
                      "text-xs font-medium",
                      unavailable ? "text-muted" : "text-foreground"
                    )}
                  >
                    {option.ui.label}
                  </span>
                  <span className="text-muted text-[11px] leading-snug">
                    {option.ui.description}
                  </span>
                  {/* The whole reason, wrapped: the old select cut it off after two lines. */}
                  {unavailable && (
                    <span className="text-warning-text text-[11px] leading-snug break-words">
                      {option.disabledReason}
                    </span>
                  )}
                </span>
                {checked && (
                  <Check aria-hidden className="text-foreground mt-0.5 size-3.5 shrink-0" />
                )}
              </button>
              {checked && props.fields != null && (
                <div className="flex flex-col gap-2 py-1.5 pr-2 pl-[1.875rem]">{props.fields}</div>
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
    <div data-environment-column className={cn("flex min-w-0 flex-col p-1.5", props.className)}>
      <span className={cn(COLUMN_TITLE_CLASSES, "px-2 pt-1.5 pb-1")}>Base branch</span>
      {branch.load === "loading" ? (
        <div className="flex flex-col gap-2.5 px-2 py-2" aria-busy role="status">
          <span className="sr-only">Loading branches</span>
          <Skeleton className="h-3 w-3/5 rounded" />
          <Skeleton className="h-3 w-4/5 rounded" />
          <Skeleton className="h-3 w-2/5 rounded" />
        </div>
      ) : branch.load === "failed" ? (
        <span className="text-error px-2 py-2 text-xs" role="status">
          Could not load branches
        </span>
      ) : (
        <FilterList
          items={branch.options.map((name) => ({ value: name, label: name }))}
          selected={branch.selected}
          onSelect={branch.onSelect}
          label="Select source branch"
          placeholder="Filter branches…"
          noun="branches"
          mono
          disabled={props.disabled}
          listClassName="max-h-56"
        />
      )}
    </div>
  );
}

const SEPARATOR = (
  <span aria-hidden className="text-muted shrink-0">
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
        // The tutorial points at the base branch; it lives in the chip while the panel is closed.
        data-tutorial="trunk-branch"
        data-component="BranchSelector"
        data-branch-load={branch.kind}
        className="flex min-w-0 items-center gap-1.5"
      >
        {branch.kind === "selected" ? (
          <>
            <span className="text-muted hidden font-normal sm:inline">from</span>
            <GitBranch aria-hidden className="text-muted size-3 shrink-0 sm:hidden" />
            <span className="min-w-0 truncate font-mono">{branch.name}</span>
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

/** The closed state: the selection as one line, or the field Send is waiting for. */
function ChipSummary(props: {
  summary: EnvironmentSummary;
  projectUi: IsolationOptionUi | undefined;
  workspaceUi: IsolationOptionUi | undefined;
  directoryTrusted: boolean | null;
}) {
  const { summary, projectUi } = props;
  const ProjectIcon = projectUi?.Icon;
  const TrustIcon = props.directoryTrusted === true ? ShieldCheck : ShieldAlert;
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
          className="text-foreground flex min-w-0 items-center gap-1.5"
        >
          {ProjectIcon && (
            <ProjectIcon size={12} className={cn("shrink-0", projectUi?.iconClass)} />
          )}
          <span className="min-w-0 truncate">{summary.where}</span>
        </span>
      )}
      {SEPARATOR}
      {/* The isolation keeps its width before the host and branch do: it changes most. */}
      <span
        data-component="WorkspaceIsolationSummary"
        className={cn(
          "max-w-[40%] shrink-0 truncate",
          props.workspaceUi?.iconClass ?? "text-foreground"
        )}
      >
        {summary.isolation}
      </span>
      {props.directoryTrusted !== null && (
        <TrustIcon
          role="img"
          aria-label={props.directoryTrusted ? "Trusted directory" : "Untrusted directory"}
          className={cn(
            "size-3.5 shrink-0",
            props.directoryTrusted ? "text-success-text" : "text-warning-text"
          )}
        />
      )}
      <ChipBranch branch={summary.branch} />
      <ChevronDown aria-hidden className="text-muted size-3.5 shrink-0" />
    </>
  );
}

/** Three columns on desktop, stacked on a phone. Literal classes: Tailwind only finds literals. */
function columnsClass(props: Pick<CreationEnvironmentPanelProps, "branch" | "isolation">): string {
  if (props.branch === null) return "md:grid-cols-2";
  // Coder's workspace form is wider than a plain option list.
  return props.isolation.project === "coder"
    ? "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]"
    : "md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(0,1fr)]";
}

/**
 * The creation page's environment: one chip that reads as the selection ("Local · Worktree · from
 * main") and opens one panel holding where it runs, the isolation and the base branch side by
 * side. It replaces a row of three separate selects, so the choices that depend on each other are
 * seen and changed together, and the reason an option is unavailable is shown in full.
 */
export function CreationEnvironmentPanel(props: CreationEnvironmentPanelProps) {
  const [open, setOpen] = useState(false);
  // A Send refused for an empty required field opens the panel on that field. The fields live in
  // the panel, so a closed panel would hide what Send is waiting for. Adjusted during render
  // (not in an effect): it is state derived from a prop change.
  const [seenFieldError, setSeenFieldError] = useState(props.fieldError);
  if (props.fieldError !== seenFieldError) {
    setSeenFieldError(props.fieldError);
    if (props.fieldError !== null) setOpen(true);
  }
  const contentRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();

  useCreationShortcut(!props.disabled && !open, KEYBINDS.OPEN_CREATION_ENVIRONMENT, () =>
    setOpen(true)
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
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
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="creation-environment"
              aria-haspopup="dialog"
              aria-keyshortcuts={formatKeybindForAria(KEYBINDS.OPEN_CREATION_ENVIRONMENT)}
              disabled={props.disabled}
              className={cn(
                "bg-background-secondary hover:bg-hover focus-visible:ring-accent flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50",
                props.summary.error !== null ? "border-error" : "border-border-medium",
                open && "bg-hover"
              )}
            >
              <ChipSummary
                summary={props.summary}
                projectUi={
                  props.projectOptions.find((option) => option.value === props.isolation.project)
                    ?.ui
                }
                workspaceUi={
                  props.workspaceOptions.find(
                    (option) => option.value === props.isolation.workspace
                  )?.ui
                }
                directoryTrusted={props.directoryTrusted}
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {/* Hover only, so phones never show the shortcut. */}
        <TooltipContent align="start" className="max-w-72">
          {props.description} ({formatKeybind(KEYBINDS.OPEN_CREATION_ENVIRONMENT)})
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        align="start"
        aria-label="Environment"
        aria-describedby={descriptionId}
        // Wide enough for three columns on desktop; on a phone it spans the viewport and the
        // columns stack, scrolling inside the space the popover has.
        className="flex max-h-(--radix-popover-content-available-height) w-[min(54rem,calc(100vw-1rem))] flex-col overflow-y-auto p-0"
        onOpenAutoFocus={(event) => {
          // Land on the field Send is waiting for, else on the selected "Run on" row.
          const target =
            contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
            contentRef.current?.querySelector<HTMLElement>(
              '[role="radio"][aria-checked="true"]:not(:disabled)'
            );
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {/* Arrow keys move between the rows inside; the rows themselves are the controls. */}
        <div
          role="presentation"
          onKeyDown={handleKeyDown}
          className={cn("grid grid-cols-1", columnsClass(props))}
        >
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
        <div className="border-border-light flex shrink-0 items-center gap-3 border-t px-3 py-2">
          <span id={descriptionId} className="text-muted min-w-0 flex-1 text-xs">
            {props.description}
          </span>
          <Button variant="secondary" size="xs" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
